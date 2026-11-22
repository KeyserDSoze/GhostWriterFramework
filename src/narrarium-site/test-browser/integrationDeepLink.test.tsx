import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/drive/useSettings", () => ({
  useSettings: () => ({ load: async () => undefined, save: async () => undefined, resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }),
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));

import i18n from "@/i18n";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AIIntegration } from "@/types/settings";
import { AZURE, cardOf, showIntegrations } from "./helpers/integrationPage";
import { polyfillRadix } from "./helpers/radix";

const mine = (id: string, name: string): AIIntegration => ({ id, name, provider: "openai", endpoint: "https://gw.example.test/v1", apiKey: "k", chatModels: [{ id: `m-${id}`, name: "model", capabilities: ["default"] }] });
const FIRST = mine("first", "First");
const ODD = mine("team/ai:1", "Odd id");
const scrollIntoView = vi.fn();

beforeAll(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(async () => {
  cleanup();
  scrollIntoView.mockReset();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

const summaryOf = (card: HTMLElement) => card.querySelector("summary") as HTMLElement;

describe("the link to one integration", () => {
  it("gives every card an id made from the id of its integration, and no two cards the same one", async () => {
    await showIntegrations([FIRST, AZURE, ODD]);
    expect(cardOf("First").id).toBe("integration-first");
    expect(cardOf("Studio Azure").id).toBe("integration-az");
    expect(cardOf("Odd id").id).toBe("integration-team/ai:1");
    const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), "duplicate ids").toEqual([]);
  });

  it("opens the card the address names, brings it into view and gives the focus to its title: where a keyboard or a screen reader starts reading", async () => {
    await showIntegrations([FIRST, AZURE], "en", "/app/settings/ai-integrations#integration-az");
    await waitFor(() => expect(summaryOf(cardOf("Studio Azure"))).toHaveFocus());
    expect(cardOf("Studio Azure")).toHaveAttribute("open");
    expect(cardOf("First")).not.toHaveAttribute("open");
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("takes an id that has characters an address does not carry, written the way the panel of the autopilot writes it", async () => {
    await showIntegrations([FIRST, ODD], "en", `/app/settings/ai-integrations#integration-${encodeURIComponent("team/ai:1")}`);
    await waitFor(() => expect(summaryOf(cardOf("Odd id"))).toHaveFocus());
    expect(cardOf("Odd id")).toHaveAttribute("open");
  });

  it("leaves every card closed and takes no focus when no address names one, when it names something else, or when it names an integration that is not there", async () => {
    for (const path of ["/app/settings/ai-integrations", "/app/settings/ai-integrations#tools-only", "/app/settings/ai-integrations#integration-ghost"]) {
      await showIntegrations([FIRST, AZURE], "en", path);
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const name of ["First", "Studio Azure"]) {
        expect(cardOf(name), path).not.toHaveAttribute("open");
        expect(summaryOf(cardOf(name)), path).not.toHaveFocus();
      }
      cleanup();
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
