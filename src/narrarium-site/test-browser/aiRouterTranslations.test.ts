import { expect, test } from "vitest";
import i18n from "@/i18n";

test("the texts of the AI Router tables are not in the app entry: they arrive with the view that shows them", async () => {
  expect(i18n.exists("routing.table.task", { lng: "en" })).toBe(false);
  expect(i18n.exists("routing.bulk.help", { lng: "it" })).toBe(false);
  expect(i18n.t("routing.task.default", { lng: "en" })).toBe("Chat (default)");

  await import("@/components/settings/router/RouterSections");

  expect(i18n.t("routing.table.task", { lng: "en" })).toBe("Task");
  expect(i18n.t("routing.table.task", { lng: "it" })).toBe("Attività");
  expect(i18n.t("routing.options.title", { lng: "it" })).toBe("Opzioni di instradamento");
  expect(i18n.t("routing.undo", { lng: "en" })).toBe("Undo");
});

test("adding the texts of the tables keeps the routing texts the entry already has", async () => {
  await import("@/components/settings/router/RouterSections");

  expect(i18n.t("routing.task.default", { lng: "it" })).toBe("Chat (predefinito)");
  expect(i18n.t("routing.title", { lng: "it" })).toBe("Routing dei task");
  expect(i18n.t("routing.description", { lng: "en" })).toMatch(/^One table per kind of task/);
});
