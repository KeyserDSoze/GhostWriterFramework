import { expect, test, type Page, type Route } from "@playwright/test";

// Signing in to Google Drive from Account & Sync, with Google out of reach: the permissions the sign-in window asks for never include the restricted
// `drive` scope, and once the first sync has gone through the card says «All synced» and offers «Check now» instead of a main «Sync» button.

test.use({ serviceWorkers: "block" });

const FOLDER = "application/vnd.google-apps.folder";
const GSI_STUB = `
window.__gsi = { inits: [], requests: [] };
window.google = { accounts: { oauth2: {
  initTokenClient(config) {
    window.__gsi.inits.push({ method: "initTokenClient", scope: config.scope });
    return { requestAccessToken() { window.__gsi.requests.push({ method: "implicit", scope: config.scope }); setTimeout(() => config.callback({ access_token: "e2e-google-access", expires_in: 3600, scope: config.scope, token_type: "Bearer" }), 0); } };
  },
  initCodeClient(config) {
    window.__gsi.inits.push({ method: "initCodeClient", scope: config.scope });
    return { requestCode() { window.__gsi.requests.push({ method: "code", scope: config.scope }); } };
  },
} } };
`;

interface DriveFile { id: string; name: string; parents: string[]; mimeType: string; content?: string; version: number; appProperties?: Record<string, string> }

/** A small Google Drive that keeps the files the app writes, so a first sync can go through: a folder, then `account-data.json` and `manifest.json` in it. */
async function stubGoogle(page: Page): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  const files = new Map<string, DriveFile>();
  let counter = 0;
  const describe = (file: DriveFile) => ({ id: file.id, name: file.name, parents: file.parents, mimeType: file.mimeType, version: String(file.version), createdTime: "2026-11-27T08:00:00.000Z", ownedByMe: true, trashed: false, appProperties: file.appProperties });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search ? "?…" : ""}`);
    if (url.pathname === "/oauth2/v3/userinfo") return json(route, { sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" });
    if (url.pathname === "/drive/v3/about") return json(route, { user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } });
    if (url.pathname === "/drive/v3/files/root") return json(route, { id: "root-id" });
    if (url.pathname === "/upload/drive/v3/files" && request.method() === "POST") {
      const body = request.postData() ?? "";
      const metadata = JSON.parse(/Content-Type: application\/json[^\r\n]*\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(body)?.[1] ?? "{}") as { name: string; parents: string[] };
      const parts = body.split(/\r?\n--[^\r\n]+/).filter((part) => /Content-Type/i.test(part));
      const content = (parts[1] ?? "").replace(/^[\s\S]*?\r?\n\r?\n/, "").replace(/\r?\n$/, "");
      const file: DriveFile = { id: `file-${++counter}`, name: metadata.name, parents: metadata.parents, mimeType: "application/json", content, version: 1 };
      files.set(file.id, file);
      return json(route, { id: file.id });
    }
    if (url.pathname.startsWith("/upload/drive/v3/files/") && request.method() === "PATCH") {
      const file = files.get(decodeURIComponent(url.pathname.split("/").pop()!));
      if (!file) return json(route, {}, 404);
      file.content = request.postData() ?? "";
      file.version += 1;
      return json(route, { id: file.id });
    }
    if (url.pathname === "/drive/v3/files" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { name: string; mimeType: string; appProperties?: Record<string, string> };
      const file: DriveFile = { id: `folder-${++counter}`, name: body.name, parents: ["root-id"], mimeType: body.mimeType, version: 1, appProperties: body.appProperties };
      files.set(file.id, file);
      return json(route, describe(file));
    }
    if (url.pathname === "/drive/v3/files" && request.method() === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const name = /name='([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const wantsFolder = q.includes(`mimeType='${FOLDER}'`);
      const marked = q.includes("appProperties has");
      const matches = [...files.values()].filter((file) => (!name || file.name === name) && (!parent || file.parents.includes(parent === "root" ? "root-id" : parent)) && (!wantsFolder || file.mimeType === FOLDER) && (!marked || file.appProperties));
      return json(route, { files: matches.map(describe) });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const file = files.get(decodeURIComponent(one[1]));
      if (!file) return json(route, {}, 404);
      if (request.method() === "DELETE") { files.delete(file.id); return route.fulfill({ status: 204 }); }
      if (request.method() === "PATCH") { Object.assign(file, { appProperties: { ...file.appProperties, ...(JSON.parse(request.postData() ?? "{}") as { appProperties?: Record<string, string> }).appProperties } }); return json(route, describe(file)); }
      if (url.searchParams.get("alt") === "media") return route.fulfill({ status: 200, contentType: "application/json", body: file.content ?? "null" });
      return json(route, describe(file));
    }
    return json(route, {}, 404);
  });
  return { requests };
}

test("signing in to Google Drive asks for no restricted scope, and the card says All synced after the first sync", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The welcome tour opens a modal a moment after the page loads on a slow machine, and a modal makes the rest of the page unreachable by role: it is seen already.
  await page.addInitScript(() => localStorage.setItem("narrarium-onboarding-completed", "1"));
  await page.route("https://accounts.google.com/gsi/client", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: GSI_STUB }));
  await page.route(/\/oauth\/status/, (route) => route.abort());
  const google = await stubGoogle(page);

  await page.goto("app/account-sync");
  const card = page.getByRole("heading", { name: "Google Drive" }).locator("xpath=ancestor::*[contains(@class,'rounded-lg')][1]");
  await expect(page.getByTestId("auto-sync-all")).toBeVisible();
  await card.getByRole("button", { name: "Connect" }).click();

  // The permissions asked in the sign-in window: identity and the two non-sensitive Drive ones, never the restricted `drive`.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gsi: { requests: unknown[] } }).__gsi.requests.length)).toBeGreaterThan(0);
  const gsi = await page.evaluate(() => (window as unknown as { __gsi: { inits: Array<{ scope: string }>; requests: Array<{ scope: string }> } }).__gsi);
  for (const { scope } of [...gsi.inits, ...gsi.requests]) {
    const scopes = scope.split(/\s+/);
    expect(scopes).toEqual(expect.arrayContaining(["openid", "profile", "email", "https://www.googleapis.com/auth/drive.appdata", "https://www.googleapis.com/auth/drive.file"]));
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive");
    expect(scopes.filter((item) => /\/auth\/drive$/.test(item))).toEqual([]);
  }

  // The first sync has gone through: nothing waits, so the card says so and the main button is not «Sync».
  const state = card.getByTestId("sync-state");
  await expect(state).toHaveAttribute("data-state", "all-synced", { timeout: 30_000 });
  await expect(state).toContainText(/All synced · last check/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Sync", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Check now" })).toBeVisible();
  await expect(card.getByText("Follows the general setting, which is on.")).toBeVisible();
  expect(google.requests.some((line) => line.includes("/drive/v3/files"))).toBe(true);
  expect(pageErrors).toEqual([]);

  // The general switch is at the top and turns the automatic sync off for the service that follows it.
  const general = page.getByTestId("auto-sync-all").getByRole("switch", { name: "Automatic sync for all services" });
  await expect(general).toBeChecked();
  await general.click();
  await expect(card.getByText("Follows the general setting, which is off.")).toBeVisible();
  await expect(card.getByTestId("sync-state")).toContainText(/Automatic sync is off for this service/);
});
