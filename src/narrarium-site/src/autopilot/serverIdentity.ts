import { ServerRequestError, type NarrariumServerClient, type ServerInfo } from "narrarium-engine";

/** The server at the configured address is not the one this device paired with, or cannot prove who it is. */
export class ServerIdentityError extends Error {
  constructor(readonly reason: "changed" | "invalid") {
    super(reason === "changed" ? "The personal server's identity changed." : "The personal server could not prove its identity.");
    this.name = "ServerIdentityError";
  }
}

/**
 * Ask the server to sign a fresh nonce, check the signature and compare its key with the pinned
 * fingerprint. Call it before sending the client token to a server.
 */
export async function verifiedServerInfo(client: NarrariumServerClient, pinnedFingerprint?: string): Promise<{ info: ServerInfo; fingerprint: string }> {
  let checked: Awaited<ReturnType<NarrariumServerClient["verifiedInfo"]>>;
  try {
    checked = await client.verifiedInfo();
  } catch (error) {
    if (error instanceof ServerRequestError) throw error;
    throw new ServerIdentityError("invalid");
  }
  if (pinnedFingerprint && checked.identity.fingerprint !== pinnedFingerprint) throw new ServerIdentityError("changed");
  return { info: checked.info, fingerprint: checked.identity.fingerprint };
}

/** First 16 hex digits in groups of four, as the admin panel shows them. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
}
