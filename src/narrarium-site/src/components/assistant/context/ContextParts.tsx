import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Archive, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import type { ChatContext } from "@/assistant/chatContext";
import { CONTEXT_PARTS, DEFAULT_TOKEN_RATIO } from "@/assistant/contextBudget";
import type { AssistantMessage, ContextCompaction } from "@/assistant/store";
import { formatWhole } from "@/autopilot/format";
import { formatMoney } from "@/costs/money";
import { cn } from "@/lib/utils";

/**
 * The parts of the context of a chat that are loaded when they are first shown (#122): what the next message carries, part by part (the ring's popover and `/context`), the
 * marker of a compaction in the chat, the notice of a message that does not fit, and the messages a chat too large to keep archived.
 */

const percentOf = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

function sourceText(t: TFunction, context: ChatContext): string {
  return t(`pageCopilot.context.ring.source.${context.estimate.window.source}`);
}

/** The lines that say what the next message carries beyond its parts: the model and its window, the room, the compaction, the cache, the cost. */
function contextLines(t: TFunction, context: ChatContext, currency: string): { model: string; budget: string; compaction: string; measuredNote: string; ratio: string; cache: string[]; cost: string[] } {
  const { estimate } = context;
  const source = sourceText(t, context);
  const cache: string[] = [];
  if (context.noCache) cache.push(t("pageCopilot.context.popover.cacheOff"));
  else if (estimate.cacheable > 0) cache.push(t("pageCopilot.context.popover.cacheEstimated", { share: percentOf(estimate.cacheable, estimate.total), tokens: formatWhole(estimate.cacheable) }));
  else cache.push(t("pageCopilot.context.popover.cacheNone"));
  cache.push(context.measured
    ? t("pageCopilot.context.popover.cacheMeasured", { share: Math.round(context.measured.share * 100), cached: formatWhole(context.measured.cachedInputTokens), input: formatWhole(context.measured.inputTokens) })
    : t("pageCopilot.context.popover.cacheUnreported"));
  const cost = context.cost
    ? [t("pageCopilot.context.popover.costInput", { cost: formatMoney(context.cost.input, currency, { significant: 2 }) }), ...(context.cost.output !== null ? [t("pageCopilot.context.popover.costOutput", { cost: formatMoney(context.cost.output, currency, { significant: 2 }) })] : [])]
    : [t("pageCopilot.context.popover.costUnknown")];
  const measuredRatio = Math.abs(estimate.ratio - DEFAULT_TOKEN_RATIO) > 1e-9;
  return {
    model: context.model
      ? t("pageCopilot.context.popover.model", { model: context.model.model, integration: context.model.integrationName, window: formatWhole(estimate.window.tokens), source })
      : t("pageCopilot.context.popover.noModel", { window: formatWhole(estimate.window.tokens) }),
    budget: t("pageCopilot.context.popover.budget", { budget: formatWhole(estimate.inputBudget) }),
    compaction: context.compaction.auto
      ? t("pageCopilot.context.popover.autoAt", { at: formatWhole(estimate.compactAt), threshold: context.compaction.threshold })
      : t("pageCopilot.context.popover.autoOff"),
    measuredNote: t(estimate.measured ? "pageCopilot.context.popover.measured" : "pageCopilot.context.popover.notMeasured"),
    ratio: t(measuredRatio ? "pageCopilot.context.popover.ratioMeasured" : "pageCopilot.context.popover.ratioDefault", { ratio: estimate.ratio.toFixed(2) }),
    cache,
    cost,
  };
}

const STATE_CHIP: Record<ChatContext["estimate"]["state"], string> = {
  normal: "border-primary/40 text-primary",
  full: "border-amber-600/60 text-amber-800 dark:text-amber-300",
  compacting: "border-sky-600/60 text-sky-800 dark:text-sky-300",
  over: "border-red-600/60 text-red-800 dark:text-red-300",
};

export function ContextBreakdown({ context, titleId, canCompact, currency, onCompact, onClose }: { context: ChatContext; titleId: string; canCompact: boolean; currency: string; onCompact: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { estimate } = context;
  const lines = contextLines(t, context, currency);
  const captionId = useId();
  return (
    <div className="space-y-3" data-context-breakdown="">
      <div>
        <h3 id={titleId} className="text-sm font-semibold">{t("pageCopilot.context.popover.title")}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm tabular-nums">
          <span className="font-medium">{t("pageCopilot.context.popover.used", { used: formatWhole(estimate.total), window: formatWhole(estimate.window.tokens), percent: estimate.percent })}</span>
          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATE_CHIP[estimate.state])}>{t(`pageCopilot.context.ring.state.${estimate.state}`)}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{lines.model}</p>
      </div>
      <table className="w-full text-xs tabular-nums" aria-describedby={captionId}>
        <caption id={captionId} className="mb-1 text-left text-xs font-medium text-foreground">{t("pageCopilot.context.popover.breakdown")}</caption>
        <thead className="sr-only">
          <tr><th scope="col">{t("pageCopilot.context.popover.partsHeader")}</th><th scope="col">{t("pageCopilot.context.popover.tokensHeader")}</th><th scope="col">{t("pageCopilot.context.popover.shareHeader")}</th></tr>
        </thead>
        <tbody>
          {CONTEXT_PARTS.map((part) => (
            <tr key={part} data-context-part={part} className="border-t border-border/60">
              <th scope="row" className="py-1 pr-2 text-left font-normal text-muted-foreground">{t(`pageCopilot.context.popover.parts.${part}`)}</th>
              <td className="py-1 pr-2 text-right font-medium">{formatWhole(estimate.parts[part])}</td>
              <td className="w-10 py-1 text-right text-muted-foreground">{percentOf(estimate.parts[part], estimate.total)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{lines.budget}</p>
        <p>{lines.compaction}</p>
        <p>{lines.measuredNote}</p>
        <p>{lines.ratio}</p>
      </div>
      <div className="space-y-1 text-xs" data-context-cache="">
        {lines.cache.map((line) => <p key={line}>{line}</p>)}
      </div>
      <div className="space-y-1 text-xs" data-context-cost="">
        {lines.cost.map((line) => <p key={line}>{line}</p>)}
      </div>
      {/* The actions stay in sight at the foot of the popover while what is above them scrolls. */}
      <div className="sticky -bottom-3 -mx-3 -mb-3 space-y-1 border-t bg-popover px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={onCompact} disabled={!canCompact}>{t("pageCopilot.context.popover.compactNow")}</Button>
          <Button type="button" size="sm" variant="outline" asChild><Link to="/app/settings/tools">{t("pageCopilot.context.popover.settings")}</Link></Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("pageCopilot.context.popover.close")}</Button>
        </div>
        {!canCompact && <p className="text-xs text-muted-foreground">{t("pageCopilot.context.popover.nothingToCompact")}</p>}
      </div>
    </div>
  );
}

/** What `/context` prints in the chat: the same as the popover, in Markdown. A note of the chat, never sent to the model. */
export function contextReport(t: TFunction, context: ChatContext, currency: string): string {
  const { estimate } = context;
  const lines = contextLines(t, context, currency);
  const rows = CONTEXT_PARTS.map((part) => `| ${t(`pageCopilot.context.popover.parts.${part}`)} | ${formatWhole(estimate.parts[part])} | ${percentOf(estimate.parts[part], estimate.total)}% |`);
  return [
    `**${t("pageCopilot.context.report.title")}** · ${t(`pageCopilot.context.ring.state.${estimate.state}`)}`,
    t("pageCopilot.context.report.summary", { percent: estimate.percent, used: formatWhole(estimate.total), window: formatWhole(estimate.window.tokens), source: sourceText(t, context) }),
    lines.model,
    [`| ${t("pageCopilot.context.popover.partsHeader")} | ${t("pageCopilot.context.popover.tokensHeader")} | ${t("pageCopilot.context.popover.shareHeader")} |`, "|---|---:|---:|", ...rows].join("\n"),
    [lines.budget, lines.compaction, ...lines.cache, ...lines.cost, lines.measuredNote].map((line) => `- ${line}`).join("\n"),
    `_${t("pageCopilot.context.report.note")}_`,
  ].join("\n\n");
}

/** The marker of a compaction in the chat, after the last message it summarised: what it did, its summary, and «Undo for the next message» while it is the one in force. */
export function CompactionMarker({ compaction, active, canUndo, onUndo }: { compaction: ContextCompaction; active: boolean; canUndo: boolean; onUndo: (undo: boolean) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  return (
    <div role="note" data-context-marker={compaction.trigger} data-context-undone={compaction.skipNext ? "" : undefined} className="rounded-xl border border-dashed border-sky-700/50 bg-sky-50/60 p-3 text-xs text-foreground dark:border-sky-300/40 dark:bg-sky-950/30">
      <p className="flex items-start gap-2 font-medium"><Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden="true" />{t(compaction.trigger === "manual" ? "pageCopilot.context.marker.manual" : "pageCopilot.context.marker.auto", { count: compaction.coveredCount })}</p>
      <p className="mt-1 text-muted-foreground">{t("pageCopilot.context.marker.tokens", { before: formatWhole(compaction.beforeTokens), after: formatWhole(compaction.afterTokens) })}</p>
      {compaction.source === "fallback" && <p className="mt-1 text-muted-foreground">{t("pageCopilot.context.marker.fallback")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" aria-expanded={open} aria-controls={summaryId} onClick={() => setOpen((value) => !value)}>
          {t(open ? "pageCopilot.context.marker.hideSummary" : "pageCopilot.context.marker.showSummary")}
        </Button>
        {active && canUndo && !compaction.skipNext && <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onUndo(true)}>{t("pageCopilot.context.marker.undo")}</Button>}
        {active && canUndo && compaction.skipNext && <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onUndo(false)}>{t("pageCopilot.context.marker.keep")}</Button>}
      </div>
      {active && canUndo && compaction.skipNext && <p className="mt-2" role="status">{t("pageCopilot.context.marker.undone")}</p>}
      {active && !canUndo && <p className="mt-2 text-muted-foreground">{t("pageCopilot.context.marker.archived")}</p>}
      {open && <div id={summaryId} className="doc-prose mt-2 max-h-64 max-w-none overflow-auto rounded-lg border bg-background p-2 text-xs leading-6" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(compaction.summary) }} />}
    </div>
  );
}

export interface TooLargeNoticeData {
  total: number;
  budget: number;
  window: number;
  source: "configured" | "default";
  model: string;
  message: number;
  compacted: boolean;
  /** The request set the last compaction aside («Undo for the next message»): with the whole conversation it does not fit. */
  undone?: boolean;
  /** A compaction would leave room (the automatic one is off, or there is more to summarise). */
  canCompact?: boolean;
}

/** A message that does not fit the window even after a compaction: nothing was sent, the numbers, and what the author can do. */
export function TooLargeNotice({ notice, onMaterial, onShorten, onDismiss, onKeepCompacted, onCompact }: { notice: TooLargeNoticeData; onMaterial: () => void; onShorten: () => void; onDismiss: () => void; onKeepCompacted?: () => void; onCompact?: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" data-context-too-large="" className="space-y-2 rounded-xl border border-red-700/40 bg-red-50 p-3 text-xs text-foreground dark:border-red-400/40 dark:bg-red-950/30">
      <p className="text-sm font-medium text-red-800 dark:text-red-300">{t("pageCopilot.context.tooLarge.title")}</p>
      <p>{t("pageCopilot.context.tooLarge.body", { total: formatWhole(notice.total), budget: formatWhole(notice.budget), window: formatWhole(notice.window), source: t(`pageCopilot.context.ring.source.${notice.source}`), model: notice.model, message: formatWhole(notice.message) })}</p>
      {notice.undone ? <p>{t("pageCopilot.context.tooLarge.undone")}</p> : notice.compacted && <p>{t("pageCopilot.context.tooLarge.compacted")}</p>}
      <p>{t("pageCopilot.context.tooLarge.options")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {notice.undone && onKeepCompacted && <Button type="button" size="sm" className="h-8" onClick={onKeepCompacted}>{t("pageCopilot.context.marker.keep")}</Button>}
        {!notice.undone && notice.canCompact && onCompact && <Button type="button" size="sm" className="h-8" onClick={onCompact}>{t("pageCopilot.context.popover.compactNow")}</Button>}
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={onMaterial}>{t("pageCopilot.context.tooLarge.material")}</Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={onShorten}>{t("pageCopilot.context.tooLarge.shorten")}</Button>
        <Button type="button" size="sm" variant="outline" className="h-8" asChild><Link to="/app/settings/ai-router">{t("pageCopilot.context.tooLarge.model")}</Link></Button>
        {notice.source === "default" && <Button type="button" size="sm" variant="outline" className="h-8" asChild><Link to="/app/settings/ai-integrations">{t("pageCopilot.context.tooLarge.window")}</Link></Button>}
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onDismiss}>{t("pageCopilot.context.tooLarge.dismiss")}</Button>
      </div>
      <p className="text-muted-foreground">{t("pageCopilot.context.tooLarge.materialHint")}</p>
    </div>
  );
}

/** The messages a chat too large to keep archived apart: still there, read-only, one press away. */
export function ArchivedMessages({ messages }: { messages: readonly AssistantMessage[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!messages.length) return null;
  return (
    <div className="mt-2" data-context-archived="">
      <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{open ? t("pageCopilot.context.archivedMessages.hide") : t("pageCopilot.context.archivedMessages.show", { count: messages.length })}
      </Button>
      {open && (
        <div id={listId} className="mt-2 space-y-2">
          <p>{t("pageCopilot.context.archivedMessages.note")}</p>
          {messages.map((message) => (
            <div key={message.id} className="rounded-lg border bg-background p-2">
              <p className="mb-1 font-medium text-foreground">{t(message.role === "user" ? "pageCopilot.context.archivedMessages.user" : "pageCopilot.context.archivedMessages.assistant")}</p>
              <div className="whitespace-pre-wrap text-foreground">{message.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
