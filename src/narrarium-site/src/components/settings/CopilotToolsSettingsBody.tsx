import { AlertTriangle, CheckCircle2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { AppSettings } from "@/types/settings";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { localizeCopilotToolArea, localizeCopilotToolPrerequisite, localizeCopilotToolText } from "@/assistant/tools/presentation";
import { copilotToolRegistry, isCopilotToolEnabled } from "@/assistant/tools/registry";

ensureBuiltinCopilotToolsRegistered();

export function CopilotToolsSettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t, i18n } = useTranslation();
  const tools = copilotToolRegistry.list();
  const safeTools = tools.filter((tool) => !tool.destructive);
  const dangerousTools = tools.filter((tool) => tool.destructive);

  function setToolEnabled(toolId: string, enabled: boolean) {
    patchSettings({
      copilotTools: {
        toolOverrides: {
          ...settings.copilotTools.toolOverrides,
          [toolId]: { enabled },
        },
      },
    });
  }

  function renderToolRow(toolId: string) {
    const tool = copilotToolRegistry.get(toolId)!;
    const enabled = isCopilotToolEnabled(settings, tool);
    const language = i18n.language;
    const name = localizeCopilotToolText(tool, "name", language);
    const description = localizeCopilotToolText(tool, "description", language);
    const output = localizeCopilotToolText(tool, "output", language);
    return (
      <div key={tool.id} className="rounded-xl border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{name}</p>
              <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? t("copilotTools.enabled") : t("copilotTools.disabled")}</Badge>
              <Badge variant="outline">{localizeCopilotToolArea(tool.area, language)}</Badge>
              {tool.requiresLlm ? <Badge variant="outline">{t("copilotTools.badges.llm", { defaultValue: "LLM" })}</Badge> : <Badge variant="outline">{t("copilotTools.badges.local", { defaultValue: "Local" })}</Badge>}
              {tool.mutatesData ? <Badge variant="outline">{t("copilotTools.badges.write", { defaultValue: "Write" })}</Badge> : <Badge variant="outline">{t("copilotTools.badges.read", { defaultValue: "Read" })}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("copilotTools.output")}: {output}</p>
            {tool.prerequisites.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t("copilotTools.prerequisites")}: {tool.prerequisites.map((value) => localizeCopilotToolPrerequisite(value, language)).join(", ")}</p>}
          </div>
          <Button type="button" variant={enabled ? "default" : "outline"} size="sm" onClick={() => setToolEnabled(tool.id, !enabled)}>
            {enabled ? t("copilotTools.turnOff") : t("copilotTools.turnOn")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground"><CheckCircle2 className="h-4 w-4 text-primary" />{t("copilotTools.introTitle")}</p>
        <p className="mt-1">{t("copilotTools.introBody")}</p>
      </div>

      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Wand2 className="h-4 w-4 text-primary" />{t("copilotTools.safeToolsTitle")}</p>
        <div className="space-y-3">
          {safeTools.map((tool) => renderToolRow(tool.id))}
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground"><AlertTriangle className="h-4 w-4 text-amber-500" />{t("copilotTools.warningTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("copilotTools.warningBody")}</p>
        </div>
        <div className="space-y-3">
          {dangerousTools.map((tool) => renderToolRow(tool.id))}
        </div>
      </div>
    </div>
  );
}
