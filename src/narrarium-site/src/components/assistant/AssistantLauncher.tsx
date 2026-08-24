import { Bot, Ghost } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistantStore } from "@/assistant/store";
import { useUiStore } from "@/store/uiStore";

export function AssistantLauncher() {
  const { t } = useTranslation();
  const hidden = useUiStore((state) => state.floatingHidden);
  const launch = useAssistantStore((state) => state.launch);
  if (hidden) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex overflow-hidden rounded-full shadow-lg lg:bottom-6 lg:right-6">
      <button type="button" className="flex items-center gap-2 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" onClick={() => launch("chat")}>
        <Bot className="h-4 w-4" />{t("assistant.floatingButton")}
      </button>
      <span className="w-px self-stretch bg-primary-foreground/20" />
      <button type="button" className="flex items-center justify-center bg-primary px-3 py-2.5 text-primary-foreground transition hover:bg-primary/90" title={t("assistant.liveVoice")} onClick={() => launch("voice")}>
        <Ghost className="h-5 w-5" />
      </button>
    </div>
  );
}
