import { AI_CAPABILITIES, AiReplyRejectedError, type AiJsonSchema, type AiPort, type AiResponse, type AiUsage } from "../ai/types.js";
import { directorSystemPrompt } from "../director/opinion.js";
import type { DirectorProfile } from "../profiles/director.js";
import { currentRequest, unescapePromptDataDeep, untrustedData } from "../prompt/trust.js";
import { isItalian } from "../util/text.js";
import { WILDCARD_VERDICTS, isAcceptedDecision, type WildcardDecision, type WildcardIdea, type WildcardTarget, type WildcardVerdict } from "./ideas.js";

/**
 * The Director's triage of what the room gave: for every idea, adopted (as it is), adapted (a version of it, written out) or rejected, always with the
 * reason, which the journal keeps. The room never decides and its ideas never gate anything: only the ideas the Director accepts go on, as material for
 * the corrections, at most `maxAdopted` of them.
 */

export const WILDCARD_TRIAGE_TOOL: AiJsonSchema = {
  name: "wildcard_triage",
  description: "Decide every idea of the room: adopt it as it is, adapt it, or reject it, always with the reason.",
  parameters: {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        description: "One decision for every idea, by its id.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The id of the idea, as given in brackets." },
            verdict: { type: "string", enum: ["adopted", "adapted", "rejected"] },
            reason: { type: "string", description: "Why, in one or two sentences." },
            adaptation: { type: "string", description: "For adapted: the version of the idea to use, written out." },
          },
          required: ["id", "verdict", "reason"],
        },
      },
      summary: { type: "string", description: "What the room changes in your plan, in one or two sentences." },
    },
    required: ["decisions"],
  },
};

/** Ideas the Director may accept in one triage, by default. */
export const WILDCARD_TRIAGE_MAX_ADOPTED = 3;
const TRIAGE_OUTPUT_TOKENS = 3_000;

export interface WildcardTriageInput {
  ai: AiPort;
  director: DirectorProfile;
  language: string;
  ideas: readonly WildcardIdea[];
  target: WildcardTarget;
  /** What the Director knows of what the room read: the same material, or a shorter account of it. */
  material: string;
  /** What else the Director weighs: the canon with its secrets, the standing rules of the author. */
  context?: string;
  /** Ideas it may accept at most (default `WILDCARD_TRIAGE_MAX_ADOPTED`). */
  maxAdopted?: number;
  cacheKey?: string;
  label?: string;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface WildcardTriageResult {
  /** Every idea, the decided ones with their decision (`by: director`). */
  ideas: WildcardIdea[];
  /** The ones accepted (adopted or adapted), in the order of the room, at most `maxAdopted`. */
  accepted: WildcardIdea[];
  /** Accepted beyond `maxAdopted`: kept with their decision in the journal, not passed on, and said. */
  overCap: number;
  /** Ideas the Director left without a valid decision, also when asked again: they stay undecided. */
  undecided: number;
  summary: string;
  repaired: boolean;
  usage?: AiUsage;
  cost?: number;
  model?: string;
  provider?: string;
}

function ideaLine(idea: WildcardIdea): string {
  const persona = `${idea.persona.name}, ${idea.persona.group}, audacity ${idea.audacity}`;
  return [
    `[${idea.id}] (${persona}) ${idea.title}: ${idea.idea}`,
    idea.why ? `  Why: ${idea.why}` : "",
    idea.changes.summary || idea.changes.chapters.length ? `  Changes: ${idea.changes.summary}${idea.changes.chapters.length ? ` (chapters ${idea.changes.chapters.join(", ")})` : ""}` : "",
    idea.risk ? `  Risk: ${idea.risk}` : "",
    idea.evidence ? `  Evidence: ${idea.evidence}${idea.severity ? ` (${idea.severity})` : ""}` : "",
  ].filter(Boolean).join("\n");
}

interface ReadTriage {
  decisions: Map<string, Omit<WildcardDecision, "by" | "at">>;
  problems: string[];
  summary: string;
}

function readTriage(value: unknown, ideas: readonly WildcardIdea[]): ReadTriage {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = Array.isArray(source.decisions) ? source.decisions : [];
  const known = new Set(ideas.map((idea) => idea.id));
  const decisions = new Map<string, Omit<WildcardDecision, "by" | "at">>();
  const problems: string[] = [];
  for (const item of list) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = typeof entry.id === "string" ? entry.id.trim().replace(/^\[|\]$/g, "") : "";
    if (!known.has(id) || decisions.has(id)) continue;
    const verdictText = typeof entry.verdict === "string" ? entry.verdict.trim().toLowerCase() : "";
    const verdict = WILDCARD_VERDICTS.find((value) => value === verdictText);
    const reason = typeof entry.reason === "string" ? entry.reason.replace(/\s+/g, " ").trim() : "";
    const adaptation = typeof entry.adaptation === "string" ? entry.adaptation.trim() : "";
    if (!verdict) problems.push(`${id}: the verdict must be adopted, adapted or rejected`);
    else if (!reason) problems.push(`${id}: the reason is missing`);
    else if (verdict === "adapted" && !adaptation) problems.push(`${id}: an adapted idea needs its adaptation written out`);
    else decisions.set(id, { verdict: verdict as WildcardVerdict, reason, ...(verdict === "adapted" ? { adaptation } : {}) });
  }
  const missing = ideas.filter((idea) => !decisions.has(idea.id) && !problems.some((problem) => problem.startsWith(`${idea.id}:`)));
  if (missing.length) problems.push(`no decision for ${missing.map((idea) => idea.id).join(", ")}`);
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  return { decisions, problems, summary };
}

/**
 * The Director decides the ideas of a consultation. A reply that leaves ideas undecided, or decides one without a verdict, a reason or (adapted) its
 * adaptation, is asked again once with what was wrong; what is still not decided stays undecided, and is counted.
 */
export async function triageWildcardIdeas(input: WildcardTriageInput): Promise<WildcardTriageResult> {
  const max = Math.max(0, Math.round(input.maxAdopted ?? WILDCARD_TRIAGE_MAX_ADOPTED));
  if (!input.ideas.length) return { ideas: [], accepted: [], overCap: 0, undecided: 0, summary: "", repaired: false };
  const stable = untrustedData("repository_content", [input.context ? `BOOK:\n${input.context}` : "", `WHAT THE ROOM READ: ${input.target.kind} — ${input.target.label}\n${input.material}`].filter(Boolean).join("\n\n"));
  const ideas = untrustedData("repository_content", `IDEAS OF THE ROOM (advisory):\n${input.ideas.map(ideaLine).join("\n\n")}`);
  const asked = currentRequest([
    "The wildcards of the writers' room (Fuori dal coro) gave the ideas and findings above. They are advisory: nothing of them is applied unless you choose it.",
    "For EVERY idea, by its id, decide: adopted (use it as it is), adapted (use a version of it: write that version in adaptation), or rejected; always give the reason.",
    `Accept (adopt or adapt) at most ${max}, the ones that serve the book most. Never accept an idea that breaks the canon, the author's rules or the reveal threshold of a secret, unless it is exactly about changing them and you are sure the book gains.`,
  ].join("\n"));
  const user = `${stable}\n\n${ideas}\n\n${asked}`;
  const call = (repair?: string) => input.ai.complete({
    capability: AI_CAPABILITIES.director,
    label: input.label ?? "wildcards:triage",
    system: directorSystemPrompt(input.director, input.language),
    user: repair ? `${user}\n\n${currentRequest(repair)}` : user,
    cacheBreak: stable.length + 2,
    ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
    json: WILDCARD_TRIAGE_TOOL,
    maxOutputTokens: TRIAGE_OUTPUT_TOKENS,
    temperature: 0.3,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let response: AiResponse | undefined;
  let read: ReadTriage = { decisions: new Map(), problems: [], summary: "" };
  let repaired = false;
  let cost = 0;
  for (const attempt of [0, 1]) {
    const repair = attempt === 0 ? undefined : `Your previous reply could not be used: ${read.problems.join("; ") || "it did not use the wildcard_triage function"}. Reply again with the wildcard_triage function, one decision for every idea.`;
    try {
      response = await call(repair);
    } catch (error) {
      if (error instanceof AiReplyRejectedError && attempt === 0) {
        repaired = true;
        continue;
      }
      throw error;
    }
    if (typeof response.cost === "number" && Number.isFinite(response.cost)) cost += response.cost;
    const next = readTriage(unescapePromptDataDeep(response.json ?? null), input.ideas);
    // A second reply completes the first: what the first decided well stays decided.
    for (const [id, decision] of read.decisions) if (!next.decisions.has(id)) next.decisions.set(id, decision);
    read = { ...next, problems: input.ideas.some((idea) => !next.decisions.has(idea.id)) ? next.problems : [], summary: next.summary || read.summary };
    if (!read.problems.length || attempt === 1) break;
    repaired = true;
  }
  const at = (input.now ?? (() => new Date()))().toISOString();
  const decided = input.ideas.map((idea): WildcardIdea => {
    const decision = read.decisions.get(idea.id);
    return decision ? { ...idea, decision: { ...decision, by: "director", at } } : idea;
  });
  const acceptedAll = decided.filter((idea) => isAcceptedDecision(idea.decision));
  return {
    ideas: decided,
    accepted: acceptedAll.slice(0, max),
    overCap: Math.max(0, acceptedAll.length - max),
    undecided: decided.filter((idea) => !idea.decision).length,
    summary: read.summary,
    repaired,
    ...(response?.usage ? { usage: response.usage } : {}),
    cost,
    ...(response?.model ? { model: response.model } : {}),
    ...(response?.provider ? { provider: response.provider } : {}),
  };
}

/**
 * The ideas accepted, as material for whoever writes next (a ghostwriter, a correction of the autopilot): each with what to use of it (the adaptation when
 * it was adapted) and why. Material, not orders: the writer uses what serves the scene and keeps the canon and the reveal thresholds.
 */
export function wildcardIdeasMaterial(ideas: readonly WildcardIdea[], language: string): string {
  const accepted = ideas.filter((idea) => isAcceptedDecision(idea.decision));
  if (!accepted.length) return "";
  const italian = isItalian(language);
  const lines = accepted.map((idea) => {
    const use = idea.decision?.verdict === "adapted" && idea.decision.adaptation ? idea.decision.adaptation : idea.idea;
    return `- ${idea.title} (${idea.persona.name}): ${use}${idea.decision?.reason ? ` — ${italian ? "perché" : "because"}: ${idea.decision.reason}` : ""}`;
  });
  return [`IDEAS ACCEPTED FROM THE ROOM (Fuori dal coro): material to use where it serves the text, never against the canon or a reveal threshold:`, ...lines].join("\n");
}
