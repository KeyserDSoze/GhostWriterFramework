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
