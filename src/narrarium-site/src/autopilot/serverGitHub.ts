import { GITHUB_CONNECTION_PROBLEM_CODES, serverSupportsGitHubConnection, type GitHubConnectionProblemCode, type ServerGitHubConnection, type ServerInfo } from "narrarium-engine";
import { authBrokerBase } from "@/config/authBroker";
import { GITHUB_APP_CLIENT_ID } from "@/config/publicClients";

/**
 * The server's own connection to GitHub, from the browser's side. The server connects with the GitHub App's device authorization and renews the connection through the broker, so
 * this site only has to say which app (its public Client ID) and which broker, and to read the status. These are pure rules; the calls are the runtime's (`readServerGitHub`,
 * `connectServerGitHub`, `disconnectServerGitHub`) and the screen's are in `useServerGitHub`.
 */

/** What the browser tells the server when it starts the connection: the app's public Client ID and the broker that holds the app's client secret. */
export interface ServerGitHubSite {
  clientId: string;
  broker: string;
}

/**
 * The Client ID and the broker of this build, or `null` when either is missing (a build without the GitHub App, or without a Worker). An E2E build can be given other ones by the page it
 * runs in, so that a spec talks to a broker of its own; the branch is removed from every other build.
 */
export function serverGitHubSite(): ServerGitHubSite | null {
  const forTests = typeof __NARRARIUM_E2E_BUILD__ !== "undefined" && __NARRARIUM_E2E_BUILD__ && import.meta.env.VITE_E2E === "true" ? window.__serverGitHubSiteForTests : undefined;
  const clientId = forTests?.clientId || GITHUB_APP_CLIENT_ID;
  const broker = forTests?.broker || authBrokerBase();
  return clientId && broker ? { clientId, broker } : null;
}

/** Whether the connection can be offered here: `ready`, or why not (`old-server`: it does not announce the feature; `no-site`: this build has no Client ID or no broker). */
export type ServerGitHubOffer = "ready" | "old-server" | "no-site";

export function serverGitHubOffer(info: Pick<ServerInfo, "features"> | null | undefined, site: ServerGitHubSite | null = serverGitHubSite()): ServerGitHubOffer {
  if (!serverSupportsGitHubConnection(info)) return "old-server";
  return site ? "ready" : "no-site";
}

/** The code of a problem that this site has words for; any other (a newer server may have more) is told with the server's own message. */
export function knownProblemCode(code: unknown): code is GitHubConnectionProblemCode {
  return typeof code === "string" && (GITHUB_CONNECTION_PROBLEM_CODES as readonly string[]).includes(code);
}

/** The server's own connection is working: the books that ask for it can use it. */
export function isServerGitHubConnected(connection: ServerGitHubConnection | null | undefined): boolean {
  return connection?.state === "connected";
}

/** The address the owner types the code on: GitHub's page over https, or this computer's own in a test; never anything else (an answer is not trusted to hold a link). */
export function safeVerificationAddress(address: string | undefined): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    if (url.username || url.password) return null;
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch {
    return null;
  }
}

/** How long to wait before asking the server again while it waits for the owner: the interval it asks GitHub at, kept between 2 and 10 seconds; longer after failures. */
export function pollDelayMs(connection: Pick<ServerGitHubConnection, "pending"> | null | undefined, failures = 0): number {
  const seconds = Math.min(10, Math.max(2, connection?.pending?.interval ?? 5));
  return Math.min(30_000, seconds * 1000 * 2 ** Math.min(failures, 3));
}
