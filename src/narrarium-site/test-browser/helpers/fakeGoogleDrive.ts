const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface FakeDriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content: string;
  version: number;
  appProperties?: Record<string, string>;
}

export interface FakeDriveRequest {
  method: string;
  url: URL;
  headers: Headers;
}

export interface FakeGoogleDriveOptions {
  /** A browser cannot read the ETag header of a cross-origin googleapis.com response; set it to model a client that can. */
  exposeEtag?: boolean;
  /** Leave the `version` out of the JSON metadata, as an older API would. */
  omitVersion?: boolean;
}

/**
 * A small in-memory Google Drive v3 that answers like the real API does to a browser:
 * the revision of a file is its JSON `version`, and the ETag header is not exposed unless asked for.
 */
export function createFakeGoogleDrive(options: FakeGoogleDriveOptions = {}) {
  const files = new Map<string, FakeDriveFile>();
  const requests: FakeDriveRequest[] = [];
  let sequence = 0;
  const appFolderId = "app-folder";
  files.set(appFolderId, { id: appFolderId, name: "Narrarium", parents: ["root-id"], mimeType: FOLDER_MIME, content: "", version: 1, appProperties: { narrariumAppFolder: "v1" } });

  const etagOf = (file: FakeDriveFile) => `"etag-${file.id}-${file.version}"`;
  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const etagHeader = (file: FakeDriveFile): Record<string, string> => (options.exposeEtag ? { ETag: etagOf(file) } : {});
  const everything = (file: FakeDriveFile): Record<string, unknown> => ({ id: file.id, name: file.name, parents: file.parents, mimeType: file.mimeType, ownedByMe: true, trashed: false, createdTime: "2026-11-01T00:00:00.000Z", modifiedTime: "2026-11-21T00:00:00.000Z", appProperties: file.appProperties, ...(options.omitVersion ? {} : { version: String(file.version) }) });
  /** Like the real API, answer with the requested `fields` only: asking for `id` does not return the `version`. */
  const pick = (file: FakeDriveFile, fields: string | null): Record<string, unknown> => {
    if (!fields) return { kind: "drive#file", id: file.id, name: file.name, mimeType: file.mimeType };
    const wanted = new Set(fields.replace(/^.*files\(/, "").replace(/\)$/, "").split(",").map((field) => field.trim()));
    return Object.fromEntries(Object.entries(everything(file)).filter(([key]) => wanted.has(key)));
  };

  function matches(file: FakeDriveFile, query: string): boolean {
    const name = /(?:^|\s)name='([^']*)'/.exec(query)?.[1];
    const parent = /'([^']*)' in parents/.exec(query)?.[1];
    const mimeType = /mimeType='([^']*)'/.exec(query)?.[1];
    if (name !== undefined && file.name !== name) return false;
    if (parent !== undefined && !file.parents.includes(parent)) return false;
    if (mimeType !== undefined && file.mimeType !== mimeType) return false;
    for (const [, key, value] of query.matchAll(/appProperties has \{ key='([^']*)' and value='([^']*)' \}/g)) if (file.appProperties?.[key] !== value) return false;
    return true;
  }

  async function readUpload(body: BodyInit | null | undefined): Promise<{ metadata: Record<string, unknown>; content: string }> {
    if (body instanceof FormData) {
      const metadata = JSON.parse(await (body.get("metadata") as Blob).text()) as Record<string, unknown>;
      return { metadata, content: await (body.get("file") as Blob).text() };
    }
    return { metadata: {}, content: String(body ?? "") };
  }

  async function fetchDrive(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    requests.push({ method, url, headers });
    const path = url.pathname;
    const media = url.searchParams.get("alt") === "media";

    if (method === "GET" && path === "/drive/v3/about") return respond({ user: { permissionId: "permission-1" } });
    if (method === "GET" && path === "/drive/v3/files/root") return respond({ id: "root-id" });
    if (method === "GET" && path === "/drive/v3/files") {
      const query = url.searchParams.get("q") ?? "";
      return respond({ files: [...files.values()].filter((file) => matches(file, query)).map((entry) => pick(entry, url.searchParams.get("fields"))) });
    }
    const target = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
    const file = target ? files.get(decodeURIComponent(target[1])) : undefined;
    if (method === "GET" && target && path.startsWith("/drive/")) {
      if (!file) return respond({ error: { code: 404 } }, 404);
      if (media) return new Response(file.content, { status: 200, headers: { "Content-Type": "application/json", ...etagHeader(file) } });
      return respond(pick(file, url.searchParams.get("fields")), 200, etagHeader(file));
    }
    if (method === "PATCH" && target && path.startsWith("/upload/")) {
      if (!file) return respond({ error: { code: 404 } }, 404);
      const ifMatch = headers.get("If-Match");
      if (ifMatch !== null && ifMatch !== etagOf(file)) return respond({ error: { code: 412 } }, 412);
      const upload = await readUpload(init.body);
      file.content = upload.content;
      if (upload.metadata.appProperties) file.appProperties = upload.metadata.appProperties as Record<string, string>;
      file.version += 1;
      return respond({ kind: "drive#file", id: file.id, name: file.name }, 200, etagHeader(file));
    }
    if (method === "POST" && path === "/upload/drive/v3/files") {
      const upload = await readUpload(init.body);
      const created: FakeDriveFile = { id: `file-${++sequence}`, name: String(upload.metadata.name), parents: (upload.metadata.parents as string[] | undefined) ?? [], mimeType: String(upload.metadata.mimeType ?? "application/json"), content: upload.content, version: 1, appProperties: upload.metadata.appProperties as Record<string, string> | undefined };
      files.set(created.id, created);
      return respond({ id: created.id }, 200, etagHeader(created));
    }
    if (method === "POST" && path === "/drive/v3/files") {
      const body = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents?: string[] };
      const created: FakeDriveFile = { id: `folder-${++sequence}`, name: body.name, parents: body.parents ?? [], mimeType: body.mimeType, content: "", version: 1 };
      files.set(created.id, created);
      return respond({ id: created.id });
    }
    if (method === "DELETE" && target) {
      files.delete(decodeURIComponent(target[1]));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Google Drive request: ${method} ${url}`);
  }

  const find = (name: string): FakeDriveFile => {
    const found = [...files.values()].find((file) => file.name === name);
    if (!found) throw new Error(`The fake Drive has no file named ${name}.`);
    return found;
  };

  return {
    fetch: fetchDrive,
    files,
    requests,
    appFolderId,
    find,
    /** Another device replaced the content of a file. */
    externalWrite(name: string, content: string) { const file = find(name); file.content = content; file.version += 1; },
    /** The file changed on Drive without its content changing. */
    touch(name: string) { find(name).version += 1; },
    writes: (name: string) => requests.filter((request) => request.method === "PATCH" && request.url.pathname.endsWith(`/${find(name).id}`)),
    etagOf: (name: string) => etagOf(find(name)),
  };
}

export type FakeGoogleDrive = ReturnType<typeof createFakeGoogleDrive>;
