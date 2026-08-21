import { expect, test } from "@playwright/test";

const configuredBase = process.env.SITE_BASE
  ?? (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY
    ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
    : "/");
const basePath = configuredBase.replace(/\/+$/, "") || "";

test("public documentation route opens from the production preview", async ({ page }) => {
  await page.goto("docs");

  await expect(page).toHaveURL(new RegExp(`${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/docs\/?$`));
  await expect(page.getByRole("heading", { name: "Narrarium docs" })).toBeVisible();
});

test("installed application shell and lazy assets remain available offline", async ({ page, context }) => {
  await page.goto(".");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((key) => key.startsWith("narrarium-precache-")))).toBe(true);
  await context.setOffline(true);
  try {
    await page.goto("docs", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Narrarium docs" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
