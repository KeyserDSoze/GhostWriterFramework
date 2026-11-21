import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import type { ServerAddressProblem } from "@/autopilot/serverAddress";
import type { ServerIdentityFailure } from "@/autopilot/serverIdentity";

const ADDRESS_PROBLEMS: ServerAddressProblem[] = ["empty", "invalid", "scheme", "credentials", "host", "insecure"];
const IDENTITY_FAILURES: ServerIdentityFailure[] = ["changed", "invalid", "unpinned", "unsupported"];

const KEYS = [
  ...ADDRESS_PROBLEMS.map((reason) => `personalServer.address.${reason}`),
  ...IDENTITY_FAILURES.map((reason) => `personalServer.identity.${reason}`),
  "personalServer.sendAiBlocked",
  "personalServer.disconnectUnrevoked.title",
  "personalServer.disconnectUnrevoked.body",
  "autopilot.where.serverUnverified",
  "director.changedElsewhere",
  "director.reloadFile",
  "ghostwriters.changedElsewhere",
  "ghostwriters.reloadFile",
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

describe("texts of the personal server, director and ghostwriter safeguards", () => {
  it.each(["en", "it"])("every new message exists in %s", (lng) => {
    for (const key of KEYS) {
      expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
      expect(i18n.t(key, { lng }), `${key} (${lng})`).not.toBe(key);
    }
  });

  it("is translated into Italian, not copied from English", () => {
    for (const key of KEYS) {
      expect(i18n.t(key, { lng: "it" }), key).not.toBe(i18n.t(key, { lng: "en" }));
    }
  });

  it("tells the author where to press when the server was never verified", () => {
    for (const lng of ["en", "it"]) {
      expect(i18n.t("personalServer.identity.unpinned", { lng })).toContain(i18n.t("personalServer.test", { lng }));
      expect(i18n.t("personalServer.sendAiBlocked", { lng })).toContain(i18n.t("personalServer.test", { lng }));
    }
  });
});
