import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutopilotActivity } from "narrarium-engine";
import { candidateKey, fallbackSentence } from "@/autopilot/attemptModel";
import { activityTitle } from "@/autopilot/format";
import { LAST_DONE, PoliteAnnouncer, STREAM_THROTTLE_MS, latestFinished, listenToLiveVoice } from "@/autopilot/liveText";
import { useAutopilotStore, type LivePreview } from "@/autopilot/store";
import { useUiStore, type AutopilotTextDetail } from "@/store/uiStore";

const NO_ACTIVITIES: AutopilotActivity[] = [];

/** «Show the text»: what the panels of the autopilot show on this device, and the way to change it. */
export function useTextDetail(): [AutopilotTextDetail, (detail: AutopilotTextDetail) => void] {
  const detail = useUiStore((state) => state.autopilotText);
  const set = useUiStore((state) => state.setAutopilotText);
  return [detail === "compact" ? "compact" : "full", set];
}

/** The text a book's step is streaming, as the lines draw it. */
export interface StreamState {
  activity: AutopilotActivity;
  preview: string;
  characters: number;
  /** The text is the JSON of a structured reply (the premise of the concept, a plan…), not prose. */
  json: boolean;
  /** The call of the step the text belongs to. */
  call: string;
  /** A structured reply that has no text yet: only how much of it has arrived («answering… 12 KB»). */
  answering: boolean;
}

function streamOf(live: LivePreview | null | undefined): StreamState | null {
  if (!live) return null;
  return {
    activity: live.activity,
    preview: live.preview,
    characters: live.characters,
    json: live.json === true,
    call: live.callId ?? (live.callSeq === undefined ? "" : String(live.callSeq)),
    answering: live.bytes !== undefined && live.preview === "",
  };
}

/** Whether two states draw the same lines: the numbers of a reply that has words (its bytes) change nothing that is drawn. */
function sameStream(a: StreamState | null, b: StreamState | null): boolean {
  if (!a || !b) return a === b;
  return a.activity === b.activity && a.preview === b.preview && a.characters === b.characters && a.json === b.json && a.call === b.call && a.answering === b.answering;
}

/**
 * The text a book's step is streaming, followed at most once every `interval` milliseconds (four times a second): the lines are not drawn again for
 * every chunk. A step or a call that starts or ends, and the first words of a call, are followed at once.
 */
export function useThrottledStream(bookId: string, interval = STREAM_THROTTLE_MS): StreamState | null {
  const [value, setValue] = useState(() => streamOf(useAutopilotStore.getState().live[bookId]));
  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      timer = null;
      last = performance.now();
      const next = streamOf(useAutopilotStore.getState().live[bookId]);
      setValue((current) => (sameStream(current, next) ? current : next));
    };
    // What the store holds now (the book may have changed): drawn at once, and the next change too.
    setValue(streamOf(useAutopilotStore.getState().live[bookId]));
    const unsubscribe = useAutopilotStore.subscribe((state, previous) => {
      const next = state.live[bookId];
      const before = previous.live[bookId];
      if (next === before) return;
      // A step or a call that starts or ends, a text that turns from prose to JSON, and the first words of a call are drawn at once: the text of before
      // is not what goes on now.
      const callOf = (live: LivePreview) => live.callId ?? live.callSeq;
      if (!next || !before || next.activity.id !== before.activity.id || callOf(next) !== callOf(before) || (next.json === true) !== (before.json === true) || (before.preview === "") !== (next.preview === "")) {
        if (timer) clearTimeout(timer);
        apply();
        return;
      }
      if (timer) return;
      const wait = last + interval - performance.now();
      if (wait <= 0) apply();
      else timer = setTimeout(apply, wait);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [bookId, interval]);
  return value;
}

/** The last steps of a book that are over, the newest first: from its log, and from the feed for what the log does not have yet. */
export function useLastDone(bookId: string, limit = LAST_DONE): AutopilotActivity[] {
  const activities = useAutopilotStore((state) => state.views[bookId]?.snapshot?.activities ?? NO_ACTIVITIES);
  const feed = useAutopilotStore((state) => state.feed);
  const runningId = useAutopilotStore((state) => state.live[bookId]?.activity.id ?? null);
  const computed = useMemo(() => {
    const list = latestFinished(activities, feed.filter((entry) => entry.event.bookId === bookId).map((entry) => entry.event), { runningId, limit });
    return { list, key: list.map((activity) => `${activity.id}:${activity.status}:${activity.endedAt ?? ""}:${activity.title}`).join("|") };
  }, [activities, feed, bookId, runningId, limit]);
  // The same steps, the same list: what draws it is not drawn again for an event of another book.
  const kept = useRef(computed);
  if (kept.current.key !== computed.key) kept.current = computed;
  return kept.current.list;
}

/**
 * What the polite status of a surface says about the autopilot of some books: that a step is answering, that a call went on to a fallback (once for each fallback of a
 * step: the primary is the usual, and a status that said it at every call would never stop), that its answer is complete (with its characters) and the step done, or that it
 * failed or was cancelled. At most one message every ten seconds (`PoliteAnnouncer`); never the text that streams. `nameOf` names the book of each message, where several
 * books are followed (the page of every book).
 */
export function useStreamAnnouncements(bookIds: readonly string[], nameOf?: (bookId: string) => string | undefined): string {
  const { t, i18n } = useTranslation();
  const [message, setMessage] = useState("");
  const key = bookIds.join("\n");
  const names = useRef(nameOf);
  names.current = nameOf;
  useEffect(() => {
    const ids = new Set(key ? key.split("\n") : []);
    let reset: ReturnType<typeof setTimeout> | null = null;
    // Emptied first and written a moment later: the same words twice in a row are said twice.
    const announcer = new PoliteAnnouncer((text) => {
      setMessage("");
      if (reset) clearTimeout(reset);
      reset = setTimeout(() => setMessage(text), 60);
    }, undefined, () => performance.now());
    const answered = new Set<string>();
    // The fallback each step was last said to go on to.
    const fallbacks = new Map<string, string>();
    // The most each step has written in one of its calls: a step whose last call is short (the summary of the scene it wrote) is said with what it wrote.
    const written = new Map<string, number>();
    const say = (bookId: string, text: string) => {
      const book = names.current?.(bookId);
      return book ? t("autopilot.liveText.say.book", { book, message: text }) : text;
    };
    const unsubscribe = useAutopilotStore.subscribe((state, previous) => {
      if (state.live === previous.live) return;
      for (const bookId of ids) {
        const now = state.live[bookId];
        const before = previous.live[bookId];
        if (now === before) continue;
        if (now) written.set(now.activity.id, Math.max(written.get(now.activity.id) ?? 0, now.characters));
        if (before && (!now || now.activity.id !== before.activity.id)) {
          answered.delete(before.activity.id);
          fallbacks.delete(before.activity.id);
          const characters = Math.max(written.get(before.activity.id) ?? 0, before.characters);
          written.delete(before.activity.id);
          const finished = [...state.feed].reverse().find((entry) => entry.event.bookId === bookId && entry.event.type === "task-finished" && entry.event.activity.id === before.activity.id)?.event;
          if (finished?.type === "task-finished") {
            const step = activityTitle(t, finished.activity);
            const status = finished.activity.status;
            if (status === "failed") announcer.push(say(bookId, t("autopilot.liveText.say.failed", { step })), 3);
            else if (status === "cancelled") announcer.push(say(bookId, t("autopilot.liveText.say.cancelled", { step })), 2);
            else {
              const done = t("autopilot.liveText.say.done", { step });
              const value = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(characters);
              announcer.push(say(bookId, characters > 0 ? `${t("autopilot.liveText.say.complete", { count: characters, value })} ${done}` : done), 2);
            }
          }
        }
        if (now && !answered.has(now.activity.id) && (now.characters > 0 || now.bytes !== undefined)) {
          answered.add(now.activity.id);
          announcer.push(say(bookId, t("autopilot.liveText.say.answering")), 1);
        }
        if (now?.trying?.fallback && now.trying !== before?.trying && fallbacks.get(now.activity.id) !== candidateKey(now.trying)) {
          fallbacks.set(now.activity.id, candidateKey(now.trying));
          announcer.push(say(bookId, fallbackSentence(t, now.trying)), 2);
        }
      }
    });
    // What the rest of the page says about these books (the calls the task view follows) goes through the same voice, at the same pace.
    const stopListening = listenToLiveVoice((bookId, text, priority) => {
      if (ids.has(bookId)) announcer.push(say(bookId, text), priority);
    });
    return () => {
      unsubscribe();
      stopListening();
      announcer.dispose();
      if (reset) clearTimeout(reset);
    };
  }, [key, t, i18n]);
  return message;
}
