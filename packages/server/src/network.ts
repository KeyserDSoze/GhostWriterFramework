import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

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

/** Services the server always needs: GitHub for GitHub books and npm for update checks. */
const BUILT_IN_ORIGINS = new Set(["https://api.github.com", "https://registry.npmjs.org"]);
export const isBuiltInOutboundOrigin = (url: URL): boolean => BUILT_IN_ORIGINS.has(url.origin);

export class OutboundNetworkError extends Error {
  constructor(message: string, readonly code: "not_approved" | "private_address" | "redirect" | "unsupported_body" | "connection", options?: ErrorOptions) {
    super(message, options);
    this.name = "OutboundNetworkError";
  }
}

/**
 * Replace `fetch` inside the server process: only approved AI endpoints (plus GitHub and npm) are
 * reachable, DNS is resolved once and pinned in the connection (no DNS-rebinding race), private
 * addresses are refused except an approved loopback endpoint (a local model), redirects are refused.
 */
export function installOutboundNetwork(approvedBases: () => string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const configured = approvedBases().some((base) => {
      try {
        return new URL(base).origin === url.origin;
      } catch {
        return false;
      }
    });
    const fixed = isBuiltInOutboundOrigin(url);
    const loopback = hostname === "localhost" || hostname === "127.0.0.1";
    if (url.username || url.password || (!configured && !fixed) || (url.protocol !== "https:" && !(configured && loopback && url.protocol === "http:"))) {
      throw new OutboundNetworkError(`The server owner has not approved ${url.origin}. Approve it in the admin panel (Approved network).`, "not_approved");
    }
    const addresses = loopback
      ? [{ address: "127.0.0.1", family: 4 }]
      : isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || (!loopback && addresses.some((entry) => !publicAddress(entry.address)))) {
      throw new OutboundNetworkError(`${url.origin} resolves to a private or unverifiable address.`, "private_address");
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted.", "AbortError");
    const destination = addresses[0];
    const headers = new Headers(init.headers);
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
      throw new OutboundNetworkError("Unsupported request body.", "unsupported_body");
    }
    return new Promise<Response>((accept, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers),
        signal: init.signal ?? undefined,
        lookup: (_host, options, callback) => {
          if (typeof options === "object" && options.all) callback(null, [destination] as never, 0);
          else callback(null, destination.address, destination.family);
        },
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || name === "set-cookie") continue;
          for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, entry);
        }
        const status = incoming.statusCode ?? 500;
        // A redirect never carries a credential anywhere, even on the built-in services.
        if (status >= 300 && status < 400 && status !== 304) {
          incoming.destroy();
          reject(new OutboundNetworkError("Network redirects are not allowed.", "redirect"));
          return;
        }
        const stream = [204, 205, 304].includes(status) || init.method === "HEAD" ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (!stream) incoming.resume();
        accept(new Response(stream, { status, statusText: incoming.statusMessage ?? "", headers: responseHeaders }));
      });
      request.once("error", (error) => reject(init.signal?.aborted ? (init.signal.reason ?? new DOMException("Aborted.", "AbortError")) : new OutboundNetworkError(`Could not connect to ${url.origin}.`, "connection", { cause: error })));
      if (body) request.write(body);
      request.end();
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
