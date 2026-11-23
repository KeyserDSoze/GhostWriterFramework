import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Ghost } from "lucide-react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { useAssistantStore } from "@/assistant/store";
import { useUiStore } from "@/store/uiStore";

/** How many bars of actions of a page hold the floating buttons now: while one does, they do not float over the page. */
export const useFloatingBar = create<{ hosts: number }>(() => ({ hosts: 0 }));

/**
 * The floating buttons of the app (the Copilot and its voice) in the bar of actions a page keeps at the bottom of a phone (the Live page of the
 * autopilot): there they stood above the bar, over the tabs and the text. While this is on the screen they do not float; they come back with the
 * pages that have no bar. Hidden with the floating buttons when the author hid them.
 */
export function FloatingInBar() {
  const { t } = useTranslation();
  const hidden = useUiStore((state) => state.floatingHidden);
  const launch = useAssistantStore((state) => state.launch);
  useEffect(() => {
    useFloatingBar.setState((state) => ({ hosts: state.hosts + 1 }));
    return () => useFloatingBar.setState((state) => ({ hosts: Math.max(0, state.hosts - 1) }));
  }, []);
  if (hidden) return null;
  return (
    <span data-floating-in-bar className="ml-auto inline-flex shrink-0 items-center gap-1">
      <Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-full" aria-label={t("assistant.floatingButton")} title={t("assistant.floatingButton")} onClick={() => launch("chat")}>
        <Bot className="h-5 w-5" aria-hidden="true" />
      </Button>
      <Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-full" aria-label={t("assistant.liveVoice")} title={t("assistant.liveVoice")} onClick={() => launch("voice")}>
        <Ghost className="h-5 w-5" aria-hidden="true" />
      </Button>
    </span>
  );
}
