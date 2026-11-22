import { useEffect } from "react";
import { useProseEditorStore, type ProseEditorExtraAction } from "@/components/editor/proseEditorStore";

export function useRegisterProseEditor(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  handlers: { improve: (selection: string | null) => void; summarize?: (selection: string | null) => void; synonym: (selection: string) => void; merge?: () => void; extra?: ProseEditorExtraAction[]; labels?: { improveAll?: string; summaryAll?: string }; enabled?: boolean },
  /**
   * Extra reactive dependencies that should re-run registration. Pass values
   * that gate whether the textarea is mounted (e.g. a reader/edit view mode),
   * since `ref.current` alone is not reactive and would otherwise miss the
   * moment the textarea appears.
   */
  deps: React.DependencyList = [],
) {
  const register = useProseEditorStore((s) => s.register);
  useEffect(() => {
    const el = ref.current;
    if (!el || handlers.enabled === false) return;
    return register({ el, improve: handlers.improve, summarize: handlers.summarize, synonym: handlers.synonym, merge: handlers.merge, ...(handlers.extra?.length ? { extra: handlers.extra } : {}), ...(handlers.labels ? { labels: handlers.labels } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, handlers.enabled, handlers.merge, ...deps]);
}
