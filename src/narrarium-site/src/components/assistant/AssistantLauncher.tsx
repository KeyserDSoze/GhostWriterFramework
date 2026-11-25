import { Bot, Ghost } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistantStore } from "@/assistant/store";
import { useUiStore } from "@/store/uiStore";
import { AutopilotLauncher } from "@/components/autopilot/AutopilotLauncher";

export function AssistantLauncher() {
  const { t } = useTranslation();
  const hidden = useUiStore((state) => state.floatingHidden);
  const launch = useAssistantStore((state) => state.launch);
  // The page's own launcher (the Synopsis puts Brainstorming's) comes first, and the Copilot's keeps only its icon on a narrow screen.
  const pageLauncher = useAssistantStore((state) => state.pageLauncher);
  if (hidden) return null;
  return (
    <div className="fixed bottom-[calc(1rem+var(--bottom-reserve,0px))] right-4 z-40 flex items-center gap-2 lg:bottom-[calc(1.5rem+var(--bottom-reserve,0px))] lg:right-6">
      <AutopilotLauncher />
      {pageLauncher?.()}
      <div className="flex shrink-0 overflow-hidden rounded-full shadow-lg">
        <button type="button" className="flex items-center gap-2 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" onClick={() => launch("chat")}>
          <Bot className="h-4 w-4" aria-hidden={pageLauncher ? true : undefined} /><span className={pageLauncher ? "sr-only sm:not-sr-only" : undefined}>{t("assistant.floatingButton")}</span>
        </button>
        <span className="w-px self-stretch bg-primary-foreground/20" />
        <button type="button" className="flex items-center justify-center bg-primary px-3 py-2.5 text-primary-foreground transition hover:bg-primary/90" title={t("assistant.liveVoice")} onClick={() => launch("voice")}>
          <Ghost className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
