import { modelFieldsFromCatalogEntry, suggestedReasoningParameter, type AiModelCatalog, type AiModelCatalogEntry } from "narrarium-engine";
import type { AIIntegration, ChatCapability, ChatModel, ReasoningParameter } from "@/types/settings";

/**
 * What the dialog that reads the models of an endpoint does with them, without a screen: how they are grouped, what an update may fill in, what is chosen at first, and the
 * change to the integration that the choices make. Pure, so that the rules that protect what the author wrote are tested without a page.
 */

/** The groups of the dialog, in the order they are shown. «Other» is every kind a screen has no use for (realtime, classifiers) and the models that the endpoint listed without saying what they are. */
export const CATALOG_KINDS = ["text", "image", "speech", "transcription", "embedding", "other"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** The kinds that can be set as a model of the integration besides chat: its image, text-to-speech and transcription models. */
export const MEDIA_KINDS = ["image", "speech", "transcription"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_FIELD = { image: "modelImageGeneration", speech: "modelTextToSpeech", transcription: "modelSpeechToText" } as const satisfies Record<MediaKind, keyof AIIntegration>;

/** The fields of a model that the endpoint can fill in: the window, the largest answer and the four capabilities. */
export const FILL_KEYS = ["maxInputTokens", "maxOutputTokens", "supportsToolCalls", "supportsStreaming", "supportsReasoning", "supportsVision"] as const;
export type FillKey = (typeof FILL_KEYS)[number];

/** The roles the first model of an integration takes, as every other way of adding a model gives them. */
const DEFAULT_ROLES: readonly ChatCapability[] = ["default", "copilot", "simple-tasks", "review"];

type Source = Pick<AiModelCatalog["source"], "details" | "modalities">;
export type CatalogView = Pick<AiModelCatalog, "models" | "source">;

/**
 * The group of a model. A gateway that tells the kinds (`/models/details` or `/modalities`) puts every other model in «other», because it did not say what it is. An endpoint that
 * tells nothing gives no kinds at all, and then every model is a text model, as BookWriter takes them: the dialog says so, and ticks none.
 */
export function kindOfEntry(entry: Pick<AiModelCatalogEntry, "type">, source: Source): CatalogKind {
  switch (entry.type) {
    case "chat": return "text";
    case "image": return "image";
    case "speech": return "speech";
    case "transcription": return "transcription";
    case "embedding": return "embedding";
    case "unknown": return source.details || source.modalities ? "other" : "text";
    default: return "other";
  }
}

export interface CatalogGroup {
  kind: CatalogKind;
  entries: AiModelCatalogEntry[];
}

/** The models by kind, in the fixed order of `CATALOG_KINDS` and in the order the endpoint gave them within a kind; a kind with no model is left out. */
export function groupCatalog(catalog: CatalogView): CatalogGroup[] {
  return CATALOG_KINDS
    .map((kind) => ({ kind, entries: catalog.models.filter((entry) => kindOfEntry(entry, catalog.source) === kind) }))
    .filter((group) => group.entries.length > 0);
}

/** Whether the endpoint told the kinds of its models: when it did not, nothing is known of any of them. */
export const tellsKinds = (source: Source): boolean => source.details || source.modalities;

const emptyLimit = (value: number | null | undefined): boolean => value === undefined || value === null || !(value > 0);
const emptyFlag = (value: boolean | null | undefined): boolean => value === undefined || value === null;

/**
 * What the endpoint can add to a model the author has: the fields it declares and the model leaves empty, one by one. A number the author wrote and a capability the author set,
 * a switch turned off included, are never turned over; and nothing is made of what the endpoint does not declare (`modelFieldsFromCatalogEntry` says a capability only when it is
 * `true`, because the `false` that a gateway sends is «not declared», and a number only when there is one).
 */
export function fillOf(model: ChatModel, entry: AiModelCatalogEntry): Partial<Pick<ChatModel, FillKey>> {
  const declared = modelFieldsFromCatalogEntry(entry);
  const fill: Partial<Pick<ChatModel, FillKey>> = {};
  if (declared.maxInputTokens !== undefined && emptyLimit(model.maxInputTokens)) fill.maxInputTokens = declared.maxInputTokens;
  if (declared.maxOutputTokens !== undefined && emptyLimit(model.maxOutputTokens)) fill.maxOutputTokens = declared.maxOutputTokens;
  for (const key of ["supportsToolCalls", "supportsStreaming", "supportsReasoning", "supportsVision"] as const) {
    if (declared[key] === true && emptyFlag(model[key])) fill[key] = true;
  }
  return fill;
}

/** The thinking parameter that a documented source gives a model name, for the dialog to suggest: Muse Glimmer today. The author is asked, and nothing is set by itself. */
export const thinkingSuggestion = (name: string): ReasoningParameter | undefined => suggestedReasoningParameter(name);

/** The model the integration already has for images, speech or transcription: what is written, without the blanks around it; empty when the field is empty or blank. */
export function currentMedia(integration: AIIntegration, kind: MediaKind): string {
  return (integration[MEDIA_FIELD[kind]] ?? "").trim();
}

/** What the author has ticked: the text models to add or update, the models that get the suggested thinking parameter, and the one model chosen for each other kind. */
export interface CatalogChoices {
  models: Set<string>;
  thinking: Set<string>;
  media: Partial<Record<MediaKind, string>>;
}

const modelNamed = (integration: AIIntegration, name: string): ChatModel | undefined => (integration.chatModels ?? []).find((model) => model.name === name);

/**
 * What is ticked before the author ticks anything: the text models the integration does not have yet, with the thinking parameter for the ones the engine has a suggestion for.
 * Nothing when the endpoint told no kinds: a big endpoint lists embeddings, voices and images beside its chat models, and ticking them all would make chat models of them.
 */
export function defaultChoices(integration: AIIntegration, catalog: CatalogView): CatalogChoices {
  const choices: CatalogChoices = { models: new Set(), thinking: new Set(), media: {} };
  if (!tellsKinds(catalog.source)) return choices;
  for (const entry of catalog.models) {
    if (kindOfEntry(entry, catalog.source) !== "text" || modelNamed(integration, entry.id)) continue;
    choices.models.add(entry.id);
    if (thinkingSuggestion(entry.id)) choices.thinking.add(entry.id);
  }
  return choices;
}

/** What the choices do to the integration. `patch` is what to give to its editor; the rest is what the dialog and its message say. */
export interface CatalogOutcome {
  patch: Partial<AIIntegration>;
  /** The names of the models that are new, and of the ones that were updated (a model that has nothing to add is not counted), in the order of the catalog. */
  added: string[];
  updated: string[];
  /** The kinds whose model of the integration was set. */
  media: MediaKind[];
  /** The model that takes the default roles, when the integration had no model at all. */
  defaulted?: string;
}

/**
 * The change the choices make to the integration, never to what the author wrote. A model that exists (the same name, letter for letter) is filled in where it is empty and keeps
 * everything else; a new model is added after the ones the author has, in the order of the catalog, with what the endpoint declares of it, and with the suggested thinking parameter
 * when it was ticked. Only an integration that has no model gives roles to its first one (the one that declares tool calls, which the autopilot needs, else the first), as every other
 * way of adding a model does: the roles of an integration that has models are the author's. The image, speech and transcription models are set only when the field is empty. It
 * returns a patch and changes nothing it was given.
 */
export function applyChoices(integration: AIIntegration, catalog: CatalogView, choices: CatalogChoices, newId: () => string = () => crypto.randomUUID()): CatalogOutcome {
  const patch: Partial<AIIntegration> = {};
  const current = integration.chatModels ?? [];
  const picked = catalog.models.filter((entry) => choices.models.has(entry.id) && kindOfEntry(entry, catalog.source) === "text");
  const pickedByName = new Map(picked.map((entry) => [entry.id, entry]));

  const touched = new Set<string>();
  const next = current.map((model) => {
    const entry = pickedByName.get(model.name);
    if (!entry) return model;
    const fill = fillOf(model, entry);
    if (Object.keys(fill).length === 0) return model;
    touched.add(entry.id);
    return { ...model, ...fill };
  });

  const fresh = picked.filter((entry) => !current.some((model) => model.name === entry.id));
  const lead = current.length === 0 ? fresh.find((entry) => entry.capabilities.tools === true) ?? fresh[0] : undefined;
  const created: ChatModel[] = fresh.map((entry) => {
    const suggestion = choices.thinking.has(entry.id) ? thinkingSuggestion(entry.id) : undefined;
    return {
      id: newId(),
      name: entry.id,
      capabilities: entry === lead ? [...DEFAULT_ROLES] : [],
      ...modelFieldsFromCatalogEntry(entry),
      ...(suggestion ? { reasoningParameter: suggestion } : {}),
    };
  });
  if (touched.size > 0 || created.length > 0) patch.chatModels = [...next, ...created];

  const media: MediaKind[] = [];
  for (const kind of MEDIA_KINDS) {
    const id = choices.media[kind];
    const entry = id ? catalog.models.find((candidate) => candidate.id === id) : undefined;
    if (!id || !entry || kindOfEntry(entry, catalog.source) !== kind || currentMedia(integration, kind)) continue;
    patch[MEDIA_FIELD[kind]] = id;
    media.push(kind);
  }

  return {
    patch,
    added: created.map((model) => model.name),
    updated: picked.filter((entry) => touched.has(entry.id)).map((entry) => entry.id),
    media,
    ...(lead ? { defaulted: lead.id } : {}),
  };
}
