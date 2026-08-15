import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureGoogleAppFolder,
  deleteVerifiedGoogleAppFolders,
  isLegacyNarrariumSettings,
  listVerifiedGoogleAppFolders,
  selectCanonicalGoogleAppFolder,
  resetGoogleAppFolderCacheForTests,
} from "../src/drive/googleAppFolder.ts";

function installBrowserStorage() {
  const values = new Map();
  globalThis.window = /** @type {any} */ ({
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  return values;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("selects one deterministic canonical folder from verified duplicates", () => {
  const selected = selectCanonicalGoogleAppFolder([
    { id: "z", name: "Narrarium", createdTime: "2026-01-02T00:00:00Z" },
    { id: "b", name: "Narrarium", createdTime: "2026-01-01T00:00:00Z" },
    { id: "a", name: "Narrarium", createdTime: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(selected?.id, "a");
});

test("legacy migration requires a structurally valid Narrarium settings document", () => {
  assert.equal(isLegacyNarrariumSettings({ photos: [], ui: { language: "en" } }), false);
  assert.equal(isLegacyNarrariumSettings({ version: 2, books: [], defaultGitHubToken: "", ui: { language: "it" } }), true);
});

test("never returns an unmarked same-name personal folder", async () => {
  installBrowserStorage();
  resetGoogleAppFolderCacheForTests();
  globalThis.fetch = async () => jsonResponse({ files: [
    { id: "personal", name: "Narrarium", mimeType: "application/vnd.google-apps.folder", appProperties: {} },
    { id: "owned", name: "Narrarium", mimeType: "application/vnd.google-apps.folder", appProperties: { narrariumAppFolder: "v1" } },
  ] });
  const folders = await listVerifiedGoogleAppFolders("token");
  assert.deepEqual(folders.map((folder) => folder.id), ["owned"]);
});

test("migrates only the same-name legacy folder with valid app settings", async () => {
  installBrowserStorage();
  resetGoogleAppFolderCacheForTests();
  let markerWrites = 0;
  let creates = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const decoded = decodeURIComponent(String(url));
    const query = parsed.searchParams.get("q") ?? "";
    if (decoded.includes("/about?")) return jsonResponse({ user: { permissionId: "legacy-account" } });
    if (init.method === "POST") {
      creates += 1;
      return jsonResponse({ id: "unexpected" });
    }
    if (init.method === "PATCH") {
      markerWrites += 1;
      return jsonResponse({ id: "legacy-app" });
    }
    if (query.includes("appProperties has")) return jsonResponse({ files: [] });
    if (query.includes("'root' in parents")) return jsonResponse({ files: [
      { id: "personal", name: "Narrarium", createdTime: "2025-01-01T00:00:00Z" },
      { id: "legacy-app", name: "Narrarium", createdTime: "2025-01-02T00:00:00Z" },
    ] });
    if (query.includes("'personal' in parents")) return jsonResponse({ files: [] });
    if (query.includes("'legacy-app' in parents")) return jsonResponse({ files: [{ id: "settings-file" }] });
    if (decoded.includes("settings-file?alt=media")) return jsonResponse({ version: 2, books: [], defaultGitHubToken: "", ui: { language: "en" } });
    throw new Error(`Unexpected request: ${decoded}`);
  };

  assert.equal(await ensureGoogleAppFolder("legacy-token"), "legacy-app");
  assert.equal(markerWrites, 1);
  assert.equal(creates, 0);
});

test("concurrent recreation shares one marked-folder creation", async () => {
  installBrowserStorage();
  resetGoogleAppFolderCacheForTests();
  let creates = 0;
  let created = false;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const decoded = decodeURIComponent(String(url));
    const query = parsed.searchParams.get("q") ?? "";
    if (decoded.includes("/about?")) return jsonResponse({ user: { permissionId: "new-account" } });
    if (init.method === "POST") {
      creates += 1;
      created = true;
      return jsonResponse({ id: "created", name: "Narrarium", createdTime: "2026-01-01T00:00:00Z", appProperties: { narrariumAppFolder: "v1" } });
    }
    if (query.includes("appProperties has")) return jsonResponse({ files: created ? [{ id: "created", name: "Narrarium", createdTime: "2026-01-01T00:00:00Z", appProperties: { narrariumAppFolder: "v1" } }] : [] });
    if (query.includes("'root' in parents")) return jsonResponse({ files: [] });
    throw new Error(`Unexpected request: ${decoded}`);
  };

  const [first, second] = await Promise.all([ensureGoogleAppFolder("new-token"), ensureGoogleAppFolder("new-token")]);
  assert.equal(first, "created");
  assert.equal(second, "created");
  assert.equal(creates, 1);
});

test("deletion removes only verified IDs and a later reconnect recreates one marked folder", async () => {
  installBrowserStorage();
  resetGoogleAppFolderCacheForTests();
  const deleted = [];
  let phase = "delete";
  let created = false;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const decoded = decodeURIComponent(String(url));
    const query = parsed.searchParams.get("q") ?? "";
    if (decoded.includes("/about?")) return jsonResponse({ user: { permissionId: "delete-account" } });
    if (init.method === "DELETE") {
      deleted.push(parsed.pathname.split("/").pop());
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST") {
      created = true;
      return jsonResponse({ id: "recreated", name: "Narrarium", createdTime: "2026-02-01T00:00:00Z", appProperties: { narrariumAppFolder: "v1" } });
    }
    if (query.includes("appProperties has")) {
      if (phase === "delete") return jsonResponse({ files: [{ id: "owned", name: "Narrarium", appProperties: { narrariumAppFolder: "v1" } }] });
      return jsonResponse({ files: created ? [{ id: "recreated", name: "Narrarium", createdTime: "2026-02-01T00:00:00Z", appProperties: { narrariumAppFolder: "v1" } }] : [] });
    }
    if (query.includes("'root' in parents")) return jsonResponse({ files: [{ id: "personal", name: "Narrarium" }] });
    if (query.includes("'personal' in parents")) return jsonResponse({ files: [] });
    throw new Error(`Unexpected request: ${decoded}`);
  };

  assert.deepEqual(await deleteVerifiedGoogleAppFolders("delete-token"), ["owned"]);
  assert.deepEqual(deleted, ["owned"]);
  phase = "recreate";
  resetGoogleAppFolderCacheForTests();
  assert.equal(await ensureGoogleAppFolder("delete-token"), "recreated");
});
