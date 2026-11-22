import type { ServerScope } from "narrarium-engine";
import type { Auth } from "./auth.js";
import { HttpError } from "./errors.js";

/** What a credential may do on a book's MCP: `read` the book, `write` it (add the editing tools), `run` its autopilot (add the autopilot tools). */
export type McpScope = "read" | "write" | "run";
const MCP_SCOPES: readonly McpScope[] = ["read", "write", "run"];
const isMcpScope = (scope: ServerScope): scope is McpScope => (MCP_SCOPES as readonly string[]).includes(scope);

/**
 * Who is calling the endpoint of a book, however they proved it. The endpoint asks nothing else of a credential: a client token (pairing,
 * or the admin panel), or an OAuth access token that is bound to one book and to the scope the owner chose when he allowed the connection.
 */
export interface McpPrincipal {
  /** What the limits and the audit count the caller by: a client token's id, or `oauth:` and the id of an OAuth grant. */
  id: string;
  /** What the owner calls it: it is what the commit messages and the audit say. */
  label: string;
  scopes: readonly McpScope[];
  /** The only book this credential is for (an OAuth token is bound to one). A client token is for every book whose MCP is on. */
  bookId?: string;
  /** Whether it still holds: revoking it ends its access at once, also for the call in progress. */
  current(): boolean;
}

/** Turn what came in the `Authorization` header into a principal, or throw `HttpError` 401. */
export type McpAuthenticator = (token: string | undefined) => McpPrincipal;

/** The client tokens of the server (the ones pairing and the admin panel issue). */
export function clientTokenAuthenticator(auth: Auth): McpAuthenticator {
  return (token) => {
    const client = auth.authenticate(token);
    return { id: client.id, label: client.label, scopes: client.scopes.filter(isMcpScope), current: () => auth.isCurrent(client) };
  };
}

/** Try each way of proving who is calling, in order: the first that knows the token wins; when none does, the first refusal is the answer. */
export function authenticateMcp(authenticators: readonly McpAuthenticator[], token: string | undefined): McpPrincipal {
  let refusal: HttpError | undefined;
  for (const authenticate of authenticators) {
    try {
      return authenticate(token);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      refusal ??= error;
    }
  }
  throw refusal ?? new HttpError(401, "unauthorized", "Missing or invalid client token.");
}

/** What a refusal adds to the `WWW-Authenticate` header: where the metadata of the resource is (RFC 9728, so that an app finds the authorization server by itself) and which scope is missing. */
export interface ChallengeOptions {
  resourceMetadata?: string;
  scope?: string;
}

/** The `WWW-Authenticate` header of a refusal: the scheme every MCP client looks for, with the address of the resource metadata that tells it how to get a token. */
export function challenge(reason?: "invalid_token" | "insufficient_scope", options: ChallengeOptions = {}): Record<string, string> {
  // The address of the metadata comes first, as the specification writes it: a client that reads only what follows `Bearer` finds it at once.
  const parts = [...(options.resourceMetadata ? [`resource_metadata="${options.resourceMetadata}"`] : []), 'realm="narrarium"'];
  if (reason) parts.push(`error="${reason}"`);
  if (options.scope) parts.push(`scope="${options.scope}"`);
  return { "www-authenticate": `Bearer ${parts.join(", ")}` };
}
