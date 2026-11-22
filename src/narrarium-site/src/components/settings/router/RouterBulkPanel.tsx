import { useId, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { commonModelChoices, takesThinking, taskIntegrationChoices } from "@/router/routerTableModel";
import { THINKING_LEVELS, type AIIntegration, type RoutingTaskKind } from "@/types/settings";
import { INHERIT, TRIGGER, modelLabel, thinkingText } from "./RouterCells";

/** What the author has chosen to change so far; an empty string leaves that part as it is. Nothing is saved until «Apply». */
export interface BulkDraft {
  endpointId: string;
  model: string;
  thinking: string;
}

export const EMPTY_DRAFT: BulkDraft = { endpointId: "", model: "", thinking: "" };

const KEEP = "__keep__";

interface RouterBulkPanelProps {
  tasks: readonly RoutingTaskKind[];
  tabName: string;
  integrations: AIIntegration[];
  /** The endpoint every selected row that has a target on the tab already uses, when there is just one. */
  commonEndpointId: string | undefined;
  draft: BulkDraft;
  onDraft: (draft: BulkDraft) => void;
  onApply: () => void;
  firstControl: Ref<HTMLButtonElement>;
}

/** «N selected»: endpoint, then model, then thinking, for all the selected rows of the tab at once. */
export function RouterBulkPanel({ tasks, tabName, integrations, commonEndpointId, draft, onDraft, onApply, firstControl }: RouterBulkPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const endpoints = taskIntegrationChoices(integrations, "default", t("routing.browser"));
  const catalogEndpointId = draft.endpointId || commonEndpointId;
  const models = catalogEndpointId ? commonModelChoices(integrations, catalogEndpointId, tasks) : [];
  const noTools = t("routing.warn.noToolCalls");
  const hasChange = Boolean(draft.endpointId || draft.model || draft.thinking);
  return (
    <div role="group" aria-labelledby={titleId} className="space-y-2 rounded-lg border border-primary/40 bg-accent p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong id={titleId} className="text-sm">{t("routing.bulk.title", { count: tasks.length })}</strong>
        <span className="text-xs text-muted-foreground">{t("routing.bulk.help", { tab: tabName })}</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-40 flex-1 gap-1 sm:max-w-56">
          <span className="text-xs font-semibold">{t("routing.bulk.endpointStep")}</span>
          <Select value={draft.endpointId || KEEP} onValueChange={(value) => onDraft({ ...draft, endpointId: value === KEEP ? "" : value, model: "" })}>
            <SelectTrigger ref={firstControl} aria-label={t("routing.bulk.endpointLabel")} className={TRIGGER}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>{t("routing.bulk.keep")}</SelectItem>
              {endpoints.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-40 flex-1 gap-1 sm:max-w-64">
          <span className="text-xs font-semibold">{t("routing.bulk.modelStep")}</span>
          <Select value={draft.model || KEEP} onValueChange={(value) => onDraft({ ...draft, model: value === KEEP ? "" : value })} disabled={!catalogEndpointId}>
            <SelectTrigger aria-label={t("routing.bulk.modelLabel")} className={TRIGGER}>
              {catalogEndpointId ? <SelectValue /> : <span className="text-muted-foreground">{t("routing.bulk.chooseEndpointFirst")}</span>}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>{draft.endpointId ? t("routing.bulk.keepModel") : t("routing.bulk.keep")}</SelectItem>
              {models.map((model) => <SelectItem key={model} value={model}>{modelLabel(integrations, catalogEndpointId!, model, noTools)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-40 flex-1 gap-1 sm:max-w-56">
          <span className="text-xs font-semibold">{t("routing.bulk.thinkingStep")}</span>
          <Select value={draft.thinking || KEEP} onValueChange={(value) => onDraft({ ...draft, thinking: value === KEEP ? "" : value })}>
            <SelectTrigger aria-label={t("routing.bulk.thinkingLabel")} className={TRIGGER}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>{t("routing.bulk.keepThinking")}</SelectItem>
              <SelectItem value={INHERIT}>{thinkingText(INHERIT, undefined, t)}</SelectItem>
              {THINKING_LEVELS.map((level) => <SelectItem key={level} value={level}>{thinkingText(level, undefined, t)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" disabled={!hasChange} onClick={onApply}>{t("routing.bulk.apply", { count: tasks.length })}</Button>
      </div>
      {!catalogEndpointId && <p className="text-xs text-muted-foreground">{t("routing.bulk.needEndpoint")}</p>}
      {draft.thinking && tasks.some((task) => !takesThinking(task)) && <p className="text-xs text-muted-foreground">{t("routing.bulk.defaultThinking")}</p>}
    </div>
  );
}
