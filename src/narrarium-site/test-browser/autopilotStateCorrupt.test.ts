import { beforeAll, describe, expect, it } from "vitest";
import { AutopilotStateCorruptError, ServerRequestError } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { describeAutopilotError } from "@/autopilot/runtime";

const DAMAGED = { path: "autopilot/state.json", reason: "it contains unresolved merge conflict markers" };

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe("a damaged autopilot state", () => {
  it.each(["en", "it"])("is explained in %s, whichever host raised it", async (language) => {
    await i18n.changeLanguage(language);
    const expected = i18n.t("autopilot.errors.stateCorrupt");
    expect(expected).not.toBe("autopilot.errors.stateCorrupt");
    expect(expected).toContain("autopilot/state.json");
    // The browser's engine raises the typed error; the personal server answers 409 with the same code.
    expect(describeAutopilotError(new AutopilotStateCorruptError(DAMAGED))).toBe(expected);
    expect(describeAutopilotError(new ServerRequestError("The autopilot state file is damaged.", 409, "state_corrupt"))).toBe(expected);
  });

  it("does not hide other errors behind that message", async () => {
    await i18n.changeLanguage("en");
    expect(describeAutopilotError(new ServerRequestError("Nope", 409, "conflict"))).not.toBe(i18n.t("autopilot.errors.stateCorrupt"));
    expect(describeAutopilotError(new Error("plain"))).toBe("plain");
  });
});
