import type { AutopilotActivity, AutopilotEventBody, AutopilotLive } from "./types.js";

/** A `task-progress` event, as `applyLiveProgress` reads it (with or without the fields of the stream). */
export type AutopilotTaskProgress = Omit<Extract<AutopilotEventBody, { type: "task-progress" }>, "type">;

/** The live part of a step that has just started: no call of it has said anything yet. */
export function startLive(activity: AutopilotActivity): AutopilotLive {
  return { activity, characters: 0, preview: "" };
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The names of the call an event or a live part belongs to. */
function callOf(source: { callSeq?: number; callId?: string }): Pick<AutopilotLive, "callSeq" | "callId"> {
  return { ...(source.callSeq !== undefined ? { callSeq: source.callSeq } : {}), ...(source.callId !== undefined ? { callId: source.callId } : {}) };
}

/**
 * How a `task-progress` of the step that runs changes what is shown of it. One rule for every host (the session's `snapshot().live`, the panels of the
 * web app), so that what is shown never flickers:
 * - A call of the step starts from nothing: a progress of another call (`callSeq` or `callId` changed; from an engine that names no calls, prose after a
 *   structured reply, a structured reply after prose, or bytes that went back) shows nothing of the call before it.
 * - Prose (`preview` and `characters`, no `bytes`, no `kind`) is the text so far of a prose call: it replaces what was shown. A shorter one is a new
 *   attempt of the call, which takes the place of the one before; the empty text that says a new attempt begins changes nothing, so the text of the
 *   attempt before stays on screen until the new one has written something.
 * - The JSON of a structured reply (`kind: "json"`) is shown as its text, with its count, by the same rule, and marks the text as JSON (`json`). It does
 *   not take away the bytes the reply said, unless it is shorter: then the bytes were the ones of the attempt before.
 * - The numbers of a structured reply (`bytes`) set the bytes, and the count while no JSON is shown, never lower. They never change the text: the tail
 *   they carry is the one the JSON already said (or, from an older engine, the one of the call before), so a reply that streams its JSON keeps it on
 *   screen while its numbers arrive, and a reply that does not shows «answering» with its bytes.
 * A progress of another step changes nothing.
 */
export function applyLiveProgress(live: AutopilotLive, event: AutopilotTaskProgress): AutopilotLive {
  if (event.activityId !== live.activity.id) return live;
  const bytes = count(event.bytes);
  const kind = event.kind === "json" ? "json" : bytes !== undefined ? "bytes" : "prose";
  const characters = count(event.characters) ?? 0;
  // An event without a preview (a host that leaves it out) keeps the text that is shown.
  const preview = typeof event.preview === "string" ? event.preview : undefined;
  const named = event.callSeq !== undefined || event.callId !== undefined;
  const anotherCall = (event.callSeq !== undefined && event.callSeq !== live.callSeq) || (event.callId !== undefined && event.callId !== live.callId);
  const structured = live.json === true || live.bytes !== undefined;
  const wentBack = kind === "bytes" && live.bytes !== undefined && bytes !== undefined && bytes < live.bytes;
  const otherKind = !named && (kind === "prose" ? structured : (!structured && (live.preview !== "" || live.characters > 0)) || wentBack);
  const base: AutopilotLive = anotherCall || otherKind ? { activity: live.activity, characters: 0, preview: "", ...callOf(event) } : { ...live, ...callOf(event) };
  // A new attempt begins (its text is empty): what the attempt before wrote stays until the new one writes.
  if (kind !== "bytes" && preview === "" && characters === 0 && !(anotherCall || otherKind)) return base;
  if (kind === "prose") return { activity: base.activity, characters, preview: preview ?? base.preview, ...callOf(base) };
  if (kind === "json") {
    const { bytes: _before, ...text } = base;
    return { ...(base.json && characters < base.characters ? text : base), json: true, characters, preview: preview ?? base.preview };
  }
  return { ...base, bytes, ...(base.json ? {} : { characters: Math.max(base.characters, characters) }) };
}

/** A live part read from somewhere else (a snapshot of another host, an older one): its fields as `AutopilotLive` has them, or null. */
export function normalizeLive(value: unknown): AutopilotLive | null {
  if (!value || typeof value !== "object") return null;
  const live = value as Partial<AutopilotLive>;
  if (!live.activity || typeof live.activity !== "object" || typeof live.activity.id !== "string") return null;
  const bytes = count(live.bytes);
  return {
    activity: live.activity,
    characters: count(live.characters) ?? 0,
    preview: typeof live.preview === "string" ? live.preview : "",
    ...(live.json === true ? { json: true } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...callOf({ ...(typeof live.callSeq === "number" ? { callSeq: live.callSeq } : {}), ...(typeof live.callId === "string" ? { callId: live.callId } : {}) }),
  };
}
