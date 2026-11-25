import type { UsageSource } from "@/costs/ledger";
import { BRAINSTORMING_CAPABILITY } from "@/types/settings";

/** What says where a call came from: who made it (`origin`: an autopilot run, a turn of the Copilot), the capability it was routed for, and its label. */
export interface UsageOrigin {
  /**
   * `autopilot`: a call of an autopilot run, whatever its capability (a run asks the director, the readers and the summaries too). `copilot`: a call of a turn
   * of the Copilot, its tools included (`usageTasks.ts`).
   */
  origin?: "autopilot" | "copilot";
  capability: string;
  /** The label of the request (`copilot:create-chapter`, `pipeline:refine-prose`…): what tells the features apart that share a general capability. */
  label?: string;
}

/** The capabilities that only one feature uses. */
const BY_CAPABILITY: Readonly<Record<string, UsageSource>> = {
  autopilot: "autopilot",
  director: "autopilot",
  copilot: "copilot",
  "chat-resume": "copilot",
  // Brainstorming, the Copilot's mode for the design of the book: its capability stays in the key of the ledger, for a view by capability.
  [BRAINSTORMING_CAPABILITY]: "copilot",
  "editor-actions": "editor-actions",
  audit: "audit",
  "reader-evaluation": "reader-evaluation",
  "reader-evaluation-summary": "reader-evaluation",
  "rewrite-from-reader-feedback": "reader-evaluation",
  "deep-research": "research",
  "create-from-research": "research",
  image: "media",
  tts: "media",
  stt: "media",
};

/**
 * The general capabilities (`default`, `simple-tasks`, `review`) are shared by many features: the first word of the label says which one asked
 * (the labels are this app's own, `<feature>:<what>`). A label nobody knows is `other`.
 */
const BY_LABEL: Readonly<Record<string, UsageSource>> = {
  copilot: "copilot",
  assistant: "copilot",
  confirm: "copilot",
  pipeline: "editor-actions",
  editor: "editor-actions",
  evaluation: "editor-actions",
  resume: "editor-actions",
  "live-voice": "editor-actions",
  "custom-action": "editor-actions",
  audit: "audit",
  "reader-evaluation": "reader-evaluation",
  "reader-evaluation-summary": "reader-evaluation",
  "rewrite-from-reader-feedback": "reader-evaluation",
  "deep-research": "research",
  "create-from-research": "research",
  "regenerate-entity": "research",
  image: "media",
  tts: "media",
  stt: "media",
  autopilot: "autopilot",
  director: "autopilot",
};

/** The capabilities that many features share: the label of a request tells which feature asked. */
const GENERAL_CAPABILITIES: ReadonlySet<string> = new Set(["default", "simple-tasks", "review"]);

/**
 * The source of a call, decided here and nowhere else: a call of the autopilot is the autopilot's whatever it asks, and a call of a turn of the Copilot is the
 * Copilot's, the tools it runs included; a capability that one feature owns says the feature; a general capability is told by the label; anything else is `other`.
 */
export function usageSource({ origin, capability, label }: UsageOrigin): UsageSource {
  if (origin === "autopilot") return "autopilot";
  if (origin === "copilot") return "copilot";
  const owned = Object.prototype.hasOwnProperty.call(BY_CAPABILITY, capability) ? BY_CAPABILITY[capability] : undefined;
  if (owned) return owned;
  // A capability that is neither one feature's nor a general one (one that a later version adds) is `other`, whatever its label says; it never throws.
  if (typeof capability !== "string" || !GENERAL_CAPABILITIES.has(capability)) return "other";
  const word = (typeof label === "string" ? label : "").trim().toLowerCase().split(/[:\s(]/, 1)[0];
  return Object.prototype.hasOwnProperty.call(BY_LABEL, word) ? BY_LABEL[word] : "other";
}
