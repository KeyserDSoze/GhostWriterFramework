import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiCallField } from "narrarium-engine";
import type { CallsSource } from "@/autopilot/calls/source";
import { pollWhileVisible } from "@/autopilot/calls/sourcePoll";
import { useAutopilotStore } from "@/autopilot/store";
import { TextBuffer, charactersOfBytes } from "@/components/autopilot/calls/textBuffer";

/** A pane is drawn again at most this often while its text grows (four times a second). */
export const PANE_UPDATE_MS = 250;

/** What the live events say of a running response beyond what its record keeps. */
export interface LiveTail {
  /** The part of the tail of the live events that is not in the record yet, drawn after it. */
  extra: string;
  /** The bytes of a reply that answers with a value (it has no prose to show), as the live events count them; null for prose. */
  bytes: number | null;
}

/** What a pane draws of one text of a call. `buffer` holds the text; `version` changes, at most four times a second, when it did. */
export interface CallText {
  buffer: TextBuffer;
  version: number;
  loading: boolean;
  /** The text is whole: the call has ended and everything it kept was read. */
  done: boolean;
  error: unknown;
  /** How many times the response started again (a new provider attempt) while it was followed. */
  restarts: number;
  tail: LiveTail;
  retry(): void;
}

/** Calls `apply` at most once every `ms`; the last call is always applied. Stable for the life of the component. */
function useThrottle(apply: () => void, ms: number): { run: () => void; cancel: () => void } {
  const latest = useRef(apply);
  latest.current = apply;
  const throttle = useMemo(() => {
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      timer = null;
      last = performance.now();
      latest.current();
    };
    return {
      run: () => {
        if (timer !== null) return;
        const wait = last + ms - performance.now();
        if (wait <= 0) fire();
        else timer = setTimeout(fire, wait);
      },
      cancel: () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    };
  }, [ms]);
  useEffect(() => throttle.cancel, [throttle]);
  return throttle;
}

/** How many characters of the end of what is kept must be the same in the tail of the live events for the tail to go on after it. */
const OVERLAP = 48;

/**
 * The part of the live tail that comes after the text the record keeps: the record is a little behind (it is written every two seconds), the live
 * events carry the last characters of the text so far (`preview`) and how long the whole text is (`total`). The tail goes on where the record ends
 * (`keptLength` characters, the last of which are `keptEnd`), when the characters just before that place are the same in both; otherwise (the record
 * is further behind than the tail reaches, or it keeps the text with a key taken out) it is looked for once in the tail, and nothing when it is not
 * found exactly once. With nothing kept yet, the whole tail.
 */
export function tailBeyond(keptEnd: string, keptLength: number, preview: string, total: number): string {
  if (!preview) return "";
  if (keptLength === 0) return preview;
  const at = keptLength - (total - preview.length);
  if (at >= 0 && at <= preview.length) {
    const check = Math.min(at, keptEnd.length, OVERLAP);
    if (check > 0 && preview.slice(at - check, at) === keptEnd.slice(keptEnd.length - check)) return preview.slice(at);
  }
  const probe = keptEnd.slice(-OVERLAP);
  if (probe.length < OVERLAP) return "";
  const first = preview.indexOf(probe);
  if (first < 0 || preview.indexOf(probe, first + 1) >= 0) return "";
  return preview.slice(first + probe.length);
}

export interface CallTextOptions {
  source: CallsSource;
  bookId: string;
  callId: string;
  field: AiCallField;
  /** The response of one provider attempt (from 1); the last one with text when omitted. */
  attempt?: number;
  /** The call is still running: its text is asked for again until it ends. */
  running: boolean;
  /** The step whose live events are about this running response: the end of their tail is drawn after what the record keeps. */
  liveActivityId?: string | null;
  /** The response started again with a new provider attempt (the one before stopped). */
  onRestart?: () => void;
}

interface Flags {
  loading: boolean;
  done: boolean;
  error: unknown;
  restarts: number;
}

const NO_TAIL: LiveTail = { extra: "", bytes: null };

/**
 * Reads one text of a call (its system, its user or its response) and, while the call runs, asks for what was added since (from the byte it has, once a
 * second from a personal server, more often from this browser, never while the page is hidden), adding it at the end of what it has. A running response
 * is read attempt by attempt: when the one it follows stops growing the next one is looked for, and once that has begun the text starts again with it.
 * While the record is behind, the end of the tail of the live events is drawn after it; before it has anything, the tail alone. One pace for both: at
 * most four drawings a second.
 */
export function useCallText({ source, bookId, callId, field, attempt, running, liveActivityId = null, onRestart }: CallTextOptions): CallText {
  const holder = useRef<TextBuffer | null>(null);
  holder.current ??= new TextBuffer();
  const buffer = holder.current;
  const live = useRef(running);
  live.current = running;
  const restart = useRef(onRestart);
  restart.current = onRestart;
  const flags = useRef<Flags>({ loading: true, done: false, error: null, restarts: 0 });
  const preview = useRef<{ text: string; bytes: number | null; characters: number } | null>(null);
  const [state, setState] = useState<Flags & { version: number; tail: LiveTail }>({ loading: true, done: false, error: null, restarts: 0, version: 0, tail: NO_TAIL });
  const [reload, setReload] = useState(0);

  const render = useThrottle(() => {
    const live = preview.current;
    const tail: LiveTail = !live ? NO_TAIL : live.bytes !== null ? { extra: "", bytes: live.bytes } : { extra: tailBeyond(buffer.tail(OVERLAP), buffer.characters, live.text, live.characters), bytes: null };
    setState({ ...flags.current, version: buffer.version, tail });
  }, PANE_UPDATE_MS);

  // The text the record keeps, asked for again while the call runs.
  useEffect(() => {
    buffer.clear();
    flags.current = { loading: true, done: false, error: null, restarts: 0 };
    let offset = 0;
    let current = attempt ?? (field === "response" && live.current ? 1 : undefined);
    let cancelled = false;
    const read = async (): Promise<boolean> => {
      const chunk = await source.readText(bookId, callId, field, { from: offset, ...(current === undefined ? {} : { attempt: current }) });
      if (cancelled) return false;
      flags.current.loading = false;
      flags.current.error = null;
      if (!chunk) {
        flags.current.done = !live.current;
        render.run();
        return live.current;
      }
      if (chunk.next < offset) {
        // What is kept is shorter than what was read: the text was written again from its start.
        buffer.clear();
        offset = 0;
        render.run();
        return true;
      }
      const before = buffer.characters;
      const skip = chunk.from < offset ? charactersOfBytes(chunk.text, offset - chunk.from) : 0;
      buffer.append(chunk.text.slice(skip));
      offset = Math.max(offset, chunk.next);
      if (field === "response" && attempt === undefined && current !== undefined && live.current && !chunk.done && buffer.characters === before) {
        // The attempt it follows did not grow: has the next one begun?
        const next = await source.readText(bookId, callId, field, { from: 0, attempt: current + 1 });
        if (cancelled) return false;
        if (next?.text) {
          current += 1;
          buffer.replace(next.text);
          offset = next.next;
          flags.current.restarts += 1;
          restart.current?.();
        }
      }
      flags.current.done = chunk.done;
      render.run();
      return !chunk.done && live.current;
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      flags.current.loading = false;
      flags.current.error = error;
      render.run();
    };
    let stop: () => void = () => undefined;
    if (live.current) {
      stop = pollWhileVisible(async () => {
        try {
          return await read();
        } catch (error) {
          fail(error);
          throw error;
        }
      }, source.pollMs);
    } else {
      read().catch(fail);
    }
    return () => {
      cancelled = true;
      stop();
      render.cancel();
    };
    // `running` is read through its ref: a call that ends is not read again from its start.
  }, [source, bookId, callId, field, attempt, reload, buffer, render]);

  // A call that the page learns is running after the pane opened (its record was behind) is followed from then on.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current && !flags.current.done) setReload((key) => key + 1);
    wasRunning.current = running;
  }, [running]);

  // The tail of the live events of the running step, drawn after what the record has.
  const followed = field === "response" ? liveActivityId : null;
  useEffect(() => {
    const update = () => {
      const now = followed ? useAutopilotStore.getState().live[bookId] : null;
      const next = now && now.activity.id === followed ? { text: now.preview, bytes: now.bytes ?? null, characters: now.characters } : null;
      if (next?.text === preview.current?.text && next?.bytes === preview.current?.bytes && next?.characters === preview.current?.characters) return;
      preview.current = next;
      render.run();
    };
    update();
    if (!followed) return undefined;
    return useAutopilotStore.subscribe((now, before) => {
      if (now.live[bookId] !== before.live[bookId]) update();
    });
  }, [followed, bookId, render]);

  const retry = useCallback(() => setReload((key) => key + 1), []);
  return { buffer, version: state.version, loading: state.loading, done: state.done, error: state.error, restarts: state.restarts, tail: state.tail, retry };
}
