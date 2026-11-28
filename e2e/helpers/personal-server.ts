import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A real personal server, started in the process of the spec on free ports with an empty data folder and no AI of its own: what a browser pairs with, and
// what the specs read back (the server's own answers) to say what was and was not sent to it.

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/** The origin the specs' pages are served from: the only browser origin the server lets call it. */
export const E2E_ORIGIN = "http://127.0.0.1:4173";

export interface TestPersonalServer {
  url: string;
  /** What the settings of the page hold to pair with it: the address, the client token and the identity it pins. */
  pairing: { url: string; token: string; serverId: string; fingerprint: string; clientLabel: string };
  /** Whether the server holds an AI configuration (`GET /api/v1/ai`). */
  aiConfigured(): Promise<boolean>;
  /** The books it hosts, as it lists them. */
  books(): Promise<Array<{ bookId: string; hasGithubToken?: boolean }>>;
  close(): Promise<void>;
}

export async function startPersonalServer(): Promise<TestPersonalServer> {
  const { startNarrariumServer } = await nativeImport(pathToFileURL(resolve(__dirname, "../../packages/server/dist/testing.mjs")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "narrarium-e2e-server-"));
  const server = await startNarrariumServer({
    dataDir,
    port: 0,
    adminPort: 0,
    origins: [E2E_ORIGIN],
    supervised: false,
    checkRelease: async (installedVersion: string) => ({ packageName: "narrarium-server", installedVersion, available: false, signed: false, reason: "not_published", message: "Not published." }),
    tunnel: { findBinary: () => undefined, detectOtherConnectors: async () => [] },
  });
  const { token } = await server.auth.issue("e2e browser", ["read", "write", "run"]);
  const call = async (path: string) => (await fetch(`${server.url}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
  return {
    url: server.url,
    pairing: { url: server.url, token, serverId: server.data.config.serverId, fingerprint: server.data.fingerprint, clientLabel: "e2e browser" },
    aiConfigured: async () => (await call("/ai")).configured === true,
    books: async () => ((await call("/books")).books ?? []) as Array<{ bookId: string; hasGithubToken?: boolean }>,
    close: async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
