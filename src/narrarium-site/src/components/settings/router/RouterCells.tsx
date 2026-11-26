import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { integrationChatModels } from "@/assistant/llm";
import { BROWSER_ROUTING_ID } from "@/assistant/router";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { modelChoicesFor, taskIntegrationChoices, type RouterRow } from "@/router/routerTableModel";
import { THINKING_LEVELS, type AIIntegration, type ThinkingLevel } from "@/types/settings";

/** Values of the choices that are not an endpoint, a model or a level: Radix does not take an empty value. */
export const CLEAR = "__clear__";
export const INHERIT = "__inherit__";

/** A trigger in a table: one line, cut with an ellipsis (the shared one wraps at the spaces, then clips), text kept to the left. */
export const TRIGGER = "h-8 min-w-0 px-2 text-left text-sm disabled:bg-muted disabled:opacity-100 [&>span]:block [&>span]:truncate";

/** The grid of a cell lets its one column shrink below the width of the longest value, which the trigger then cuts. */
const CELL = "grid grid-cols-[minmax(0,1fr)] gap-1";

const dim = (text: string): ReactNode => <span className="text-muted-foreground">{text}</span>;

interface CellProps {
  row: RouterRow;
  integrations: AIIntegration[];
  /** The visible name of the task, for the accessible name of each control. */
  taskLabel: string;
  tabName: string;
}

/** The text a row without a target of its own shows in a cell: what the router would use, dimmed, and the task whose route it is when the row follows one. */
function effectiveText(row: RouterRow, value: string | undefined, t: (key: string, options?: Record<string, unknown>) => string): string | undefined {
  if (!row.effective || !value) return undefined;
  if (row.follows) return t("routing.cell.follows", { task: t(`routing.task.${row.follows}`), value });
  return t(row.task === "default" ? "routing.cell.automatic" : "routing.cell.default", { value });
}

export function EndpointCell({ row, integrations, taskLabel, tabName, onChange }: CellProps & { onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const choices = taskIntegrationChoices(integrations, row.task, t("routing.browser"));
  const target = row.target;
  const missing = target && !choices.some((choice) => choice.id === target.integrationId);
  const effective = row.effective ? effectiveText(row, row.effective.browser ? t("routing.browser") : row.effective.integrationName, t) : undefined;
  const placeholder = effective ?? (row.level >= 1 ? t("routing.cell.noFallback") : row.routed ? t("routing.cell.noPrimary") : t("routing.cell.none"));
  const blocked = Boolean(row.blocked) && !target;
  return (
    <div className={CELL}>
      <Select value={target?.integrationId ?? ""} onValueChange={onChange} disabled={blocked}>
        <SelectTrigger aria-label={t("routing.cell.endpoint", { task: taskLabel, tab: tabName })} className={TRIGGER}>
          <SelectValue placeholder={dim(placeholder)} />
        </SelectTrigger>
        <SelectContent>
          {target && <SelectItem value={CLEAR}>{row.level === 0 ? t("routing.cell.clearPrimary") : t("routing.cell.noFallback")}</SelectItem>}
          {choices.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}
          {missing && <SelectItem value={target.integrationId} disabled>{t("routing.cell.gone", { name: target.integrationId })}</SelectItem>}
        </SelectContent>
      </Select>
      {blocked && <p className="text-xs text-muted-foreground">{row.blocked === "no-primary" ? t("routing.cell.needPrimary") : t("routing.cell.needFallback", { n: row.level - 1 })}</p>}
    </div>
  );
}

/** Chat models that cannot call tools say so in the list, as they do in the integration's own editor. */
export function modelLabel(integrations: AIIntegration[], integrationId: string, model: string, noTools: string): string {
  const integration = integrations.find((entry) => entry.id === integrationId);
  const entry = integration ? integrationChatModels(integration).find((candidate) => candidate.name === model) : undefined;
  return entry?.supportsToolCalls === false ? `${model} · ${noTools}` : model;
}

export function ModelCell({ row, integrations, taskLabel, tabName, onChange }: CellProps & { onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const target = row.target;
  if (target?.integrationId === BROWSER_ROUTING_ID) {
    return <div className="flex h-8 items-center rounded-md border border-layer bg-muted px-3 text-sm text-muted-foreground">{t("routing.browser")}</div>;
  }
  const models = target ? modelChoicesFor(integrations, target.integrationId, row.task) : [];
  const missing = target && !models.includes(target.model);
  const effective = row.effective ? effectiveText(row, row.effective.model, t) : undefined;
  const placeholder = effective ?? (row.level >= 1 ? t("routing.cell.noFallback") : t("routing.cell.none"));
  const noTools = t("routing.warn.noToolCalls");
  return (
    <div className={CELL}>
      <Select value={target?.model ?? ""} onValueChange={onChange} disabled={!target}>
        <SelectTrigger aria-label={t("routing.cell.model", { task: taskLabel, tab: tabName })} className={TRIGGER}>
          <SelectValue placeholder={dim(placeholder)} />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => <SelectItem key={model} value={model}>{target ? modelLabel(integrations, target.integrationId, model, noTools) : model}</SelectItem>)}
          {models.length === 0 && !missing && <SelectItem value="__none__" disabled>{t("routing.noModel")}</SelectItem>}
          {missing && <SelectItem value={target.model} disabled>{t("routing.cell.gone", { name: target.model })}</SelectItem>}
        </SelectContent>
      </Select>
      {row.toolWarning && (
        <p className="flex items-start gap-1 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("routing.warn.structuredSteps")}
        </p>
      )}
    </div>
  );
}

/** The text of a thinking choice. */
export function thinkingText(level: ThinkingLevel | typeof INHERIT, row: RouterRow | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (level !== INHERIT) return t(`routing.thinking.${level}`);
  return row?.inheritedThinking ? t("routing.thinking.inheritWith", { level: t(`routing.thinking.${row.inheritedThinking}`) }) : t("routing.thinking.inherit");
}

export function ThinkingCell({ row, taskLabel, tabName, describedBy, onChange }: Omit<CellProps, "integrations"> & { describedBy?: string; onChange: (value: ThinkingLevel | "inherit") => void }) {
  const { t } = useTranslation();
  const target = row.target;
  const followed = row.effective?.thinking ? effectiveText(row, thinkingText(row.effective.thinking, row, t), t) : undefined;
  return (
    <Select
      value={target ? target.thinking ?? INHERIT : ""}
      onValueChange={(value) => onChange(value === INHERIT ? "inherit" : value as ThinkingLevel)}
      disabled={!target}
    >
      <SelectTrigger aria-label={t("routing.cell.thinking", { task: taskLabel, tab: tabName })} aria-describedby={describedBy} className={TRIGGER}>
        <SelectValue placeholder={dim(followed ?? thinkingText(INHERIT, row, t))} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>{thinkingText(INHERIT, row, t)}</SelectItem>
        {THINKING_LEVELS.map((level) => <SelectItem key={level} value={level}>{thinkingText(level, row, t)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * The thinking of the Default row: it has none of its own, because that row only chooses the endpoint of the tasks without a route, and the level those tasks go out
 * with is the endpoint's. So the cell says it, with the level the endpoint gives when it gives one, and leads to the card of the integration where it is set.
 */
export function EndpointThinkingCell({ row, describedBy }: { row: RouterRow; describedBy?: string }) {
  const { t } = useTranslation();
  const text = row.inheritedThinking ? t("routing.thinking.fromEndpointWith", { level: t(`routing.thinking.${row.inheritedThinking}`) }) : t("routing.thinking.fromEndpoint");
  return (
    <Link to="/app/settings/ai-integrations" aria-describedby={describedBy} className="inline-flex min-h-6 items-center rounded-sm text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {text}
    </Link>
  );
}
