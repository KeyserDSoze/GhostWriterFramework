import { integrationChatModels, modelSupportsCapability } from "@/assistant/llm";
import { BROWSER_ROUTING_ID, resolveEffectiveTaskCandidates } from "@/assistant/router";
import { matchKey } from "@/lib/matchText";
import { AUTOPILOT_TASKS } from "@/router/autopilotTasks";
import { normalizeThinking } from "@/router/thinking";
import { CHAT_CAPABILITIES, type AIIntegration, type AppSettings, type ChatCapability, type RoutingTarget, type RoutingTaskKind, type TaskRoute, type ThinkingLevel } from "@/types/settings";

/**
 * The model behind the tables of the AI Router: pure functions on the settings, with nothing of React in them.
 *
 * A table has one tab per level of the route: level 0 is the primary and level k is `fallbacks[k - 1]`. Fallbacks always
 * follow one another and always follow a primary, so a route never has a hole and no fallback is left without a primary.
 */

export type Routing = NonNullable<AppSettings["taskRouting"]>;

// ─── Sections and groups ──────────────────────────────────────────────────────

export const ROUTER_SECTIONS = ["text", "tts", "stt", "image"] as const;
export type RouterSectionId = (typeof ROUTER_SECTIONS)[number];

export const TEXT_GROUP_IDS = ["autopilot", "copilot", "review", "research"] as const;
export type TextGroupId = (typeof TEXT_GROUP_IDS)[number];
export type GroupFilter = "all" | TextGroupId;

/**
 * Where each chat task is used. A task can belong to two groups when two flows use it:
 * - autopilot: what the engine's autopilot asks the router for (`AI_CAPABILITIES`): the writer, the director, the simulated readers and
 *   their summary, the specialists (review) and the summaries (simple-tasks);
 * - copilot: the interactive side: the Copilot, what it writes with the default model, the editor actions, quick decisions, chat resumes;
 * - review: the judging side: evaluations of chapters and paragraphs, the readers, the audit, the rewrite from the readers' feedback;
 * - research: deep research and what is created from it.
 */
export const TEXT_GROUPS: Readonly<Record<TextGroupId, readonly ChatCapability[]>> = {
  autopilot: AUTOPILOT_TASKS,
  copilot: ["default", "copilot", "editor-actions", "simple-tasks", "chat-resume"],
  review: ["review", "reader-evaluation", "reader-evaluation-summary", "audit", "rewrite-from-reader-feedback"],
  research: ["deep-research", "create-from-research"],
};

/** The order of the table with every group on show: the default route first, then each task where its group first lists it. */
export const TEXT_TASK_ORDER: readonly ChatCapability[] = ["default", ...new Set(TEXT_GROUP_IDS.flatMap((group) => TEXT_GROUPS[group]).filter((task) => task !== "default"))];

export const SECTION_TASKS: Readonly<Record<RouterSectionId, readonly RoutingTaskKind[]>> = {
  text: TEXT_TASK_ORDER,
  tts: ["tts"],
  stt: ["stt"],
  image: ["image"],
};

export function tasksInGroup(group: GroupFilter): readonly ChatCapability[] {
  return group === "all" ? TEXT_TASK_ORDER : TEXT_GROUPS[group];
}

export function isChatTask(task: RoutingTaskKind): task is ChatCapability {
  return (CHAT_CAPABILITIES as readonly string[]).includes(task);
}

export function isMediaTask(task: RoutingTaskKind): boolean {
  return !isChatTask(task);
}

/**
 * Whether a task has a thinking level of its own: the chat tasks do, but the Default row does not (it only chooses the endpoint of the tasks that have no route, so the level
 * those tasks go out with is the endpoint's), and the media tasks have none to give.
 */
export function takesThinking(task: RoutingTaskKind): task is ChatCapability {
  return isChatTask(task) && task !== "default";
}

// ─── Levels of a route ────────────────────────────────────────────────────────

/** The route as a list by level, without the empty levels at its end. Only the primary can be empty inside it. */
function positional(route: TaskRoute | undefined): Array<RoutingTarget | undefined> {
  if (!route) return [];
  const levels: Array<RoutingTarget | undefined> = [route.primary, ...(route.fallbacks ?? [])];
  while (levels.length > 0 && levels[levels.length - 1] === undefined) levels.pop();
  return levels;
}

function fromLevels(levels: Array<RoutingTarget | undefined>): TaskRoute | undefined {
  const trimmed = [...levels];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
  if (trimmed.length === 0) return undefined;
  const [primary, ...fallbacks] = trimmed;
  return { primary, fallbacks: fallbacks as RoutingTarget[] };
}

/** Level 0 is the primary, level k the fallback k. */
export function targetAt(route: TaskRoute | undefined, level: number): RoutingTarget | undefined {
  if (!route || level < 0) return undefined;
  return level === 0 ? route.primary : route.fallbacks?.[level - 1];
}

export type FillBlock = "no-primary" | "gap";

/** Whether an empty cell can be given a target: the primary always, a fallback only straight after a level that has one. */
export function fillability(route: TaskRoute | undefined, level: number): { ok: true } | { ok: false; reason: FillBlock } {
  if (level === 0) return { ok: true };
  const levels = positional(route);
  if (!levels[0]) return { ok: false, reason: "no-primary" };
  return level <= levels.length ? { ok: true } : { ok: false, reason: "gap" };
}

/**
 * The route with its target at `level` set, or taken away (the later levels then move up, and clearing the primary promotes the first
 * fallback). `RangeError` when setting would leave a hole or a fallback without a primary: `fillability` says beforehand.
 */
export function withTargetAt(route: TaskRoute | undefined, level: number, target: RoutingTarget | undefined): TaskRoute | undefined {
  const levels = positional(route);
  if (target === undefined) {
    if (level >= levels.length) return route;
    return fromLevels(levels.filter((_, index) => index !== level));
  }
  const replacing = levels[level] !== undefined;
  if (!replacing && (level > levels.length || (level > 0 && !levels[0]))) throw new RangeError(`Level ${level} cannot be filled yet`);
  const next = [...levels];
  next[level] = target;
  return fromLevels(next);
}

/** The routing with the route of one task replaced; a task with no target left is removed. */
export function putRoute(routing: Routing | undefined, task: RoutingTaskKind, route: TaskRoute | undefined): Routing {
  const next: Routing = { ...(routing ?? {}) };
  if (route && (route.primary || (route.fallbacks?.length ?? 0) > 0)) next[task] = route;
  else delete next[task];
  return next;
}

/** The tabs the data needs: the primary and as many fallbacks as the deepest route among the tasks has. */
export function dataLevelCount(routing: Routing | undefined, tasks: readonly RoutingTaskKind[]): number {
  return tasks.reduce((deepest, task) => Math.max(deepest, positional(routing?.[task]).length), 1);
}

/** The tabs on show: what the data needs, and the empty ones the author added. */
export function levelCount(routing: Routing | undefined, tasks: readonly RoutingTaskKind[], extraLevels: number): number {
  return Math.max(dataLevelCount(routing, tasks), extraLevels, 1);
}

/** The primary counts as a candidate: a chain of `maxCandidates` has the primary and `maxCandidates - 1` fallbacks. */
export function canAddLevel(count: number, maxCandidates: number): boolean {
  return count < maxCandidates;
}

export function countAtLevel(routing: Routing | undefined, tasks: readonly RoutingTaskKind[], level: number): number {
  return tasks.filter((task) => targetAt(routing?.[task], level) !== undefined).length;
}

// ─── Which endpoints and models a task may use ────────────────────────────────

export interface IntegrationChoice { id: string; label: string }

/** Integration options for a task: the browser for speech, OpenAI and Azure for media, anything that can chat for text. */
export function taskIntegrationChoices(integrations: AIIntegration[], task: RoutingTaskKind, browserLabel: string): IntegrationChoice[] {
  const choices: IntegrationChoice[] = [];
  if (task === "tts" || task === "stt") choices.push({ id: BROWSER_ROUTING_ID, label: browserLabel });
  const list = isMediaTask(task)
    ? integrations.filter((integration) => integration.provider === "openai" || integration.provider === "azure_openai")
    : integrations.filter((integration) => integration.provider !== "m365_copilot");
  for (const integration of list) choices.push({ id: integration.id, label: integration.name || integration.provider });
  return choices;
}

/** The models an integration offers a task: chat models with the capability (or "default"), or the one model named for the media task. */
export function modelChoicesFor(integrations: AIIntegration[], integrationId: string | undefined, task: RoutingTaskKind): string[] {
  if (integrationId === BROWSER_ROUTING_ID) return ["browser"];
  const integration = integrations.find((entry) => entry.id === integrationId);
  if (!integration) return [];
  if (isChatTask(task)) return integrationChatModels(integration).filter((model) => Boolean(modelSupportsCapability(model, task))).map((model) => model.name).filter(Boolean);
  const media = task === "tts" ? integration.modelTextToSpeech : task === "stt" ? integration.modelSpeechToText : integration.modelImageGeneration;
  return media?.trim() ? [media.trim()] : [];
}

/** The models valid for every one of the tasks on the endpoint: what a bulk edit can offer. */
export function commonModelChoices(integrations: AIIntegration[], integrationId: string | undefined, tasks: readonly RoutingTaskKind[]): string[] {
  if (tasks.length === 0) return [];
  const [first, ...rest] = tasks.map((task) => modelChoicesFor(integrations, integrationId, task));
  return first.filter((name) => rest.every((others) => others.includes(name)));
}

/** A target as it is stored: a trimmed model, a thinking level only on the targets of the chat tasks that have one, the browser only for the two speech tasks. */
export function normalizeRoutingTarget(target: RoutingTarget | undefined, task: RoutingTaskKind): RoutingTarget | undefined {
  if (!target) return undefined;
  if (target.integrationId === BROWSER_ROUTING_ID) {
    return task === "tts" || task === "stt" ? { integrationId: BROWSER_ROUTING_ID, model: "browser" } : undefined;
  }
  const model = target.model?.trim();
  if (!model) return undefined;
  const thinking = takesThinking(task) ? normalizeThinking(target.thinking) : undefined;
  return { integrationId: target.integrationId, model, ...(thinking ? { thinking } : {}) };
}

function usesNoToolCalls(integrations: AIIntegration[], target: RoutingTarget): boolean {
  const integration = integrations.find((entry) => entry.id === target.integrationId);
  return integration ? integrationChatModels(integration).find((model) => model.name === target.model)?.supportsToolCalls === false : false;
}

// ─── A row ────────────────────────────────────────────────────────────────────

export interface EffectiveTarget {
  integrationId?: string;
  integrationName?: string;
  model?: string;
  browser?: boolean;
}

export interface RouterRow {
  task: RoutingTaskKind;
  level: number;
  /** The task's own target on this tab. */
  target?: RoutingTarget;
  /** The row has its own target on this tab (the "customized" badge, and the "only customized" filter). */
  custom: boolean;
  /** The task has a route of its own, on any tab. */
  routed: boolean;
  /** What the router would use on this tab, for a task without a route of its own. */
  effective?: EffectiveTarget;
  /** Why this empty cell cannot be filled yet. */
  blocked?: FillBlock;
  /** The task has fallbacks and no primary in front of them: the router then uses the first fallback as the first candidate. */
  orphan: boolean;
  /** The row is a task of the autopilot, it uses a model that cannot call tools, and «Tools only» is on (the default): the autopilot skips that model, or stops. */
  toolWarning: boolean;
  /** The target points at an integration or a model that is no longer there (or no longer fits the task). */
  missing: { integration: boolean; model: boolean };
  /** The thinking level the integration would give a target that names none. */
  inheritedThinking?: ThinkingLevel;
}

export function buildRow(settings: AppSettings, task: RoutingTaskKind, level: number): RouterRow {
  const integrations = settings.aiIntegrations ?? [];
  const route = settings.taskRouting?.[task];
  const levels = positional(route);
  const target = targetAt(route, level);
  const routed = levels.length > 0;
  const integration = target ? integrations.find((entry) => entry.id === target.integrationId) : undefined;
  let effective: EffectiveTarget | undefined;
  let effectiveIntegration: AIIntegration | undefined;
  let blocked: FillBlock | undefined;
  if (!target) {
    if (!routed) {
      const candidate = resolveEffectiveTaskCandidates(settings, task)[level];
      if (candidate) {
        effectiveIntegration = candidate.integration;
        effective = candidate.browser
          ? { browser: true, model: "browser" }
          : { integrationId: candidate.integration?.id, integrationName: candidate.integration?.name || candidate.integration?.provider, model: candidate.model };
      }
    }
    const fill = fillability(route, level);
    if ("reason" in fill) blocked = fill.reason;
  }
  const browser = target?.integrationId === BROWSER_ROUTING_ID;
  return {
    task,
    level,
    target,
    custom: target !== undefined,
    routed,
    effective,
    blocked,
    orphan: !route?.primary && (route?.fallbacks?.length ?? 0) > 0,
    toolWarning: Boolean(target) && (AUTOPILOT_TASKS as readonly RoutingTaskKind[]).includes(task) && settings.aiToolsOnly !== false && usesNoToolCalls(integrations, target!),
    missing: target && !browser
      ? { integration: !integration, model: !modelChoicesFor(integrations, target.integrationId, task).includes(target.model) }
      : { integration: false, model: false },
    inheritedThinking: normalizeThinking((integration ?? effectiveIntegration)?.thinking),
  };
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface RowFilters {
  group: GroupFilter;
  query: string;
  onlyCustom: boolean;
}

/** The tasks the table shows: those of the group, whose name or help matches the text, and (if asked) that have their own target on the tab. */
export function visibleTasks(input: { settings: AppSettings; section: RouterSectionId; level: number; filters: RowFilters; searchText: (task: RoutingTaskKind) => string }): RoutingTaskKind[] {
  const { settings, section, level, filters, searchText } = input;
  const base: readonly RoutingTaskKind[] = section === "text" ? tasksInGroup(filters.group) : SECTION_TASKS[section];
  const needle = matchKey(filters.query);
  return base.filter((task) =>
    (!needle || matchKey(searchText(task)).includes(needle))
    && (!filters.onlyCustom || targetAt(settings.taskRouting?.[task], level) !== undefined));
}

// ─── Editing several rows at once ─────────────────────────────────────────────

/** `inherit` takes the level off the target (the integration's applies again); `undefined` leaves it as it is. */
export interface BulkChange {
  endpointId?: string;
  model?: string;
  thinking?: ThinkingLevel | "inherit";
}

export type SkipReason = "no-target" | "no-primary" | "gap" | "no-model" | "invalid-model" | "limit";

export interface BulkOutcome {
  routing: Routing;
  /** Rows whose target is now different (the new ones included). */
  changed: RoutingTaskKind[];
  /** Rows that had no target on the tab and have one now. */
  created: RoutingTaskKind[];
  /** Rows that took the first valid model of the endpoint, because their model is not there or none was chosen. */
  adjusted: RoutingTaskKind[];
  /** Rows that were already as asked. */
  unchanged: RoutingTaskKind[];
  skipped: Array<{ task: RoutingTaskKind; reason: SkipReason }>;
}

function sameTarget(a: RoutingTarget, b: RoutingTarget): boolean {
  return a.integrationId === b.integrationId && a.model === b.model && a.thinking === b.thinking;
}

/**
 * Changes the target of each row on a tab. The endpoint and the model are the author's choice; with no model asked for, a row keeps its
 * own if the endpoint has it for the task, else it takes the endpoint's first valid one. A row with no target gets one only when an
 * endpoint is chosen, and only where a target can be (a fallback right after a filled level). What is not asked for stays as it was,
 * the thinking above all. A row that cannot take the change is left alone and reported; nothing is changed halfway.
 */
export function applyBulkChange(input: { routing: Routing | undefined; integrations: AIIntegration[]; tasks: readonly RoutingTaskKind[]; level: number; change: BulkChange; maxCandidates: number }): BulkOutcome {
  const { integrations, tasks, level, change, maxCandidates } = input;
  const outcome: BulkOutcome = { routing: input.routing ?? {}, changed: [], created: [], adjusted: [], unchanged: [], skipped: [] };
  if (change.endpointId === undefined && change.model === undefined && change.thinking === undefined) return outcome;
  let working: Routing | undefined;
  for (const task of tasks) {
    const route = (working ?? outcome.routing)[task];
    const current = targetAt(route, level);
    const skip = (reason: SkipReason) => { outcome.skipped.push({ task, reason }); };
    if (!current) {
      if (change.endpointId === undefined) { skip("no-target"); continue; }
      const fill = fillability(route, level);
      if ("reason" in fill) { skip(fill.reason); continue; }
      if (level >= maxCandidates) { skip("limit"); continue; }
    }
    const endpointId = change.endpointId ?? current!.integrationId;
    const choices = modelChoicesFor(integrations, endpointId, task);
    let model: string;
    let adjusted = false;
    if (change.model !== undefined) {
      if (choices.length === 0) { skip("no-model"); continue; }
      if (!choices.includes(change.model)) { skip("invalid-model"); continue; }
      model = change.model;
    } else if (current && endpointId === current.integrationId) {
      model = current.model;
    } else if (choices.length === 0) {
      skip("no-model");
      continue;
    } else if (current && choices.includes(current.model)) {
      model = current.model;
    } else {
      model = choices[0];
      adjusted = true;
    }
    const thinking: ThinkingLevel | undefined = change.thinking === "inherit" ? undefined : change.thinking ?? current?.thinking;
    const next = normalizeRoutingTarget({ integrationId: endpointId, model, ...(thinking ? { thinking } : {}) }, task);
    if (!next) { skip("no-model"); continue; }
    if (current && sameTarget(current, next)) { outcome.unchanged.push(task); continue; }
    working = putRoute(working ?? outcome.routing, task, withTargetAt(route, level, next));
    outcome.changed.push(task);
    if (!current) outcome.created.push(task);
    if (adjusted) outcome.adjusted.push(task);
  }
  if (working) outcome.routing = working;
  return outcome;
}

export interface ClearOutcome {
  routing: Routing;
  /** Rows that had a target on the tab, and lost it. */
  cleared: RoutingTaskKind[];
  /** Rows whose first fallback became the primary, because the primary was cleared. */
  promoted: RoutingTaskKind[];
}

/** Takes the target of the rows off a tab: the later ones move up, and a cleared primary gives way to the first fallback. */
export function clearTargetAt(routing: Routing | undefined, tasks: readonly RoutingTaskKind[], level: number): ClearOutcome {
  const outcome: ClearOutcome = { routing: routing ?? {}, cleared: [], promoted: [] };
  let working: Routing | undefined;
  for (const task of tasks) {
    const route = (working ?? outcome.routing)[task];
    if (!targetAt(route, level)) continue;
    const next = withTargetAt(route, level, undefined);
    working = putRoute(working ?? outcome.routing, task, next);
    outcome.cleared.push(task);
    if (level === 0 && next?.primary) outcome.promoted.push(task);
  }
  if (working) outcome.routing = working;
  return outcome;
}

export interface SwapOutcome {
  routing: Routing;
  /** Rows whose two tabs exchanged their targets. */
  swapped: RoutingTaskKind[];
  /** Rows with nothing to exchange: nothing on either tab, or the same target on both. */
  unchanged: RoutingTaskKind[];
  /** Rows left as they were because the swap would leave a hole: a fallback with nothing before it. */
  skipped: Array<{ task: RoutingTaskKind; reason: "gap" }>;
}

/** Exchanges the whole target, thinking included, of two tabs for each row. */
export function swapLevels(routing: Routing | undefined, tasks: readonly RoutingTaskKind[], a: number, b: number): SwapOutcome {
  const outcome: SwapOutcome = { routing: routing ?? {}, swapped: [], unchanged: [], skipped: [] };
  if (a === b) {
    outcome.unchanged.push(...tasks);
    return outcome;
  }
  let working: Routing | undefined;
  for (const task of tasks) {
    const route = outcome.routing[task];
    const levels = positional(route);
    const size = Math.max(levels.length, a + 1, b + 1);
    const swapped: Array<RoutingTarget | undefined> = Array.from({ length: size }, (_, index) => levels[index]);
    const [first, second] = [swapped[a], swapped[b]];
    if ((first === undefined && second === undefined) || (first !== undefined && second !== undefined && sameTarget(first, second))) {
      outcome.unchanged.push(task);
      continue;
    }
    swapped[a] = second;
    swapped[b] = first;
    while (swapped.length > 0 && swapped[swapped.length - 1] === undefined) swapped.pop();
    if (swapped.some((entry) => entry === undefined)) {
      outcome.skipped.push({ task, reason: "gap" });
      continue;
    }
    working = putRoute(working ?? outcome.routing, task, fromLevels(swapped));
    outcome.swapped.push(task);
  }
  if (working) outcome.routing = working;
  return outcome;
}

export interface RemoveOutcome {
  routing: Routing;
  /** Rows that had a target on the deleted tab. */
  lost: RoutingTaskKind[];
  /** Rows that had targets after it, which moved up. */
  shifted: RoutingTaskKind[];
}

/** Deletes a tab of fallbacks from the rows: its targets go and the later tabs move up. The primary tab is never deleted. */
export function removeLevel(routing: Routing | undefined, tasks: readonly RoutingTaskKind[], level: number): RemoveOutcome {
  if (level < 1) throw new RangeError("The primary tab cannot be deleted");
  const outcome: RemoveOutcome = { routing: routing ?? {}, lost: [], shifted: [] };
  let working: Routing | undefined;
  for (const task of tasks) {
    const route = outcome.routing[task];
    const levels = positional(route);
    if (levels[level] === undefined) continue;
    working = putRoute(working ?? outcome.routing, task, withTargetAt(route, level, undefined));
    outcome.lost.push(task);
    if (levels.length > level + 1) outcome.shifted.push(task);
  }
  if (working) outcome.routing = working;
  return outcome;
}
