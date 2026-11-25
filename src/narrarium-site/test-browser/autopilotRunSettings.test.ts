import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRequest } from "narrarium-engine";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { resetSettingsForRun, settingsForRun } from "@/autopilot/savedAiSettings";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { noteAiSettingsSaved, resetAiSettingsBaseline } from "@/store/aiSettingsBaseline";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, textReply } from "./helpers/fakeProvider";
import { compatible, endpointsOf, GITHUB_TOKEN, routed, type Fixture } from "./helpers/aiFixtures";

// What a run asks its models with. Every tab keeps its own copy of the settings; what is saved lives on the device. A change of the router applies to the next call of the run of the tab where it is
// made, saved or not; a routing that another tab saved reaches the run of a tab that did not touch its own; and a page that ends sends nothing to the fallback of the call it cut.

const saved = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/account/accountLocalStore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/account/accountLocalStore")>()), loadSavedSettings: (since?: string) => saved.read(since) }));

const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const hostOf = (url: string) => new URL(url).hostname.replace(".example.test", "");

const a = compatible("a");
const b = compatible("b");

/** The device holds `settings` as snapshot `id`: what the store answers when asked, and nothing when it is asked for what it has already given. */
function device(settings: AppSettings | null, id = "snapshot-1") {
  saved.read.mockImplementation(async (since?: string) => (settings ? { snapshotId: id, settings: since === id ? null : settings } : null));
}

beforeEach(() => {
  saved.read.mockReset();
  resetSettingsForRun();
  resetAiSettingsBaseline();
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.dispatchEvent(new Event("pageshow"));
  setFallbackAcknowledgementAccountScope(null);
  assertProvidersClean();
});

describe("the settings of a run", () => {
  it("are the settings of the tab while the tab has loaded nothing from the device, and the device is not asked", async () => {
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    device(routed([b, a]));
    expect(await settingsForRun()).toBe(memory);
    expect(saved.read).not.toHaveBeenCalled();
  });

  it("are the settings of the tab when the device holds what the tab loaded", async () => {
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    device(routed([a, b]));
    expect(await settingsForRun()).toBe(memory);
  });

  it("take the routing that another tab saved when this tab did not touch its own, and keep the rest of the tab's settings and its keys", async () => {
    const memory: AppSettings = { ...routed([a, b]), ui: { language: "it", theme: "dark" } };
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    // The other tab saved the swap, and an integration of it has no key in the copy it saved.
    const other = routed([b, a]);
    other.aiIntegrations = other.aiIntegrations.map((entry) => (entry.id === "a" ? { ...entry, apiKey: "" } : entry));
    device({ ...other, ui: { language: "en", theme: "light" } });
    const used = await settingsForRun();
    expect(used.taskRouting?.autopilot?.primary?.integrationId).toBe("b");
    expect(used.ui, "only what decides the model is taken").toEqual({ language: "it", theme: "dark" });
    expect(used.aiIntegrations.find((entry) => entry.id === "a")?.apiKey, "a key the tab has and the saved copy has not is kept").toBe(a.integration.apiKey);
    expect(useSettingsStore.getState().settings, "the settings of the tab are not touched: its page is not changed under the author's hands").toBe(memory);
  });

  it("keep taking it for every call while it is the saved one, and read the device again only when the snapshot changed", async () => {
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    device(routed([b, a]), "snapshot-2");
    expect((await settingsForRun()).taskRouting?.autopilot?.primary?.integrationId).toBe("b");
    expect((await settingsForRun()).taskRouting?.autopilot?.primary?.integrationId, "the store said it had nothing newer: the routing read before stands").toBe("b");
    expect(saved.read.mock.calls.map(([since]) => since)).toEqual([undefined, "snapshot-2"]);
    device(routed([a, b]), "snapshot-3");
    expect((await settingsForRun()).taskRouting?.autopilot?.primary?.integrationId, "a routing saved back is the one of the tab again").toBe("a");
  });

  it("are the tab's own the moment its author changes the routing here, saved or not: what the author sees is what the next call uses", async () => {
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    device(routed([b, a]));
    expect((await settingsForRun()).taskRouting?.autopilot?.primary?.integrationId).toBe("b");
    const edited = routed([a, b], { routingExecution: { ...memory.routingExecution, maxTotalDurationMs: 42_000 } });
    useSettingsStore.setState({ settings: edited });
    expect(await settingsForRun()).toBe(edited);
    expect(saved.read).toHaveBeenCalledTimes(1);
  });

  it("are the tab's own when the device cannot be read", async () => {
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    device(null);
    expect(await settingsForRun()).toBe(memory);
  });
});

describe("the browser's AI port for a run", () => {
  function provide(fixtures: Fixture[], reply = () => textReply("A scene.")) {
    const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
    vi.stubGlobal("fetch", fake.fetch);
    return fake;
  }

  it("asks the primary that another tab saved after this one loaded, on its next call", async () => {
    const fake = provide([a, b]);
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    device(routed([a, b]));
    await createBrowserAi().complete(ASK);
    device(routed([b, a]), "snapshot-2");
    await createBrowserAi().complete(ASK);
    expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a", "b"]);
  });

  it("is made with the settings the caller brings, and the device is not asked", async () => {
    const fake = provide([a, b]);
    useSettingsStore.setState({ settings: routed([a, b]) });
    noteAiSettingsSaved(routed([a, b]));
    device(routed([b, a]));
    await createBrowserAi({ settings: routed([a, b]) }).complete(ASK);
    expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a"]);
    expect(saved.read).not.toHaveBeenCalled();
  });

  it("goes on with the settings of the tab when the code that reads the device fails", async () => {
    const fake = provide([a, b]);
    const memory = routed([a, b]);
    useSettingsStore.setState({ settings: memory });
    noteAiSettingsSaved(memory);
    saved.read.mockRejectedValue(new Error("the device is not readable"));
    await createBrowserAi().complete(ASK);
    expect(fake.calls.map((call) => hostOf(call.url))).toEqual(["a"]);
  });

  it("sends nothing to the fallback when the page ends under the request: the browser cut it, the provider did not fail", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(hostOf(String(input)));
      if (calls.length === 1) {
        // What the browser does to the requests of a page that ends: the page hears of it first, and the request fails after.
        window.dispatchEvent(new Event("pagehide"));
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "A scene." }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    useSettingsStore.setState({ settings: routed([a, b]) });
    await expect(createBrowserAi({ settings: routed([a, b]) }).complete(ASK)).rejects.toThrow();
    expect(calls, "the prompt went to the primary alone").toEqual(["a"]);
    expect(useLlmDebugStore.getState().pending, "the attempt that was cut was closed").toBe(0);
  });

  it("asks the fallback as always when the request failed and the page did not end", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(hostOf(String(input)));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ choices: [{ message: { content: "A scene." }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const response = await createBrowserAi({ settings: routed([a, b]) }).complete(ASK);
    expect(response.text).toBe("A scene.");
    expect(calls).toEqual(["a", "b"]);
  });
});
