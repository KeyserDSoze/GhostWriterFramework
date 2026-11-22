import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { candidateBoundaryLabel } from "@/assistant/fallbackDisclosure";
import { resolveEffectiveTaskCandidates } from "@/assistant/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { applyMessage, deleteMessage, swapMessage } from "@/router/routerMessages";
import {
  SECTION_TASKS,
  TEXT_GROUP_IDS,
  applyBulkChange,
  buildRow,
  canAddLevel,
  clearTargetAt,
  commonModelChoices,
  countAtLevel,
  levelCount,
  removeLevel,
  swapLevels,
  takesThinking,
  targetAt,
  visibleTasks,
  type BulkChange,
  type GroupFilter,
  type Routing,
  type RouterSectionId,
  type RowFilters,
} from "@/router/routerTableModel";
import { DEFAULT_SETTINGS, type AppSettings, type RoutingTaskKind, type ThinkingLevel } from "@/types/settings";
import { CLEAR, INHERIT } from "./RouterCells";
import { EMPTY_DRAFT, RouterBulkPanel, type BulkDraft } from "./RouterBulkPanel";
import { RouterTable } from "./RouterTable";
import { RouterTabsBar } from "./RouterTabsBar";

interface Status {
  message: string;
  /** What «Undo» brings back: the routing before, and the routing that was stored by the change (the undo is offered only while it is still the one in use). */
  undo?: { before: Routing | undefined; after: Routing; level: number; extraLevels: number };
}

const GROUPS: GroupFilter[] = ["all", ...TEXT_GROUP_IDS];

interface RouterSectionProps {
  id: RouterSectionId;
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => void;
}

/** One kind of task as a table with its tabs: the primary and any number of fallbacks, each tab working the same way. */
export function RouterSection({ id, settings, patchSettings }: RouterSectionProps) {
  const { t } = useTranslation();
  const uid = useId();
  const multi = id === "text";
  const tasks = SECTION_TASKS[id];
  const integrations = settings.aiIntegrations ?? [];
  const maxCandidates = (settings.routingExecution ?? DEFAULT_SETTINGS.routingExecution).maxCandidates;
  const routing = settings.taskRouting;

  // Tabs, filters and the selection belong to the screen: they are not saved with the settings.
  const [level, setLevel] = useState(0);
  const [extraLevels, setExtraLevels] = useState(1);
  const [filters, setFilters] = useState<RowFilters>({ group: "all", query: "", onlyCustom: false });
  const [selected, setSelected] = useState<ReadonlySet<RoutingTaskKind>>(() => new Set());
  const [draft, setDraft] = useState<BulkDraft>(EMPTY_DRAFT);
  const [focusedTask, setFocusedTask] = useState<RoutingTaskKind>();
  const [status, setStatus] = useState<Status | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const bulkFocus = useRef<HTMLButtonElement>(null);

  const count = levelCount(routing, tasks, extraLevels);
  const activeLevel = Math.min(level, count - 1);
  const tabName = (index: number) => (index === 0 ? t("routing.primary") : t("routing.fallbackN", { n: index }));
  const title = id === "text" ? t("routing.sections.text.title") : t(`routing.task.${id}`);
  const taskLabel = (task: RoutingTaskKind) => (task === "default" ? t("routing.table.defaultRow") : t(`routing.task.${task}`));
  const taskHelp = (task: RoutingTaskKind) => t(`routing.taskHelp.${task}`);

  const visible = visibleTasks({ settings, section: id, level: activeLevel, filters, searchText: (task) => `${taskLabel(task)} ${taskHelp(task)}` });
  const rows = visible.map((task) => buildRow(settings, task, activeLevel));
  // Only the rows in view count as selected; the tab-wide actions use them, or every row when none is selected.
  const chosen = multi ? visible.filter((task) => selected.has(task)) : [];
  const scope: readonly RoutingTaskKind[] = chosen.length > 0 ? chosen : tasks;
  const scopeText = chosen.length > 0 ? t("routing.tabs.scopeSelected", { count: chosen.length }) : t("routing.tabs.scopeAll", { count: tasks.length });
  const endpointsInUse = [...new Set(chosen.map((task) => targetAt(routing?.[task], activeLevel)?.integrationId).filter((value): value is string => Boolean(value)))];
  const commonEndpointId = endpointsInUse.length === 1 ? endpointsInUse[0] : undefined;
  // A model chosen for one selection may not suit the next: it is neither shown nor applied then.
  const draftEndpointId = draft.endpointId || commonEndpointId;
  const liveDraft: BulkDraft = draft.model && !(draftEndpointId && commonModelChoices(integrations, draftEndpointId, chosen).includes(draft.model)) ? { ...draft, model: "" } : draft;

  const hintTask = focusedTask && visible.includes(focusedTask) ? focusedTask : visible[0];
  const hintRow = rows.find((row) => row.task === hintTask);
  const chain = hintTask
    ? resolveEffectiveTaskCandidates(settings, hintTask).map((candidate) => (candidate.browser ? `${t("routing.browserBoundary")} (browser)` : `${candidateBoundaryLabel(candidate)} (${candidate.model})`)).join(" → ")
    : "";
  const hintId = `${uid}-hint`;
  const undoAvailable = Boolean(status?.undo) && routing === status?.undo?.after;

  /** Stores a change of many rows and offers to take it back, for as long as nothing else changes the routing. */
  function commit(next: Routing, message: string) {
    const before = routing;
    patchSettings({ taskRouting: next });
    setStatus({ message, undo: { before, after: next, level: activeLevel, extraLevels } });
  }

  function change(taskList: readonly RoutingTaskKind[], what: BulkChange) {
    return applyBulkChange({ routing, integrations, tasks: taskList, level: activeLevel, change: what, maxCandidates });
  }

  function editCell(task: RoutingTaskKind, what: BulkChange) {
    const outcome = change([task], what);
    if (outcome.changed.length === 0) return;
    patchSettings({ taskRouting: outcome.routing });
    const replaced = outcome.adjusted.includes(task) && !outcome.created.includes(task);
    setStatus(replaced ? { message: t("routing.result.modelChanged", { task: taskLabel(task), model: targetAt(outcome.routing[task], activeLevel)?.model ?? "" }) } : null);
  }

  function onEndpoint(task: RoutingTaskKind, value: string) {
    if (value !== CLEAR) {
      editCell(task, { endpointId: value });
      return;
    }
    const outcome = clearTargetAt(routing, [task], activeLevel);
    if (outcome.cleared.length === 0) return;
    commit(outcome.routing, outcome.promoted.length > 0
      ? t("routing.result.promoted", { task: taskLabel(task), tab: tabName(1) })
      : t("routing.result.cleared", { task: taskLabel(task), tab: tabName(activeLevel) }));
  }

  function onThinking(task: RoutingTaskKind, value: ThinkingLevel | "inherit") {
    editCell(task, { thinking: value });
  }

  function toggle(task: RoutingTaskKind, checked: boolean) {
    setSelected((old) => {
      const next = new Set(old);
      if (checked) next.add(task); else next.delete(task);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected((old) => {
      const next = new Set(old);
      for (const task of visible) { if (checked) next.add(task); else next.delete(task); }
      return next;
    });
  }

  function applyDraft() {
    if (!liveDraft.endpointId && !liveDraft.model && !liveDraft.thinking) return;
    const what: BulkChange = {
      ...(liveDraft.endpointId ? { endpointId: liveDraft.endpointId } : {}),
      ...(liveDraft.model ? { model: liveDraft.model } : {}),
      ...(liveDraft.thinking ? { thinking: liveDraft.thinking === INHERIT ? "inherit" : liveDraft.thinking as ThinkingLevel } : {}),
    };
    const outcome = change(chosen, what);
    const message = applyMessage(t, outcome);
    if (outcome.changed.length > 0) commit(outcome.routing, message); else setStatus({ message });
    setDraft(EMPTY_DRAFT);
    bulkFocus.current?.focus();
  }

  function swapWith(other: number): boolean {
    const outcome = swapLevels(routing, scope, activeLevel, other);
    const message = swapMessage(t, outcome, tabName(activeLevel), tabName(other));
    if (outcome.swapped.length > 0) commit(outcome.routing, message); else setStatus({ message });
    return outcome.swapped.length > 0;
  }

  function move(direction: -1 | 1) {
    const target = activeLevel + direction;
    if (swapWith(target)) setLevel(target);
  }

  function addTab() {
    setExtraLevels(count + 1);
    setLevel(count);
  }

  function deleteTab() {
    const lost = countAtLevel(routing, scope, activeLevel);
    const everyRow = chosen.length === 0;
    const nextExtra = everyRow ? Math.max(1, extraLevels - 1) : extraLevels;
    if (lost === 0) {
      if (!everyRow) { setStatus({ message: t("routing.result.nothingChanged") }); return; }
      setExtraLevels(nextExtra);
      setLevel(Math.min(activeLevel, levelCount(routing, tasks, nextExtra) - 1));
      return;
    }
    if (!window.confirm(t("routing.tabs.deleteConfirm", { count: lost, tab: tabName(activeLevel) }))) return;
    const outcome = removeLevel(routing, scope, activeLevel);
    commit(outcome.routing, deleteMessage(t, tabName(activeLevel), lost));
    setExtraLevels(nextExtra);
    setLevel(Math.min(activeLevel, levelCount(outcome.routing, tasks, nextExtra) - 1));
  }

  function undo() {
    const undone = status?.undo;
    if (!undone) return;
    patchSettings({ taskRouting: undone.before });
    setExtraLevels(undone.extraLevels);
    setLevel(undone.level);
    setStatus({ message: t("routing.result.undone") });
    tabsRef.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="space-y-3 rounded-lg border border-layer p-3 sm:p-4">
      <div>
        <h2 id={`${uid}-title`} className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{t(`routing.sections.${id}.description`)}</p>
      </div>
      <Tabs value={String(activeLevel)} onValueChange={(value) => setLevel(Number(value))} className="space-y-3">
        <RouterTabsBar
          sectionTitle={title}
          count={count}
          activeLevel={activeLevel}
          tabName={tabName}
          canAdd={canAddLevel(count, maxCandidates)}
          scopeText={scopeText}
          tabsRef={tabsRef}
          onAdd={addTab}
          onSwap={swapWith}
          onMove={move}
          onDelete={deleteTab}
        />
        {multi && (
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t("routing.groups.label")} className="flex flex-wrap gap-1">
              {GROUPS.map((group) => (
                <button
                  key={group}
                  type="button"
                  aria-pressed={filters.group === group}
                  onClick={() => setFilters({ ...filters, group })}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${filters.group === group ? "border-primary bg-primary text-primary-foreground" : "border-field text-foreground hover:bg-accent"}`}
                >
                  {t(`routing.groups.${group}`)}
                </button>
              ))}
            </div>
            <Input className="h-8 w-40 text-sm" aria-label={t("routing.filters.query")} placeholder={t("routing.filters.queryPlaceholder")} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
            <label className="flex min-h-6 items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={filters.onlyCustom} onChange={(event) => setFilters({ ...filters, onlyCustom: event.target.checked })} />
              {t("routing.filters.onlyCustom")}
            </label>
          </div>
        )}
        {multi && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex min-h-6 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={visible.length > 0 && chosen.length === visible.length}
                ref={(element) => { if (element) element.indeterminate = chosen.length > 0 && chosen.length < visible.length; }}
                onChange={(event) => toggleAll(event.target.checked)}
              />
              {t("routing.filters.selectAll")}
            </label>
            <span className="text-xs text-muted-foreground">{t("routing.filters.count", { visible: visible.length, count: tasks.length })}</span>
          </div>
        )}
        {multi && chosen.length > 0 && (
          <RouterBulkPanel
            tasks={chosen}
            tabName={tabName(activeLevel)}
            integrations={integrations}
            commonEndpointId={commonEndpointId}
            draft={liveDraft}
            onDraft={setDraft}
            onApply={applyDraft}
            firstControl={bulkFocus}
          />
        )}
        <div className={status ? "flex flex-wrap items-center gap-2 rounded-md border border-layer bg-muted px-3 py-2" : "flex"}>
          <div role="status" className="min-w-0 flex-1 text-sm">{status?.message}</div>
          {undoAvailable && <Button type="button" variant="outline" size="sm" onClick={undo}>{t("routing.undo")}</Button>}
        </div>
        {Array.from({ length: count }, (_, index) => (
          <TabsContent key={index} value={String(index)} tabIndex={-1} className="mt-0">
            <RouterTable
              caption={t("routing.table.caption", { section: title, tab: tabName(index) })}
              regionLabel={t("routing.table.regionLabel", { section: title, tab: tabName(index) })}
              tabName={tabName(index)}
              rows={rows}
              integrations={integrations}
              taskLabel={taskLabel}
              taskHelp={taskHelp}
              multi={multi}
              selected={selected}
              onToggle={toggle}
              onEndpoint={onEndpoint}
              onModel={(task, value) => editCell(task, { model: value })}
              onThinking={onThinking}
              onFocusRow={setFocusedTask}
              hintId={hintId}
              hintTask={hintTask}
            />
          </TabsContent>
        ))}
      </Tabs>
      <div className="space-y-1 text-xs text-muted-foreground">
        {multi && hintTask && (
          <p id={hintId}>
            <span className="font-semibold text-foreground">{taskLabel(hintTask)}:</span> {t(`routing.thinking.hint.${takesThinking(hintTask) ? hintRow?.target?.thinking ?? "inherit" : "fromEndpoint"}`)}
          </p>
        )}
        {chain && <p>{t("routing.boundaryChain", { chain })}</p>}
      </div>
    </section>
  );
}
