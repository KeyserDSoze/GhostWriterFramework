import { useEffect } from "react";
import { useProseEditorStore } from "@/components/editor/proseEditorStore";

export function useRegisterProseEditor(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  handlers: { improve: (selection: string | null) => void; summarize?: (selection: string | null) => void; synonym: (selection: string) => void; enabled?: boolean },
) {
  const register = useProseEditorStore((s) => s.register);
  useEffect(() => {
    const el = ref.current;
    if (!el || handlers.enabled === false) return;
    return register({ el, improve: handlers.improve, summarize: handlers.summarize, synonym: handlers.synonym });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, handlers.enabled]);
}
