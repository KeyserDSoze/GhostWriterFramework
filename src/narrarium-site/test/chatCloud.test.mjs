import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantSessionConflictError,
  listAssistantSessions,
  saveAssistantSession,
} from "../src/assistant/chatCloud.ts";
import { resetGoogleAppFolderCacheForTests } from "../src/drive/googleAppFolder.ts";

function response(value, status = 200, headers = {}) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function session(overrides = {}) {
  return {
    id: "session-1",
    title: "Cloud chat",
    contextTitle: "Book",
    updatedAt: "2026-08-15T10:00:00.000Z",
    messages: [],
    attachments: [],
    compactSummary: "",
    compactedMessageCount: 0,
    ...overrides,
  };
}

function installWindow() {
  const values = new Map();
  globalThis.window = /** @type {any} */ ({
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
}

function googleSetup(url, init = {}) {
  const parsed = new URL(String(url));
  const query = parsed.searchParams.get("q") ?? "";
  if (parsed.pathname.endsWith("/about")) return response({ user: { permissionId: "chat-tests" } });
  if (query.includes("appProperties has")) return response({ files: [{ id: "app", name: "Narrarium", appProperties: { narrariumAppFolder: "v1" } }] });
  if (query.includes("mimeType='application/vnd.google-apps.folder'") && query.includes("name='chats'")) return response({ files: [{ id: "chats" }] });
  return null;
}

function microsoftFolderSetup(url, init = {}) {
  const value = String(url);
  if (!init.method && /\/root:\/Apps(?:\/Narrarium(?:\/chats)?)?$/.test(new URL(value).pathname)) return response({ folder: {} });
  return null;
}

/** @type {Array<"google" | "microsoft">} */
const providers = ["google", "microsoft"];

for (const provider of providers) {
  test(`${provider} history follows pages, filters malformed entries and does not download payloads`, async () => {
    installWindow();
    resetGoogleAppFolderCacheForTests();
    let page = 0;
    let contentReads = 0;
    const largeGooglePage = Array.from({ length: 250 }, (_, index) => ({
      id: `g-bulk-${index}`,
      name: `bulk-${index}.json`,
      appProperties: { narrariumChat: "v1", sessionId: `bulk-${index}`, title: `Bulk ${index}`, contextTitle: "Book" },
    }));
    const largeMicrosoftPage = Array.from({ length: 250 }, (_, index) => ({
      id: `m-bulk-${index}`,
      name: `bulk-${index}.json`,
      file: {},
      description: JSON.stringify({ narrariumChat: "v1", sessionId: `bulk-${index}`, title: `Bulk ${index}`, contextTitle: "Book" }),
    }));
    globalThis.fetch = async (url, init = {}) => {
      const setup = provider === "google" ? googleSetup(url, init) : microsoftFolderSetup(url, init);
      if (setup) return setup;
      const value = String(url);
      if (value.includes("alt=media") || value.endsWith("/content")) contentReads += 1;
      page += 1;
      if (provider === "google") {
        if (page === 1) return response({
          nextPageToken: "next",
          files: [
            { id: "g1", name: "session-1.json", modifiedTime: "2026-08-15T10:00:00Z", appProperties: { narrariumChat: "v1", sessionId: "session-1", title: "First", contextTitle: "Book" } },
            ...largeGooglePage,
            { id: "bad-name", name: "notes.txt" },
            { id: "bad-marker", name: "wrong.json", appProperties: { narrariumChat: "other" } },
            { id: "markerless", name: "markerless.json", appProperties: {} },
          ],
        });
        return response({ files: [{ id: "g2", name: "session-2.json", modifiedTime: "2026-08-15T11:00:00Z", appProperties: { narrariumChat: "v1", sessionId: "session-2", title: "Second", contextTitle: "Book" } }] });
      }
      if (page === 1) return response({
        "@odata.nextLink": "https://graph.microsoft.com/next-page",
        value: [
          { id: "m1", name: "session-1.json", file: {}, eTag: "r1", description: JSON.stringify({ narrariumChat: "v1", sessionId: "session-1", title: "First", contextTitle: "Book" }) },
          ...largeMicrosoftPage,
          { id: "folder", name: "folder.json", folder: {} },
          { id: "bad", name: "notes.txt", file: {} },
          { id: "markerless", name: "markerless.json", file: {}, description: JSON.stringify({ title: "No marker" }) },
          { id: "malformed-description", name: "malformed.json", file: {}, description: "{" },
        ],
      });
      return response({ value: [{ id: "m2", name: "session-2.json", file: {}, eTag: "r2", lastModifiedDateTime: "2026-08-15T11:00:00Z", description: JSON.stringify({ narrariumChat: "v1", sessionId: "session-2", title: "Second", contextTitle: "Book" }) }] });
    };

    const result = await listAssistantSessions(provider, "token");
    assert.equal(result.length, 252);
    assert.ok(result.some((entry) => entry.id === "session-2"));
    assert.equal(result.find((entry) => entry.id === "session-1")?.title, "First");
    assert.equal(contentReads, 0);
  });

  test(`${provider} history propagates rate limits and supports cancellation`, async () => {
    installWindow();
    resetGoogleAppFolderCacheForTests();
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (url, init = {}) => {
      const setup = provider === "google" ? googleSetup(url, init) : microsoftFolderSetup(url, init);
      return setup ?? response({}, 429);
    };
    await assert.rejects(() => listAssistantSessions(provider, "token", { signal: controller.signal }), /cancelled|aborted/i);

    resetGoogleAppFolderCacheForTests();
    await assert.rejects(() => listAssistantSessions(provider, "token"), /429/);
  });
}

function installGoogleSaveMock() {
  let stored = null;
  let revision = 0;
  globalThis.fetch = async (url, init = {}) => {
    const setup = googleSetup(url, init);
    if (setup) return setup;
    const value = String(url);
    const parsed = new URL(value);
    const query = parsed.searchParams.get("q") ?? "";
    if (!init.method && query.includes("mimeType='application/json'")) return response({ files: stored ? [{ id: "g-file", name: "session-1.json", appProperties: { narrariumChat: "v1", sessionId: "session-1", title: stored.title, contextTitle: stored.contextTitle } }] : [] });
    if (init.method === "POST" && value.includes("upload/drive")) {
      stored = session();
      revision += 1;
      return response({ id: "g-file" }, 200, { ETag: `r${revision}` });
    }
    if (init.method === "PATCH" && value.includes("upload/drive")) {
      if (init.headers["If-Match"] !== `r${revision}`) return response({}, 412);
      stored = JSON.parse(await init.body.get("file").text());
      revision += 1;
      return response({}, 200, { ETag: `r${revision}` });
    }
    if (!init.method && value.includes("g-file?fields=id")) return response({ id: "g-file" }, 200, { ETag: `r${revision}` });
    if (!init.method && value.includes("g-file?alt=media")) return response(stored, 200, { ETag: `r${revision}` });
    throw new Error(`Unexpected Google request: ${value}`);
  };
  return { replace: (value) => { stored = value; revision += 1; } };
}

function installMicrosoftSaveMock() {
  let stored = null;
  let revision = 0;
  let metadataPresent = false;
  let metadata = null;
  let failMetadata = false;
  let contentWrites = 0;
  let metadataWrites = 0;
  globalThis.fetch = async (url, init = {}) => {
    const setup = microsoftFolderSetup(url, init);
    if (setup) return setup;
    const value = String(url);
    if (!init.method && value.includes(":/children?")) return response({ value: stored && metadataPresent ? [{ id: "m-file", name: "session-1.json", file: {}, eTag: `r${revision}`, description: JSON.stringify(metadata) }] : [] });
    if (!init.method && value.includes("root:/Apps/Narrarium/chats/session-1.json?$select")) {
      return stored ? response({
        id: "m-file",
        name: "session-1.json",
        file: {},
        eTag: `r${revision}`,
        ...(metadataPresent ? { description: JSON.stringify(metadata) } : {}),
      }) : response({}, 404);
    }
    if (init.method === "PUT" && value.includes("root:/Apps/Narrarium/chats/session-1.json:/content")) {
      if (stored) return response({}, 412);
      stored = JSON.parse(init.body);
      revision += 1;
      contentWrites += 1;
      return response({ id: "m-file", eTag: `r${revision}` });
    }
    if (init.method === "PUT" && value.includes("/items/m-file/content")) {
      if (init.headers["If-Match"] !== `r${revision}`) return response({}, 412);
      stored = JSON.parse(init.body);
      revision += 1;
      contentWrites += 1;
      return response({ id: "m-file", eTag: `r${revision}` });
    }
    if (init.method === "PATCH" && value.includes("/items/m-file")) {
      metadataWrites += 1;
      if (failMetadata) { failMetadata = false; return response({}, 503); }
      metadata = JSON.parse(JSON.parse(init.body).description);
      metadataPresent = true;
      revision += 1;
      return response({ id: "m-file", eTag: `r${revision}` });
    }
    if (!init.method && value.includes("/items/m-file?$select")) return response({ id: "m-file", eTag: `r${revision}`, ...(metadataPresent ? { description: JSON.stringify(metadata) } : {}) });
    if (!init.method && value.endsWith("/items/m-file/content")) return response(stored);
    throw new Error(`Unexpected Microsoft request: ${value}`);
  };
  return {
    replace: (value) => {
      stored = value;
      revision += 1;
      metadataPresent = true;
      metadata = { narrariumChat: "v1", sessionId: "session-1", title: value.title, contextTitle: value.contextTitle };
    },
    failNextMetadata: () => { failMetadata = true; },
    counts: () => ({ contentWrites, metadataWrites }),
    hasMetadata: () => metadataPresent,
  };
}

test("Google create reconciliation observes later duplicates and deletes only identical noncanonical copies", async () => {
  installWindow();
  resetGoogleAppFolderCacheForTests();
  let listsAfterCreate = 0;
  let created = false;
  const deleted = [];
  globalThis.fetch = async (url, init = {}) => {
    const setup = googleSetup(url, init);
    if (setup) return setup;
    const value = String(url);
    const query = new URL(value).searchParams.get("q") ?? "";
    if (!init.method && query.includes("mimeType='application/json'")) {
      if (!created) return response({ files: [] });
      listsAfterCreate += 1;
      const own = { id: "z-created", name: "session-1.json", appProperties: { narrariumChat: "v1", sessionId: "session-1", title: "Cloud chat", contextTitle: "Book" } };
      const other = { ...own, id: "a-other" };
      return response({ files: listsAfterCreate === 1 ? [own] : [own, other] });
    }
    if (init.method === "POST" && value.includes("upload/drive")) {
      created = true;
      return response({ id: "z-created" }, 200, { ETag: "rz" });
    }
    if (!init.method && value.includes("?alt=media")) return response(session(), 200, { ETag: value.includes("a-other") ? "ra" : "rz" });
    if (init.method === "DELETE") { deleted.push(value); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected Google request: ${value}`);
  };

  const handle = await saveAssistantSession("google", "token", session());
  assert.equal(handle.fileId, "a-other");
  assert.equal(listsAfterCreate, 3);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /z-created/);
});

test("Google differing concurrent create rolls back its own new duplicate and leaves the other canonical file", async () => {
  installWindow();
  resetGoogleAppFolderCacheForTests();
  let created = false;
  let ownDeleted = false;
  globalThis.fetch = async (url, init = {}) => {
    const setup = googleSetup(url, init);
    if (setup) return setup;
    const value = String(url);
    const query = new URL(value).searchParams.get("q") ?? "";
    if (!init.method && query.includes("mimeType='application/json'")) {
      const own = { id: "z-created", name: "session-1.json", appProperties: { narrariumChat: "v1", sessionId: "session-1", title: "Cloud chat", contextTitle: "Book" } };
      const other = { ...own, id: "a-other", title: "Other device" };
      if (!created) return response({ files: [] });
      return response({ files: ownDeleted ? [other] : [own, other] });
    }
    if (init.method === "POST" && value.includes("upload/drive")) { created = true; return response({ id: "z-created" }, 200, { ETag: "rz" }); }
    if (!init.method && value.includes("a-other?alt=media")) return response(session({ title: "Other device" }), 200, { ETag: "ra" });
    if (!init.method && value.includes("z-created?alt=media")) return response(session(), 200, { ETag: "rz" });
    if (init.method === "DELETE" && value.includes("z-created")) { ownDeleted = true; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected Google request: ${value}`);
  };

  await assert.rejects(() => saveAssistantSession("google", "token", session()), AssistantSessionConflictError);
  assert.equal(ownDeleted, true);
  await assert.rejects(() => saveAssistantSession("google", "token", session()), AssistantSessionConflictError);
});

test("Google differing concurrent create never deletes its own file when it wins canonical election", async () => {
  installWindow();
  resetGoogleAppFolderCacheForTests();
  let created = false;
  let deleted = false;
  globalThis.fetch = async (url, init = {}) => {
    const setup = googleSetup(url, init);
    if (setup) return setup;
    const value = String(url);
    const query = new URL(value).searchParams.get("q") ?? "";
    if (!init.method && query.includes("mimeType='application/json'")) {
      if (!created) return response({ files: [] });
      const own = { id: "a-created", name: "session-1.json", appProperties: { narrariumChat: "v1", sessionId: "session-1", title: "Cloud chat", contextTitle: "Book" } };
      return response({ files: [own, { ...own, id: "z-other", title: "Other device" }] });
    }
    if (init.method === "POST" && value.includes("upload/drive")) { created = true; return response({ id: "a-created" }, 200, { ETag: "ra" }); }
    if (!init.method && value.includes("a-created?alt=media")) return response(session(), 200, { ETag: "ra" });
    if (!init.method && value.includes("z-other?alt=media")) return response(session({ title: "Other device" }), 200, { ETag: "rz" });
    if (init.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected Google request: ${value}`);
  };
  await assert.rejects(() => saveAssistantSession("google", "token", session()), AssistantSessionConflictError);
  assert.equal(deleted, false);
});

test("OneDrive retry repairs metadata after create content succeeded", async () => {
  installWindow();
  const remote = installMicrosoftSaveMock();
  remote.failNextMetadata();
  await assert.rejects(() => saveAssistantSession("microsoft", "token", session()), /metadata update: 503/);
  assert.equal(remote.hasMetadata(), false);

  const repaired = await saveAssistantSession("microsoft", "token", session());
  assert.equal(repaired.fileId, "m-file");
  assert.equal(remote.hasMetadata(), true);
  assert.deepEqual(remote.counts(), { contentWrites: 1, metadataWrites: 2 });
});

test("OneDrive stale retry repairs metadata after update content succeeded", async () => {
  installWindow();
  const remote = installMicrosoftSaveMock();
  const created = await saveAssistantSession("microsoft", "token", session());
  remote.failNextMetadata();
  const changed = session({ ...created, title: "Changed" });
  await assert.rejects(() => saveAssistantSession("microsoft", "token", changed), /metadata update: 503/);

  const repaired = await saveAssistantSession("microsoft", "token", changed);
  assert.equal(repaired.fileId, "m-file");
  assert.equal(remote.hasMetadata(), true);
  assert.deepEqual(remote.counts(), { contentWrites: 2, metadataWrites: 3 });
});

const saveProviders = [
  { provider: /** @type {const} */ ("google"), install: installGoogleSaveMock },
  { provider: /** @type {const} */ ("microsoft"), install: installMicrosoftSaveMock },
];

for (const { provider, install } of saveProviders) {
  test(`${provider} create/update/conflict/migration-rerun contract is revision-safe`, async () => {
    installWindow();
    resetGoogleAppFolderCacheForTests();
    const remote = install();
    const created = await saveAssistantSession(provider, "token", session());
    assert.ok(created.fileId);
    assert.ok(created.revision);

    const migratedAgain = await saveAssistantSession(provider, "token", session());
    assert.equal(migratedAgain.fileId, created.fileId);
    assert.equal(migratedAgain.revision, created.revision);

    const changed = session({ ...created, title: "Changed" });
    const updated = await saveAssistantSession(provider, "token", changed);
    assert.notEqual(updated.revision, created.revision);

    const retried = await saveAssistantSession(provider, "token", changed);
    assert.equal(retried.fileId, updated.fileId);
    assert.equal(retried.revision, updated.revision);

    remote.replace(session({ title: "Other device" }));
    await assert.rejects(
      () => saveAssistantSession(provider, "token", session({ ...updated, title: "Local edit" })),
      (error) => error instanceof AssistantSessionConflictError && error.recoverable,
    );
  });
}
