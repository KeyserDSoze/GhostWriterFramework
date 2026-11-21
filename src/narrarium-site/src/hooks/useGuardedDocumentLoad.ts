import { useCallback, useEffect, useRef, useState } from "react";

export type LoadedDocumentAction = "apply" | "keep" | "notify";

/**
 * What a document read while its form is open does to the form. Unsaved edits are never replaced:
 * a clean form follows the newest version, a form with edits keeps them and only learns that the
 * document changed underneath. Another document replaces the form, because leaving the previous
 * one (and its edits) was already confirmed.
 */
export function decideLoadedDocument(input: {
  loadedBefore: boolean;
  otherDocument: boolean;
  edited: boolean;
  /** Version the form is based on, and the version just read (`null`: the document does not exist). */
  baseVersion: string | null;
  version: string | null;
}): LoadedDocumentAction {
  if (!input.loadedBefore || input.otherDocument || !input.edited) return "apply";
  return input.version === input.baseVersion ? "keep" : "notify";
}

export interface GuardedDocumentLoadOptions<T> {
  /** What is being edited, such as the book and the profile; `null` while there is nothing to read yet. */
  document: string | null;
  /** Anything else the read depends on (branch, language): reading again never replaces unsaved edits. */
  source: string;
  /** Read the document. `version` identifies exactly what was read (`null`: it does not exist). */
  load: () => Promise<{ value: T; version: string | null }>;
  /** The form holds changes that are not saved. */
  edited: boolean;
  /** Put a document into the form. */
  apply: (value: T) => void;
  onLoading?: (loading: boolean) => void;
  onError: (error: unknown) => void;
}

/**
 * Load a document into a form and read it again when its source changes, without ever discarding
 * the author's unsaved edits. The callbacks may change on every render (they are read when needed);
 * only `document`, `source` and `reload()` start a new read.
 */
export function useGuardedDocumentLoad<T>(options: GuardedDocumentLoadOptions<T>) {
  const latest = useRef(options);
  latest.current = options;
  const base = useRef<{ document: string; version: string | null } | null>(null);
  const forced = useRef(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [round, setRound] = useState(0);
  const { document, source } = options;

  useEffect(() => {
    if (!document) return;
    const force = forced.current;
    let cancelled = false;
    let finished = false;
    latest.current.onLoading?.(true);
    latest.current.load()
      .then(({ value, version }) => {
        if (cancelled) return;
        forced.current = false;
        const current = base.current;
        const action = force ? "apply" : decideLoadedDocument({ loadedBefore: Boolean(current), otherDocument: current?.document !== document, edited: latest.current.edited, baseVersion: current?.version ?? null, version });
        if (action === "apply") {
          base.current = { document, version };
          latest.current.apply(value);
        }
        setChangedElsewhere(action === "notify");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        forced.current = false;
        latest.current.onError(error);
      })
      .finally(() => {
        finished = true;
        if (!cancelled) latest.current.onLoading?.(false);
      });
    return () => {
      cancelled = true;
      if (!finished) latest.current.onLoading?.(false);
    };
  }, [document, source, round]);

  /** Read the document again and replace the form, discarding unsaved edits: the author asked for it. */
  const reload = useCallback(() => {
    forced.current = true;
    setRound((value) => value + 1);
  }, []);
  /** The version the form is based on (`null`: the document did not exist), `undefined` before the first read. */
  const baseVersion = useCallback(() => base.current?.version, []);
  /** The form was saved: `version` is the new base. */
  const adopt = useCallback((version: string | null) => {
    if (base.current) base.current = { ...base.current, version };
    setChangedElsewhere(false);
  }, []);
  /** A save was refused because the document changed since it was read. */
  const flagChanged = useCallback(() => setChangedElsewhere(true), []);

  /** `changedElsewhere`: the document changed since the form was filled, and the unsaved edits were kept. */
  return { changedElsewhere, reload, baseVersion, adopt, flagChanged };
}
