import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function requestedScripts(page: Page, path: string): Promise<string[]> {
  const scripts: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(page.url() || "http://127.0.0.1:4173").origin && url.pathname.endsWith(".js")) scripts.push(url.pathname);
  });
  await page.goto(path, { waitUntil: "networkidle" });
  return [...new Set(scripts)].sort();
}

/** The name of a chunk without its content hash: a hash can spell anything (one read «ZIP»), and only the name says what the chunk holds. */
const chunkName = (script: string) => script.replace(/-[A-Za-z0-9_-]{8}\.js$/, ".js");

function expectNoFeatureChunks(scripts: string[], forbidden: RegExp): void {
  expect(scripts.filter((script) => forbidden.test(chunkName(script)))).toEqual([]);
}

test("the public home loads only the core and lightweight home route", async ({ page }) => {
  const scripts = await requestedScripts(page, ".");
  await expect(page.locator('[data-route-ready="HomePage"]')).toBeAttached();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expectNoFeatureChunks(scripts, /AuthProviders|LoginScreen|msal|PublicDocs|docs-|safeMarkdown|ai-vendor|github|zip|repository|AppShell|Assistant|BookExport|pdfFonts|jspdf/i);
});

test("public docs load documentation but no authenticated feature graph", async ({ page }) => {
  const scripts = await requestedScripts(page, "docs");
  await expect(page.locator('[data-route-ready="DocsIndexPage"]')).toBeAttached();
  await expect(page.getByRole("heading", { name: "Narrarium docs" })).toBeVisible();
  expect(scripts.some((script) => /PublicDocs|docs-|safeMarkdown/i.test(script))).toBe(true);
  expectNoFeatureChunks(scripts, /AuthProviders|LoginScreen|msal|ai-vendor|github|zip|repository|AppShell|Assistant|BookExport|pdfFonts|jspdf/i);
});

test("login loads OAuth without AI, GitHub, ZIP, editor, or repository chunks", async ({ page }) => {
  const scripts = await requestedScripts(page, "login");
  await expect(page.locator('[data-route-ready="LoginScreen"]')).toBeAttached();
  await expect(page.getByRole("heading", { name: /connect a service|collega un servizio/i })).toBeVisible();
  expect(scripts.some((script) => /AuthProviders|LoginScreen|msal/i.test(script))).toBe(true);
  expectNoFeatureChunks(scripts, /ai-vendor|github|zip|repository|AppShell|AssistantPanel|Workspace|ParagraphPage|BookExport|pdfFonts|jspdf/i);
});

test("all finite public routes render after direct navigation", async ({ page }) => {
  for (const [route, componentName, heading] of [["privacy", "PrivacyPage"], ["terms", "TermsPage"], ["mcp", "McpPage"], ["docs/dependency-security", "DocPage", "Dependency security policy"]]) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator(`[data-route-ready="${componentName}"]`)).toBeAttached();
    if (heading) await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await expect(page.locator("body")).not.toBeEmpty();
  }
});
