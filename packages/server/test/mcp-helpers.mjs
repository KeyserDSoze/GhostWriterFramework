import { execFileSync } from "node:child_process";
import { seedBookFiles } from "narrarium-engine/testing";
import { rawApi } from "./api-helpers.mjs";

// What the tests of the per-book MCP endpoint (S7) share: a small book with chapters, scenes and canon, the way to switch a book's MCP on, and a
// JSON-RPC client that sends exactly what it is told to (a typed client would never send a broken request).

export const VERSION = "2025-06-18";
export const TITLE = "The Glass Harbor";
/** The tools of each permission, in the order the endpoint lists them. */
export const READ_TOOLS = ["book_info", "list_chapters", "read_chapter", "read_paragraph", "search_book", "list_canon", "read_canon_entry", "list_files", "read_file", "autopilot_status", "read_outline", "read_outline_entry"];
export const WRITE_TOOLS = ["create_chapter", "update_chapter", "create_paragraph", "update_paragraph", "create_canon_entry", "update_canon_entry", "write_file", "edit_outline"];
export const RUN_TOOLS = ["autopilot_pause", "autopilot_retry_now", "autopilot_resume", "autopilot_note", "autopilot_answer"];

const document = (fields, body) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body}\n`;

/** The files of the book that the tests read and edit. */
export function mcpBookFiles() {
  const files = {
    ...seedBookFiles({ title: TITLE }),
    "chapters/001-arrival/chapter.md": document({ type: "chapter", id: "chapter:001-arrival", number: 1, title: "Arrival", summary: "Mira reaches the harbor.", pov: ["mira"], canon: "draft" }, "# Arrival\n\nMira comes home."),
    "chapters/001-arrival/001-the-quay.md": document({ type: "paragraph", id: "paragraph:001-arrival:001-the-quay", chapter: "chapter:001-arrival", number: 1, title: "The Quay", summary: "Mira steps onto the quay.", viewpoint: "mira", mood: "tense", canon: "draft" }, "Mira stepped onto the quay. The lantern light shook on the water.\n\nA gull screamed twice."),
    "chapters/001-arrival/002-the-letter.md": document({ type: "paragraph", id: "paragraph:001-arrival:002-the-letter", chapter: "chapter:001-arrival", number: 2, title: "The Letter", summary: "A letter and a key.", viewpoint: "mira", canon: "draft" }, "She read the letter under the lamp. The salt wind pulled at the page, and the salt wind smelled of rain. A brass key slid out of the fold."),
    "chapters/002-the-storm/chapter.md": document({ type: "chapter", id: "chapter:002-the-storm", number: 2, title: "The Storm", summary: "The harbor takes a wave.", pov: ["mira"], canon: "draft" }, "# The Storm"),
    "chapters/002-the-storm/001-the-wave.md": document({ type: "paragraph", id: "paragraph:002-the-storm:001-the-wave", chapter: "chapter:002-the-storm", number: 1, title: "The Wave", summary: "The wave comes before the bell.", viewpoint: "mira", canon: "draft" }, "The wave came before the bell. Nobody on the quay spoke of the keeper."),
    "characters/mira.md": document({ type: "character", id: "character:mira", name: "Mira", aliases: ["Mirabel"], role_tier: "main", story_role: "protagonist", function_in_book: "The glassmaker's daughter who comes home.", canon: "draft" }, "# Mira\n\nA glassmaker's daughter."),
    "locations/harbor.md": document({ type: "location", id: "location:harbor", name: "The Harbor", atmosphere: "Salt, glass and fog.", canon: "draft" }, "# The Harbor\n\nA town built on glass."),
    "factions/glassmakers.md": document({ type: "faction", id: "faction:glassmakers", name: "The Glassmakers", mission: "Keep the furnaces lit.", canon: "draft" }, "# The Glassmakers\n\nThe guild of the furnaces."),
    "items/lantern.md": document({ type: "item", id: "item:lantern", name: "The Lantern", purpose: "It guides the boats.", canon: "draft" }, "# The Lantern\n\nA lantern of green glass."),
    "secrets/the-keeper.md": document({ type: "secret", id: "secret:the-keeper", title: "The Keeper's Debt", summary: "SUMMARY-LEAK-5520", holders: ["character:mira"], known_from: "chapter:002-the-storm", reveal_in: "chapter:002-the-storm", canon: "draft" }, "# The Keeper's Debt\n\nSECRET-TRUTH-7731: the keeper built the lighthouse to hide a debt."),
    "timelines/events/founding.md": document({ type: "timeline-event", id: "timeline-event:founding", title: "The Founding", date: "0001", canon: "draft" }, "# The Founding\n\nThe harbor was founded on a sandbar."),
    "notes.md": "# Notes\n\nRemember the brass key.\n",
    "outline/act-one.md": "# Act one\n\n1. Arrival.\n2. The storm.\n",
    "autopilot/plan.md": "# Autopilot plan\n\nNothing yet.\n",
    ".github/workflows/ci.yml": "name: ci\non: push\n",
    ".vscode/tasks.json": "{}\n",
  };
  return Object.entries(files).map(([path, content]) => ({ path, content }));
}

/** Register a local book that holds `mcpBookFiles()`; answers its id. */
export async function mcpBook(client, bookId = "glass", title = TITLE) {
  await client.registerBook(bookId, { title, storage: { kind: "local" } });
  await client.commitFiles(bookId, mcpBookFiles(), "seed");
  return bookId;
}

/** A client token of `scopes` for `label`. */
export async function issueToken(server, label = "Claude Code", scopes = ["read", "write", "run"]) {
  return (await server.auth.issue(label, scopes)).token;
}

/** The status route of a book's MCP, through a raw client: `{ get(), put(body) }`, each answering `{ status, json }`. */
export async function mcpRoute(server, bookId = "glass") {
  const api = await rawApi(server);
  const route = `/api/v1/books/${bookId}/mcp`;
  return { get: () => api("GET", route), put: (body) => api("PUT", route, body), call: api };
}

/** Switch a book's MCP on; answers the status (the slug is in it). */
export async function enableMcp(server, bookId = "glass") {
  const answer = await (await mcpRoute(server, bookId)).put({ enabled: true });
  if (answer.status !== 200) throw new Error(`switching the MCP of ${bookId} on failed: ${answer.status} ${answer.text}`);
  return answer.json;
}

const tryParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * A JSON-RPC client for the endpoint of a book. `post(body, headers)` sends a body as it is (a string, or a value sent as JSON); `request(method, params)` sends
 * a request with a fresh id; `call(name, args)` calls a tool and gives the result with its text blocks and the first one parsed (`data`).
 * Every answer has `{ status, json, text, headers }`. `version: null` sends no `MCP-Protocol-Version` header.
 */
export function mcpClient(server, slug, token, { version = VERSION, headers = {} } = {}) {
  const url = `${server.url}/mcp/${slug}`;
  let counter = 0;
  const post = async (body, extra = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(version ? { "mcp-protocol-version": version } : {}), ...headers, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: tryParse(text), text, headers: response.headers };
  };
  const request = (method, params) => post({ jsonrpc: "2.0", id: ++counter, method, params });
  const call = async (name, args = {}) => {
    const answer = await request("tools/call", { name, arguments: args });
    const result = answer.json?.result;
    const blocks = result?.content ?? [];
    return { ...answer, result, error: answer.json?.error, isError: result?.isError === true, blocks, text: blocks.map((block) => block.text).join("\n"), data: tryParse(blocks[0]?.text) };
  };
  const list = async () => (await request("tools/list", {})).json?.result?.tools?.map((tool) => tool.name) ?? [];
  return { url, post, request, call, list, method: (method, extra = {}) => fetch(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } }) };
}

/** A server with a registered book, its MCP switched on, and a client of every permission: what most tests start from. */
export async function mcpFixture(server, client, { label = "Claude Code", scopes, bookId = "glass" } = {}) {
  await mcpBook(client, bookId);
  const status = await enableMcp(server, bookId);
  const token = await issueToken(server, label, scopes);
  return { bookId, slug: status.slug, token, rpc: mcpClient(server, status.slug, token), status };
}

/** `git` in a book's working copy, answering what it printed. */
export const git = (server, bookId, ...args) => execFileSync("git", ["-C", server.data.bookDirectory(bookId), ...args], { encoding: "utf8" }).trim();
/** The subject of the book's last commit, and how many there are. */
export const lastCommit = (server, bookId = "glass") => git(server, bookId, "log", "-1", "--format=%s");
export const commitCount = (server, bookId = "glass") => Number(git(server, bookId, "rev-list", "--count", "HEAD"));
