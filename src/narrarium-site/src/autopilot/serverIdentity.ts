import { NarrariumServerClient, ServerRequestError, type ServerInfo } from "narrarium-engine";
import { ServerAddressError, validateServerAddress } from "@/autopilot/serverAddress";
import { useSettingsStore } from "@/store/settingsStore";
import type { PersonalServerSettings } from "@/types/settings";

export type ServerIdentityFailure = "changed" | "invalid" | "unpinned" | "unsupported";

const IDENTITY_MESSAGES: Record<ServerIdentityFailure, string> = {
  changed: "The personal server's identity changed.",
  invalid: "The personal server could not prove its identity.",
  unpinned: "This personal server has not been verified yet: test the connection first.",
  unsupported: "This browser cannot verify the personal server's signature.",
};

/**
 * Nothing secret is sent to the server at the configured address: it is not the one this device
 * paired with, cannot prove who it is, was never verified, or this browser cannot check its signature.
 */
export class ServerIdentityError extends Error {
  constructor(readonly reason: ServerIdentityFailure) {
    super(IDENTITY_MESSAGES[reason]);
    this.name = "ServerIdentityError";
  }
}

export interface VerifiedServerInfo {
  info: ServerInfo;
  fingerprint: string;
  /** The server signed a fresh nonce and this browser checked the signature; `false`: only its (public) fingerprint could be compared. */
  verified: boolean;
}

/**
 * Ask the server to sign a fresh nonce, check the signature and compare its key with the pinned
 * fingerprint. Only `verified === true` proves who answered: refuse anything else before sending a secret.
 */
export async function verifiedServerInfo(client: NarrariumServerClient, pinnedFingerprint?: string): Promise<VerifiedServerInfo> {
  let checked: Awaited<ReturnType<NarrariumServerClient["verifiedInfo"]>>;
  try {
    checked = await client.verifiedInfo();
  } catch (error) {
    if (error instanceof ServerRequestError) throw error;
    throw new ServerIdentityError("invalid");
  }
  if (pinnedFingerprint && checked.identity.fingerprint !== pinnedFingerprint) throw new ServerIdentityError("changed");
  return { info: checked.info, fingerprint: checked.identity.fingerprint, verified: checked.identity.verified === true };
}

const VERIFIED_FOR_MS = 60_000;
const verifiedServers = new Map<string, { until: number; info: ServerInfo }>();

const cacheKey = (url: string, fingerprint: string) => `${url}\n${fingerprint}`;

/** Forget every cached verification: the next call asks the server to prove its identity again. */
export function forgetServerVerification(): void {
  verifiedServers.clear();
}

export interface ServerCallOptions {
  /** Cancels the identity check and every request of the client that is returned. */
  signal?: AbortSignal;
  /** Only for tests: the `fetch` the requests go through. */
  fetch?: typeof fetch;
}

/** One signal that aborts when any of `signals` does (`AbortSignal.any`, missing in some browsers that already have Ed25519). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const joined = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      joined.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => joined.abort(signal.reason), { once: true });
  }
  return joined.signal;
}

/** The request init with `extra` aborting it too. */
function withSignal(init: RequestInit | undefined, extra: AbortSignal | undefined): RequestInit | undefined {
  const own = init?.signal ?? undefined;
  if (!extra || own === extra) return init;
  return { ...init, signal: own ? anySignal([own, extra]) : extra };
}

/** `fetch` that honors an extra signal and drops the cached verification when a request fails. */
function guardedFetch(options: ServerCallOptions, key: string | null): typeof fetch {
  const base = options.fetch ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const effective = withSignal(init, options.signal);
    try {
      const response = await base(input, effective);
      if (!response.ok && key) verifiedServers.delete(key);
      return response;
    } catch (error) {
      if (key && !effective?.signal?.aborted) verifiedServers.delete(key);
      throw error;
    }
  };
}

/**
 * Check the identity of the server at `url` without sending any secret: it must sign a fresh nonce
 * (verified by this browser) and, when a fingerprint is pinned, have exactly that key. Use it to pin
 * a server the first time, and to pair. A successful check is remembered for 60 seconds.
 */
export async function probeServerIdentity(url: string, pinnedFingerprint?: string, options: ServerCallOptions = {}): Promise<{ info: ServerInfo; fingerprint: string }> {
  const address = validateServerAddress(url);
  if (address.ok === false) throw new ServerAddressError(address.reason);
  const probe = new NarrariumServerClient({ baseUrl: address.url, token: "", fetch: guardedFetch(options, null) });
  const { info, fingerprint, verified } = await verifiedServerInfo(probe, pinnedFingerprint);
  if (!verified) throw new ServerIdentityError("unsupported");
  verifiedServers.set(cacheKey(address.url, fingerprint), { until: Date.now() + VERIFIED_FOR_MS, info });
  return { info, fingerprint };
}

export interface VerifiedServerOptions extends ServerCallOptions {
  /** The connection to use; the connection saved in the settings when omitted. */
  connection?: PersonalServerSettings | null;
  /** Ask the server again even when it was verified a moment ago. */
  fresh?: boolean;
}

export interface VerifiedServer {
  client: NarrariumServerClient;
  info: ServerInfo;
  fingerprint: string;
}

/**
 * The only way to build a client of the personal server that carries the client token. The server
 * at the address must first prove the identity pinned in the settings; the address must be usable
 * and a fingerprint must be pinned. The verification is reused for 60 seconds and dropped when a
 * request through the returned client fails.
 */
export async function verifiedServer(options: VerifiedServerOptions = {}): Promise<VerifiedServer> {
  const connection = options.connection === undefined ? useSettingsStore.getState().settings.personalServer : options.connection;
  const address = validateServerAddress(connection?.url ?? "");
  if (address.ok === false) throw new ServerAddressError(address.reason);
  if (!connection) throw new ServerAddressError("empty");
  const pinned = connection.fingerprint;
  if (!pinned) throw new ServerIdentityError("unpinned");
  options.signal?.throwIfAborted();
  const key = cacheKey(address.url, pinned);
  const cached = options.fresh ? undefined : verifiedServers.get(key);
  let info: ServerInfo;
  if (cached && cached.until > Date.now()) {
    info = cached.info;
  } else {
    verifiedServers.delete(key);
    ({ info } = await probeServerIdentity(address.url, pinned, options));
  }
  options.signal?.throwIfAborted();
  return { client: new NarrariumServerClient({ baseUrl: address.url, token: connection.token, fetch: guardedFetch(options, key) }), info, fingerprint: pinned };
}

export async function verifiedClient(options: VerifiedServerOptions = {}): Promise<NarrariumServerClient> {
  return (await verifiedServer(options)).client;
}

/** First 16 hex digits in groups of four, as the admin panel shows them. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
}
