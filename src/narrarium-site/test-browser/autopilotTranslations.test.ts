import { expect, test } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations, withAutopilotTranslations } from "@/i18n/autopilot";

test("autopilot texts are added to the app translations when their views load", async () => {
  expect(i18n.exists("autopilot.dockTitle")).toBe(false);
  expect(i18n.t("autopilot.title")).toBe("Autopilot");

  const module = await withAutopilotTranslations(async () => ({ view: "loaded" }))();
  expect(module.view).toBe("loaded");
  expect(i18n.t("autopilot.dockTitle", { lng: "en" })).toBe("Autopilot live");
  expect(i18n.t("autopilot.dockTitle", { lng: "it" })).toBe("Autopilot in diretta");
  expect(i18n.t("director.ask.action", { lng: "it" })).toBe("Chiedi al direttore");

  await loadAutopilotTranslations();
  expect(i18n.t("autopilot.title", { lng: "it" })).toBe("Autopilot");
});
