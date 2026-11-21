import { matchRoutes } from "react-router-dom";
import { afterAll, describe, expect, test } from "vitest";
import { router } from "@/router";

afterAll(() => router.dispose());

function routePath(pathname: string): string | undefined {
  const matches = matchRoutes(router.routes, pathname);
  return matches?.[matches.length - 1]?.route.path;
}

describe("the settings routes", () => {
  test.each(["/app/settings/ai-integrations", "/app/settings/ai-router"])("%s is a registered page, not the not-found fallback", (pathname) => {
    expect(routePath(pathname)).toBe(pathname.replace("/app/", ""));
  });

  test("the old AI Router address keeps working next to the new one", () => {
    const paths = ["/app/settings", "/app/settings/ai-integrations", "/app/settings/ai-router", "/app/settings/deep-search"].map(routePath);
    expect(paths).toEqual(["settings", "settings/ai-integrations", "settings/ai-router", "settings/deep-search"]);
  });

  test("an unknown settings page is still the in-app not-found page", () => {
    expect(routePath("/app/settings/ai-integration")).toBe("*");
  });
});
