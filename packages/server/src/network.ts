import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

/** Public unicast addresses only: private, loopback, link-local, CGNAT and documentation ranges are refused. */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Conservative: native IPv6 global unicast only.
  return family === 6 && /^[23][a-f0-9]{3}:/i.test(address)
    && !(address.toLowerCase().startsWith("2001:") && parseInt(address.split(":")[1] || "0", 16) < 0x200)
    && !/^2001:db8:/i.test(address) && !/^2002:/i.test(address);
}

/** Services the server always needs: GitHub for GitHub books (its API, and github.com for the device authorization of the server's own connection) and npm for update checks. */
const BUILT_IN_ORIGINS = new Set(["https://api.github.com", "https://github.com", "https://registry.npmjs.org"]);
export const isBuiltInOutboundOrigin = (url: URL): boolean => BUILT_IN_ORIGINS.has(url.origin);

export class OutboundNetworkError extends Error {
  constructor(message: string, readonly code: "not_approved" | "private_address" | "redirect" | "unsupported_body" | "connection", options?: ErrorOptions) {
    super(message, options);
    this.name = "OutboundNetworkError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface OutboundNetworkOptions {
  /** How a host name becomes addresses (tests; default: the system's DNS). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** The environment whose proxy variables apply (tests; default: the process's, read at each request). */
  env?: NodeJS.ProcessEnv;
  /** Certificate authorities that replace the system's for the destinations (tests; `NODE_EXTRA_CA_CERTS` works as for any program). */
  ca?: ConnectionOptions["ca"];
  /** How long a name may take to resolve when a proxy is going to resolve it as well (tests; default 3 seconds). */
  lookupTimeoutMs?: number;
  /** How long a connection may take to be made, the tunnel through a proxy and its TLS handshake included (tests; default `DEFAULT_CONNECT_TIMEOUT_MS`). It limits the connection and nothing after it. */
  connectTimeoutMs?: number;
}

/** Headers that say how a message is framed or where it goes: the guard writes them itself from the URL and the body. */
const CALLER_CANNOT_SET = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-connection"];
/**
 * How long a connection may take to be established, in milliseconds. The wait for an answer is not limited here at all: a model that is slow to
 * begin, or silent for minutes in the middle of a reply, is the AI client's to cut, with its own deadlines (the engine's "Timeouts and streaming":
 * the start deadline, which the connection is part of, is never under 30 s). Node's own `fetch` has two limits of its own, 300 s each, that this one
 * does not have: this is why the server's calls to AI providers are made with it.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const PROXIED_LOOKUP_MS = 3_000;

const isLoopbackHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const proxyVariable = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name.toLowerCase()]?.trim() || env[name.toUpperCase()]?.trim() || undefined;

/** `NO_PROXY`: `*`, hosts and domains (`example.com`, `.example.com`, `*.example.com` cover the domain and what is under it), each with an optional port. */
function excludedFromProxy(hostname: string, port: string, noProxy: string | undefined): boolean {
  for (const raw of (noProxy ?? "").toLowerCase().split(/[\s,]+/)) {
    if (raw === "*") return true;
    const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(raw);
    const host = (match?.[1] ?? match?.[2] ?? "").replace(/^\*?\./, "");
    if (!host || (match?.[3] && match[3] !== port)) continue;
    if (hostname === host || (!isIP(hostname) && hostname.endsWith(`.${host}`))) return true;
  }
  return false;
}

/**
 * The proxy a request to `url` goes through: the one `HTTPS_PROXY` names (the variable npm and git are given as well), unless
 * `NO_PROXY` keeps the destination out. Only an `http://` proxy (a bare `host:port` is one) can be used here: any other value leaves
 * the request as it always was, direct. This computer's own addresses are never proxied (an approved local model runs here).
 */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (url.protocol !== "https:") return undefined;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const configured = proxyVariable(env, "https_proxy");
  if (isLoopbackHost(hostname) || !configured || excludedFromProxy(hostname, url.port || "443", proxyVariable(env, "no_proxy"))) return undefined;
  try {
    const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`);
    return proxy.protocol === "http:" && proxy.hostname ? proxy : undefined;
  } catch {
    return undefined;
  }
}

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * A TLS connection to `url`'s origin through `proxy`: CONNECT, then the handshake with the origin itself inside the tunnel (so
 * the proxy carries encrypted bytes and the origin's certificate is verified as it is without a proxy). Its failures say why in a few
 * words and never repeat an address or a credential.
 */
function openTunnel(proxy: URL, url: URL, hostname: string, ca: ConnectionOptions["ca"], signal: AbortSignal | undefined, connectTimeoutMs: number): Promise<TLSSocket> {
  return new Promise((accept, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const authority = `${url.hostname}:${url.port || "443"}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.username || proxy.password) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decoded(proxy.username)}:${decoded(proxy.password)}`).toString("base64")}`;
    const parts: { request?: ClientRequest; socket?: Duplex; secure?: TLSSocket } = {};
    let finished = false;
    const finish = (failure?: Error, secure?: TLSSocket) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure || !secure) {
        parts.request?.destroy();
        parts.socket?.destroy();
        parts.secure?.destroy();
        reject(failure ?? new Error("failed"));
      } else {
        accept(secure);
      }
    };
    const because = (error: unknown) => new Error((error as NodeJS.ErrnoException).code ?? "failed", { cause: error });
    const onAbort = () => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(new Error("it took too long")), connectTimeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const request = httpRequest({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: proxy.port || 80, method: "CONNECT", path: authority, headers, agent: false });
    parts.request = request;
    request.once("connect", (response, socket, head) => {
      parts.socket = socket;
      socket.on("error", () => undefined);
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 299) {
        finish(new Error(`the proxy answered ${status}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = tlsConnect({ socket, host: hostname, ...(isIP(hostname) ? {} : { servername: hostname }), ...(ca ? { ca } : {}) });
      parts.secure = secure;
      secure.once("secureConnect", () => finish(undefined, secure));
      secure.on("error", (error) => finish(because(error)));
    });
    request.on("error", (error) => finish(because(error)));
    request.end();
  });
}

/**
 * The `lookup` of a connection to a host whose addresses were already resolved and checked: it answers with those and with nothing
 * else (no second DNS query to race), and with all of them when the connection asks for all, so that it can try the next one when
 * the first is out of reach (an IPv6 address on a network without IPv6, a local server that listens on one loopback only).
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (error: Error | null, address?: string | ResolvedAddress[], family?: number) => void;
    const options = (typeof optionsOrCallback === "object" && optionsOrCallback !== null ? optionsOrCallback : {}) as { all?: boolean; family?: number | string };
    const wanted = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const usable = addresses.filter((entry) => !wanted || entry.family === wanted).map(({ address, family }) => ({ address, family }));
    if (!usable.length) {
      callback(Object.assign(new Error("No address of the verified ones fits."), { code: "ENOTFOUND" }));
      return;
    }
    if (options.all) callback(null, usable);
    else callback(null, usable[0].address, usable[0].family);
  };
}

/** What a request body becomes: bytes, and the content type that goes with it. Streams and forms are not buffered here. */
async function bodyBytes(body: unknown): Promise<{ bytes?: Buffer; type?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { bytes: Buffer.from(body, "utf8") };
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body) };
  if (ArrayBuffer.isView(body)) return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  if (body instanceof URLSearchParams) return { bytes: Buffer.from(body.toString(), "utf8"), type: "application/x-www-form-urlencoded;charset=UTF-8" };
  if (body instanceof Blob) return { bytes: Buffer.from(await body.arrayBuffer()), ...(body.type ? { type: body.type } : {}) };
  throw new OutboundNetworkError("Unsupported request body.", "unsupported_body");
}

/**
 * Replace `fetch` inside the server process: only approved AI endpoints (plus GitHub and npm) are
 * reachable, DNS is resolved once and pinned in the connection (no DNS-rebinding race), private
 * addresses are refused except an approved loopback endpoint (a local model), redirects are never followed
 * (`redirect: "manual"` gets the 3xx answer itself, anything else is refused). Only the connection is limited in time
 * (`connectTimeoutMs`); once it is up, an answer takes as long as the caller lets it take (the caller's `signal` ends it at once).
 */
export function installOutboundNetwork(approvedBases: () => string[], options: OutboundNetworkOptions = {}): () => void {
  const original = globalThis.fetch;
  const connectTimeoutMs = typeof options.connectTimeoutMs === "number" && options.connectTimeoutMs > 0 ? Math.min(options.connectTimeoutMs, 2_147_483_647) : DEFAULT_CONNECT_TIMEOUT_MS;
  const resolve = options.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  /** The addresses of a name that a proxy will resolve as well: whatever this computer can learn in a moment, or nothing. */
  const resolveForProxy = async (hostname: string): Promise<ResolvedAddress[] | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([resolve(hostname), new Promise<undefined>((accept) => {
        timer = setTimeout(() => accept(undefined), options.lookupTimeoutMs ?? PROXIED_LOOKUP_MS);
      })]);
      return answer?.length ? answer : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  globalThis.fetch = async (input, init = {}) => {
    const source = input instanceof Request ? input : undefined;
    const url = new URL(source ? source.url : typeof input === "string" || input instanceof URL ? input : (input as { url: string }).url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const configured = approvedBases().some((base) => {
      try {
        return new URL(base).origin === url.origin;
      } catch {
        return false;
      }
    });
    const fixed = isBuiltInOutboundOrigin(url);
    const loopback = isLoopbackHost(hostname);
    if (url.username || url.password || (!configured && !fixed) || (url.protocol !== "https:" && !(configured && loopback && url.protocol === "http:"))) {
      throw new OutboundNetworkError(`The server owner has not approved ${url.origin}. Approve it in the admin panel (Approved network).`, "not_approved");
    }
    const proxy = proxyFor(url, options.env);
    // Every address the connection may use is checked here: one that is not public makes the whole answer unusable. A name that
    // this computer cannot resolve (a network that only has a proxy) is left to the proxy: there is nothing to check, and nothing to pin.
    const addresses: ResolvedAddress[] | undefined = hostname === "localhost"
      ? [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]
      : loopback
        ? [{ address: hostname, family: isIP(hostname) }]
        : isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : proxy
            ? await resolveForProxy(hostname)
            : await resolve(hostname);
    if (addresses ? !addresses.length || (!loopback && addresses.some((entry) => !publicAddress(entry.address))) : !proxy) {
      throw new OutboundNetworkError(`${url.origin} resolves to a private or unverifiable address.`, "private_address");
    }
    // What the caller asked for: the Request's own method, headers, body, redirect mode and signal, and over them `init`.
    const method = (init.method ?? source?.method ?? "GET").toUpperCase();
    const redirect = init.redirect ?? source?.redirect ?? "follow";
    const signal = init.signal ?? source?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted.", "AbortError");
    const headers = new Headers(init.headers ?? source?.headers);
    for (const name of CALLER_CANNOT_SET) headers.delete(name);
    const { bytes, type } = await bodyBytes(init.body !== undefined ? init.body : source?.body ? await source.arrayBuffer() : undefined);
    if (bytes && (method === "GET" || method === "HEAD")) throw new TypeError("Request with GET/HEAD method cannot have body.");
    if (type && !headers.has("content-type")) headers.set("content-type", type);
    if (bytes) headers.set("content-length", String(bytes.length));
    return new Promise<Response>((accept, reject) => {
      // Through a proxy the connection is the tunnel made for this request (its TLS handshake included); without one it is a
      // connection to the addresses that were verified above, and to nothing else.
      const connection = proxy
        ? {
          defaultPort: 443,
          createConnection: ((_options: unknown, callback: (failure: Error | null, socket?: Duplex) => void) => {
            openTunnel(proxy, url, hostname, options.ca, signal, connectTimeoutMs).then((socket) => callback(null, socket), (failure: Error) => callback(failure));
          }) as never,
        }
        : { lookup: pinnedLookup(addresses ?? []) as never, ...(url.protocol === "https:" && options.ca ? { ca: options.ca } : {}) };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method,
        headers: Object.fromEntries(headers),
        signal,
        timeout: connectTimeoutMs,
        ...connection,
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || name === "set-cookie") continue;
          for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, entry);
        }
        const status = incoming.statusCode ?? 500;
        // A redirect is never followed, and never carries a credential anywhere, even on the built-in services. A caller that
        // asked for "manual" gets the answer itself and may look at where it points.
        if (status >= 300 && status < 400 && status !== 304 && redirect !== "manual") {
          incoming.destroy();
          reject(new OutboundNetworkError("Network redirects are not allowed.", "redirect"));
          return;
        }
        const stream = [204, 205, 304].includes(status) || method === "HEAD" ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (!stream) incoming.resume();
        accept(new Response(stream, { status, statusText: incoming.statusMessage ?? "", headers: responseHeaders }));
      });
      // The timeout above covers the connection only: once it is up, a slow answer is the caller's to cut short.
      let connected = false;
      request.on("socket", (socket) => {
        const up = () => {
          connected = true;
          request.setTimeout(0);
        };
        if (!socket.connecting) up();
        else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", up);
      });
      request.on("timeout", () => {
        if (!connected) request.destroy(new Error("The connection timed out."));
      });
      // Not `once`: a tunnel that fails after the request was cancelled reports once more, and nobody listening would end the process.
      request.on("error", (error) => reject(signal?.aborted
        ? (signal.reason ?? new DOMException("Aborted.", "AbortError"))
        : new OutboundNetworkError(proxy ? `Could not connect to ${url.origin} through the proxy named by HTTPS_PROXY (${error.message}).` : `Could not connect to ${url.origin}.`, "connection", { cause: error })));
      request.end(bytes);
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
