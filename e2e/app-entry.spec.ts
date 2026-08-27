import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const configuredBase = process.env.SITE_BASE
  ?? (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY
    ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
    : "/");
const basePath = configuredBase.replace(/\/+$/, "") || "";

async function waitForServiceWorker(page: Page, context: BrowserContext): Promise<void> {
  const errors: string[] = [];
  const session = await context.newCDPSession(page);
  session.on("ServiceWorker.workerErrorReported", (event) => errors.push(event.errorMessage ?? JSON.stringify(event)));
  await session.send("ServiceWorker.enable");
  try {
    await expect.poll(async () => page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistrations())[0];
      return registration?.active?.state ?? registration?.waiting?.state ?? registration?.installing?.state ?? "missing";
    }).catch(() => "navigating"), { timeout: 15000, message: `Service worker did not activate: ${errors.join(" | ")}` }).toBe("activated");
  } finally {
    await session.detach();
  }
}

test("public documentation route opens from the production preview", async ({ page }) => {
  const response = await page.goto("docs");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/docs\/?$`));
  await expect(page.getByRole("heading", { name: "Narrarium docs" })).toBeVisible();
});

test("installed application shell and lazy assets remain available offline", async ({ page, context }) => {
  await page.addInitScript(() => { void caches.open("unrelated-origin-cache"); });
  await page.goto(".");
  await waitForServiceWorker(page, context);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)).catch(() => false)).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((key) => key.startsWith("narrarium-precache-"))).catch(() => false)).toBe(true);
  const releaseState = await page.evaluate(async () => ({
    controllerVersion: new URL(navigator.serviceWorker.controller!.scriptURL).searchParams.get("v"),
    cacheKeys: await caches.keys(),
    cachedUrls: await caches.open(`narrarium-precache-${new URL(navigator.serviceWorker.controller!.scriptURL).searchParams.get("v")}`).then(async (cache) => (await cache.keys()).map((request) => request.url)),
  }));
  expect(releaseState.cacheKeys).toContain(`narrarium-precache-${releaseState.controllerVersion}`);
  expect(releaseState.cacheKeys).toContain("unrelated-origin-cache");
  expect(releaseState.cachedUrls.some((url) => /\/assets\/PublicDocs-[^/]+\.js$/.test(url))).toBe(true);
  expect(releaseState.cachedUrls.filter((url) => /\/assets\/(?:AuthProviders|LoginScreen|msal|ai-vendor|github|zip|repository|AppShell|Assistant|BookExport|pdfFonts|jspdf)/i.test(url))).toEqual([]);
  await page.waitForLoadState("domcontentloaded");
  await context.setOffline(true);
  try {
    await page.goto("docs", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Narrarium docs" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("authenticated entry can warm its PWA shell without optional feature transfer", async ({ page, context }) => {
  await page.goto(".");
  await waitForServiceWorker(page, context);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); navigator.serviceWorker.controller!.postMessage({ type: "CACHE_APP_SHELL_ASSETS" }, [channel.port2]); }));
  await expect.poll(() => page.evaluate(async () => {
    const version = new URL(navigator.serviceWorker.controller!.scriptURL).searchParams.get("v");
    const urls = await caches.open(`narrarium-precache-${version}`).then(async (cache) => (await cache.keys()).map((request) => request.url));
    return urls.some((url) => /\/assets\/AppShellRoute-[^/]+\.js$/.test(url)) && urls.some((url) => /\/assets\/BooksPage-[^/]+\.js$/.test(url)) && !urls.some((url) => /\/assets\/(?:zip-vendor|BookExport|pdfFonts|jspdf)[^/]*\.js$/.test(url));
  })).toBe(true);
});
