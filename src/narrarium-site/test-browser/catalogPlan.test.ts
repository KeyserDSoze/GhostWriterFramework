import { describe, expect, it } from "vitest";
import { parseModelDetails } from "narrarium-engine";
import { CATALOG_KINDS, applyChoices, currentMedia, defaultChoices, fillOf, groupCatalog, kindOfEntry, thinkingSuggestion, type CatalogChoices } from "@/ai/catalogPlan";
import type { AIIntegration, ChatModel } from "@/types/settings";
import { OWNER_DETAILS } from "./helpers/llmProxyFakes";

const ALL = { models: true, details: true, modalities: true } as const;
const NONE = { models: true, details: false, modalities: false } as const;
const MODALITIES_ONLY = { models: true, details: false, modalities: true } as const;
const TEMPLATE = "chat_template_kwargs.reasoning_strength";

/** The entries as the engine reads the owner's gateway: the same objects the dialog is given. */
const entries = parseModelDetails(OWNER_DETAILS);
const entry = (id: string) => entries.find((candidate) => candidate.id === id)!;
const catalog = { models: entries, source: ALL };

const model = (name: string, extra: Partial<ChatModel> = {}): ChatModel => ({ id: `id-${name}`, name, capabilities: [], ...extra });
const integration = (models: ChatModel[] = [], extra: Partial<AIIntegration> = {}): AIIntegration => ({ id: "gw", name: "LlmProxy", provider: "openai", endpoint: "https://gw.example.test/v1", apiKey: "sk-gw-0123456789abcdef", chatModels: models, ...extra });
const choose = (models: string[], extra: Partial<CatalogChoices> = {}): CatalogChoices => ({ models: new Set(models), thinking: new Set(), media: {}, ...extra });
const sequence = () => { let count = 0; return () => `new-${(count += 1)}`; };
const names = (models: ChatModel[] | undefined) => (models ?? []).map((entryModel) => entryModel.name);

describe("the kinds of the models an endpoint lists", () => {
  it("are text for the chat models, and one group of their own for each other kind a gateway tells apart", () => {
    expect(CATALOG_KINDS).toEqual(["text", "image", "speech", "transcription", "embedding", "other"]);
    expect(entries.map((entryModel) => [entryModel.id, kindOfEntry(entryModel, ALL)])).toEqual([
      ["muse-glimmer-30b", "text"], ["legacy-8b", "text"], ["bge-m3", "embedding"], ["flux-schnell", "image"], ["kokoro", "speech"], ["whisper-large", "transcription"],
    ]);
  });

  it("are «other» for realtime models, classifiers, and a model that only /models listed once the gateway has told the kinds of the others", () => {
    expect(kindOfEntry({ type: "realtime" }, ALL)).toBe("other");
    expect(kindOfEntry({ type: "classifier" }, ALL)).toBe("other");
    expect(kindOfEntry({ type: "unknown" }, ALL)).toBe("other");
    expect(kindOfEntry({ type: "unknown" }, MODALITIES_ONLY)).toBe("other");
  });

  it("are text for every model when no companion was read, because the endpoint did not say what they are: as BookWriter takes them all for chat models", () => {
    expect(kindOfEntry({ type: "unknown" }, NONE)).toBe("text");
  });

  it("are listed in a fixed order, in the order the endpoint gave them within a group, and a group with no model is left out", () => {
    const groups = groupCatalog(catalog);
    expect(groups.map((group) => group.kind)).toEqual(["text", "image", "speech", "transcription", "embedding"]);
    expect(groups[0].entries.map((entryModel) => entryModel.id)).toEqual(["muse-glimmer-30b", "legacy-8b"]);
    expect(groupCatalog({ models: [], source: ALL })).toEqual([]);
  });

  it("put every model among the text ones when only /models was read", () => {
    const bare = entries.map((entryModel) => ({ id: entryModel.id, type: "unknown" as const, capabilities: {} }));
    const groups = groupCatalog({ models: bare, source: NONE });
    expect(groups.map((group) => group.kind)).toEqual(["text"]);
    expect(groups[0].entries).toHaveLength(6);
  });
});

describe("what an endpoint can add to a model that the author already has", () => {
  it("is everything the gateway declares, for a model that says nothing", () => {
    expect(fillOf(model("muse-glimmer-30b"), entry("muse-glimmer-30b"))).toEqual({
      maxInputTokens: 131072, maxOutputTokens: 8192, supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true,
    });
  });

  it("leaves the numbers the author wrote, and fills the fields that are empty one by one", () => {
    const written = model("muse-glimmer-30b", { maxInputTokens: 32768, maxOutputTokens: 4096 });
    expect(fillOf(written, entry("muse-glimmer-30b"))).toEqual({ supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true });
    const half = model("muse-glimmer-30b", { maxOutputTokens: 2048 });
    expect(fillOf(half, entry("muse-glimmer-30b"))).toMatchObject({ maxInputTokens: 131072, supportsReasoning: true });
    expect(fillOf(half, entry("muse-glimmer-30b"))).not.toHaveProperty("maxOutputTokens");
  });

  it("leaves a capability the author set, a switch turned off included: what is written is never turned over", () => {
    const written = model("muse-glimmer-30b", { supportsToolCalls: false, supportsStreaming: false, supportsReasoning: true });
    const fill = fillOf(written, entry("muse-glimmer-30b"));
    for (const key of ["supportsToolCalls", "supportsStreaming", "supportsReasoning"]) expect(fill, key).not.toHaveProperty(key);
    expect(fill).toEqual({ maxInputTokens: 131072, maxOutputTokens: 8192, supportsVision: true });
  });

  it("is nothing for what the gateway does not declare: a false is not a restriction, and a null is not a number", () => {
    expect(fillOf(model("legacy-8b"), entry("legacy-8b"))).toEqual({});
  });
});

describe("what happens to the models of the integration when the author confirms", () => {
  it("adds the selected new models after the ones the author has, in the order of the catalog, and not the others", () => {
    const outcome = applyChoices(integration([model("old")]), catalog, choose(["legacy-8b", "muse-glimmer-30b"]), sequence());
    expect(names(outcome.patch.chatModels)).toEqual(["old", "muse-glimmer-30b", "legacy-8b"]);
    expect(outcome.added).toEqual(["muse-glimmer-30b", "legacy-8b"]);
    expect(outcome.updated).toEqual([]);
    expect(names(applyChoices(integration(), catalog, choose([]), sequence()).patch.chatModels)).toEqual([]);
  });

  it("gives a new model what the gateway declares of it, and nothing that it does not", () => {
    const { chatModels } = applyChoices(integration(), catalog, choose(["muse-glimmer-30b", "legacy-8b"]), sequence()).patch;
    expect(chatModels![0]).toMatchObject({ id: "new-1", name: "muse-glimmer-30b", maxInputTokens: 131072, maxOutputTokens: 8192, supportsToolCalls: true, supportsStreaming: true, supportsReasoning: true, supportsVision: true });
    for (const key of ["maxInputTokens", "maxOutputTokens", "supportsToolCalls", "supportsStreaming", "supportsReasoning", "supportsVision", "reasoningParameter", "pricing", "underlyingModel"]) expect(chatModels![1], key).not.toHaveProperty(key);
  });

  it("gives the default roles to the first new model of an integration that has no model, as every other way of adding a model does, and none to the others", () => {
    const outcome = applyChoices(integration(), catalog, choose(["muse-glimmer-30b", "legacy-8b"]), sequence());
    expect(outcome.patch.chatModels![0].capabilities).toEqual(["default", "copilot", "simple-tasks", "review"]);
    expect(outcome.patch.chatModels![1].capabilities).toEqual([]);
    expect(outcome.defaulted).toBe("muse-glimmer-30b");
  });

  it("gives them to the new model that declares tool calls rather than to the first one: the autopilot answers through tools, and the models stay in the order of the catalog", () => {
    const reversed = { models: [entry("legacy-8b"), entry("muse-glimmer-30b")], source: ALL };
    const outcome = applyChoices(integration(), reversed, choose(["legacy-8b", "muse-glimmer-30b"]), sequence());
    expect(names(outcome.patch.chatModels)).toEqual(["legacy-8b", "muse-glimmer-30b"]);
    expect(outcome.patch.chatModels![0].capabilities).toEqual([]);
    expect(outcome.patch.chatModels![1].capabilities).toEqual(["default", "copilot", "simple-tasks", "review"]);
    expect(outcome.defaulted).toBe("muse-glimmer-30b");
    const none = applyChoices(integration(), { models: [entry("legacy-8b")], source: ALL }, choose(["legacy-8b"]), sequence());
    expect(none.patch.chatModels![0].capabilities, "when none declares tools, the first takes them").toEqual(["default", "copilot", "simple-tasks", "review"]);
  });

  it("gives no role to the new models of an integration that already has models, whatever roles those have: the roles the author gave are a decision, not a gap", () => {
    for (const roles of [["default"], ["review"], []] as const) {
      const outcome = applyChoices(integration([model("mine", { capabilities: [...roles] })]), catalog, choose(["muse-glimmer-30b"]), sequence());
      expect(outcome.patch.chatModels![1].capabilities, roles.join() || "no role").toEqual([]);
      expect(outcome.defaulted).toBeUndefined();
    }
  });

  it("does not give the default roles to the first model it adds when the only models that were chosen are ones the author already has", () => {
    const outcome = applyChoices(integration(), catalog, choose([]), sequence());
    expect(outcome.defaulted).toBeUndefined();
  });

  it("sets the suggested thinking parameter only on the new models that were chosen for it, and only where the engine suggests one", () => {
    const both = choose(["muse-glimmer-30b", "legacy-8b"], { thinking: new Set(["muse-glimmer-30b", "legacy-8b"]) });
    const { chatModels } = applyChoices(integration(), catalog, both, sequence()).patch;
    expect(chatModels![0].reasoningParameter).toBe(TEMPLATE);
    expect(chatModels![1]).not.toHaveProperty("reasoningParameter");
    const unticked = applyChoices(integration(), catalog, choose(["muse-glimmer-30b"]), sequence()).patch.chatModels!;
    expect(unticked[0]).not.toHaveProperty("reasoningParameter");
  });

  it("updates a model the author has by filling what is empty, and keeps everything else as it was", () => {
    const mine = model("muse-glimmer-30b", { capabilities: ["review"], maxInputTokens: 32768, supportsToolCalls: false, underlyingModel: "mine", tier: "high", pricing: { inputPerMTok: 2 }, reasoningParameter: "none" });
    const outcome = applyChoices(integration([mine, model("other")]), catalog, choose(["muse-glimmer-30b"]), sequence());
    expect(outcome.updated).toEqual(["muse-glimmer-30b"]);
    expect(outcome.added).toEqual([]);
    expect(outcome.patch.chatModels![0]).toEqual({ ...mine, maxOutputTokens: 8192, supportsStreaming: true, supportsReasoning: true, supportsVision: true });
    expect(outcome.patch.chatModels![1]).toEqual(model("other"));
  });

  it("does not touch the thinking parameter of a model that exists, and does not suggest one for it: that is for the models it adds", () => {
    const outcome = applyChoices(integration([model("muse-glimmer-30b")]), catalog, choose(["muse-glimmer-30b"], { thinking: new Set(["muse-glimmer-30b"]) }), sequence());
    expect(outcome.patch.chatModels![0]).not.toHaveProperty("reasoningParameter");
  });

  it("does not count, and does not change, a model that has nothing to add", () => {
    const outcome = applyChoices(integration([model("legacy-8b")]), catalog, choose(["legacy-8b"]), sequence());
    expect(outcome.updated).toEqual([]);
    expect(outcome.added).toEqual([]);
    expect(outcome.patch).not.toHaveProperty("chatModels");
  });

  it("takes a name that differs by a letter for another model, and adds it", () => {
    const outcome = applyChoices(integration([model("Muse-Glimmer-30B")]), catalog, choose(["muse-glimmer-30b"]), sequence());
    expect(names(outcome.patch.chatModels)).toEqual(["Muse-Glimmer-30B", "muse-glimmer-30b"]);
    expect(outcome.added).toEqual(["muse-glimmer-30b"]);
  });

  it("never changes what it was given: the integration and its models are the same objects after", () => {
    const mine = integration([model("muse-glimmer-30b")]);
    const before = JSON.stringify(mine);
    applyChoices(mine, catalog, choose(["muse-glimmer-30b", "legacy-8b"], { media: { image: "flux-schnell" } }), sequence());
    expect(JSON.stringify(mine)).toBe(before);
  });

  it("ignores a selection that is not a model of the catalog, or not a text model: a model of another kind is never made a chat model", () => {
    const outcome = applyChoices(integration(), catalog, choose(["flux-schnell", "bge-m3", "ghost"]), sequence());
    expect(outcome.added).toEqual([]);
    expect(outcome.patch).not.toHaveProperty("chatModels");
  });
});

describe("the image, speech and transcription models of the integration", () => {
  it("are set from the models that were chosen for them, when the author left the field empty", () => {
    const outcome = applyChoices(integration(), catalog, choose([], { media: { image: "flux-schnell", speech: "kokoro", transcription: "whisper-large" } }), sequence());
    expect(outcome.patch).toMatchObject({ modelImageGeneration: "flux-schnell", modelTextToSpeech: "kokoro", modelSpeechToText: "whisper-large" });
    expect(outcome.media).toEqual(["image", "speech", "transcription"]);
    expect(outcome.patch).not.toHaveProperty("chatModels");
  });

  it("never replace a model the author wrote, and a blank field counts as empty", () => {
    const outcome = applyChoices(integration([], { modelImageGeneration: "gpt-image-1", modelTextToSpeech: "   " }), catalog, choose([], { media: { image: "flux-schnell", speech: "kokoro" } }), sequence());
    expect(outcome.patch).not.toHaveProperty("modelImageGeneration");
    expect(outcome.patch.modelTextToSpeech).toBe("kokoro");
    expect(outcome.media).toEqual(["speech"]);
  });

  it("ignore a model that is not of that kind: a speech model is not an image model", () => {
    const outcome = applyChoices(integration(), catalog, choose([], { media: { image: "kokoro", speech: "ghost", transcription: "flux-schnell" } }), sequence());
    expect(outcome.patch).toEqual({});
    expect(outcome.media).toEqual([]);
  });
});

describe("what the dialog needs to say before the author chooses", () => {
  it("suggests the thinking parameter the engine knows for a name, and none for the others", () => {
    expect(thinkingSuggestion("muse-glimmer-30b")).toBe(TEMPLATE);
    expect(thinkingSuggestion("meta/Muse-Glimmer-30B-GGUF:Q4_K_M")).toBe(TEMPLATE);
    expect(thinkingSuggestion("legacy-8b")).toBeUndefined();
    expect(thinkingSuggestion("")).toBeUndefined();
  });

  it("reads the model the integration already has for images, speech or transcription: what is written, without the blanks around it, and nothing for an empty or blank field", () => {
    const filled = integration([], { modelImageGeneration: "  gpt-image-1 ", modelTextToSpeech: "   ", modelSpeechToText: undefined });
    expect(currentMedia(filled, "image")).toBe("gpt-image-1");
    expect(currentMedia(filled, "speech")).toBe("");
    expect(currentMedia(filled, "transcription")).toBe("");
  });
});

describe("what is chosen before the author chooses anything", () => {
  it("is the new text models, and the suggested thinking parameter for the ones that have one: nothing existing, nothing of another kind", () => {
    const fresh = defaultChoices(integration(), catalog);
    expect([...fresh.models]).toEqual(["muse-glimmer-30b", "legacy-8b"]);
    expect([...fresh.thinking]).toEqual(["muse-glimmer-30b"]);
    expect(fresh.media).toEqual({});
    const known = defaultChoices(integration([model("muse-glimmer-30b")]), catalog);
    expect([...known.models]).toEqual(["legacy-8b"]);
    expect([...known.thinking]).toEqual([]);
  });

  it("is nothing when the endpoint told no kinds: every model is listed as text, and ticking them all would make chat models of the embeddings, the voices and the images of a big endpoint", () => {
    const bare = { models: entries.map((entryModel) => ({ id: entryModel.id, type: "unknown" as const, capabilities: {} })), source: NONE };
    expect(groupCatalog(bare)[0].entries).toHaveLength(6);
    expect([...defaultChoices(integration(), bare).models]).toEqual([]);
    expect([...defaultChoices(integration(), bare).thinking]).toEqual([]);
  });
});
