import { autopilotLiveHref } from "@/autopilot/pageRoute";

/**
 * The anchors of the AI calls on the Autopilot page: `#call-<callId>`, which opens the step of the call in the history, opens the call and gives it the
 * focus. A call's id is its step's activity id and its number in the step (`activity_<uuid>-0003`, the engine's `aiCallIdOf`), so the step is read
 * from it.
 */

/** The prefix of the anchor of a call: `#call-<call id>`. */
export const CALL_HASH_PREFIX = "call-";

/** The id of the element of a call in the task view, which a link to it points at. */
export function callElementId(callId: string): string {
  return `${CALL_HASH_PREFIX}${callId}`;
}

/** The call a hash points at (`#call-activity_…-0003`), or null when it points at something else. */
export function callIdOfHash(hash: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  if (!id.startsWith(CALL_HASH_PREFIX)) return null;
  const callId = id.slice(CALL_HASH_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,160}$/.test(callId) ? callId : null;
}

/** The step (its activity id) of a call: the call's id without its number. Null for an id that is not a call's. */
export function activityOfCallId(callId: string): string | null {
  const match = /^(.+)-\d{4,}$/.exec(callId);
  return match ? match[1] : null;
}

/** The step of the call a hash points at, or null. */
export function activityOfCallHash(hash: string): string | null {
  const callId = callIdOfHash(hash);
  return callId ? activityOfCallId(callId) : null;
}

/** The address of a call on the Autopilot page of its book. */
export function callHref(bookId: string, callId: string): string {
  return `${autopilotLiveHref(bookId)}#${encodeURIComponent(callElementId(callId))}`;
}
