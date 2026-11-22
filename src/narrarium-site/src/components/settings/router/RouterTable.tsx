import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { takesThinking, type RouterRow } from "@/router/routerTableModel";
import type { AIIntegration, RoutingTaskKind, ThinkingLevel } from "@/types/settings";
import { EndpointCell, EndpointThinkingCell, ModelCell, ThinkingCell } from "./RouterCells";

interface RouterTableProps {
  /** The accessible name of the table and of the region that scrolls around it. */
  caption: string;
  regionLabel: string;
  tabName: string;
  rows: RouterRow[];
  integrations: AIIntegration[];
  taskLabel: (task: RoutingTaskKind) => string;
  taskHelp: (task: RoutingTaskKind) => string;
  /** The text table has a column of check boxes and a thinking column; a media table has neither. */
  multi: boolean;
  selected: ReadonlySet<RoutingTaskKind>;
  onToggle: (task: RoutingTaskKind, checked: boolean) => void;
  onEndpoint: (task: RoutingTaskKind, value: string) => void;
  onModel: (task: RoutingTaskKind, value: string) => void;
  onThinking: (task: RoutingTaskKind, value: ThinkingLevel | "inherit") => void;
  onFocusRow: (task: RoutingTaskKind) => void;
  /** The id of the line under the table that explains the row in focus, which the thinking control of that row is described by. */
  hintId: string;
  hintTask: RoutingTaskKind | undefined;
}

/** From the `sm` width up the checkbox and the name of the task stay in view while the table scrolls sideways. */
const STICKY = "sm:sticky sm:z-10";
const TASK_COLUMN = "w-52";

/** On a phone a field sits under the name of its task, with its label in front: the label that the column header gives on a wide screen. */
function Field({ label, indent, children }: { label: string; /** The text table keeps its fields clear of the column of check boxes. */ indent: boolean; children: ReactNode }) {
  return (
    <td role="cell" className={`px-2 py-2 align-top max-sm:grid max-sm:grid-cols-[4.5rem_minmax(0,1fr)] max-sm:items-start max-sm:gap-2 max-sm:p-0 ${indent ? "max-sm:col-start-2" : ""}`}>
      <span aria-hidden="true" className="pt-2 text-xs font-semibold sm:hidden">{label}</span>
      {children}
    </td>
  );
}

/**
 * One tab of one section, a real table. From 640px up it scrolls sideways inside its own labelled group when it is wider than the page (a table
 * of data may: WCAG 1.4.10); the scroll padding keeps a control that takes the focus out from behind the two columns that stay in view
 * (WCAG 2.4.11), and the controls themselves are the tab stops. On a phone each row becomes a card, the explicit table roles keeping what a
 * screen reader says.
 */
export function RouterTable(props: RouterTableProps) {
  const { t } = useTranslation();
  const { rows, multi } = props;
  const columns = multi ? 5 : 3;
  return (
    <div role="group" aria-label={props.regionLabel} className="overflow-x-auto rounded-md border border-layer sm:scroll-pl-[16rem]">
      <table role="table" className={`w-full table-fixed border-collapse text-sm max-sm:block ${multi ? "sm:min-w-[55.5rem]" : "sm:min-w-[36rem]"}`}>
        <caption className="sr-only">{props.caption}</caption>
        <colgroup>
          {multi && <col className="w-10" />}
          <col className={TASK_COLUMN} />
          <col className="w-48" />
          <col className="w-56" />
          {multi && <col className="w-56" />}
        </colgroup>
        <thead role="rowgroup" className="max-sm:sr-only">
          <tr role="row" className="border-b border-layer bg-muted text-left text-xs text-muted-foreground">
            {multi && <th role="columnheader" scope="col" className={`${STICKY} left-0 bg-muted px-2 py-1.5`}><span className="sr-only">{t("routing.table.select")}</span></th>}
            <th role="columnheader" scope="col" className={`${STICKY} ${multi ? "left-10" : "left-0"} border-r border-layer bg-muted px-2 py-1.5 font-semibold`}>{t("routing.table.task")}</th>
            <th role="columnheader" scope="col" className="px-2 py-1.5 font-semibold">{t("routing.table.endpoint")}</th>
            <th role="columnheader" scope="col" className="px-2 py-1.5 font-semibold">{t("routing.table.model")}</th>
            {multi && <th role="columnheader" scope="col" className="px-2 py-1.5 font-semibold">{t("routing.table.thinking")}</th>}
          </tr>
        </thead>
        <tbody role="rowgroup" className="max-sm:block">
          {rows.length === 0 && (
            <tr role="row"><td role="cell" colSpan={columns} className="px-2 py-6 text-center text-sm text-muted-foreground">{t("routing.table.empty")}</td></tr>
          )}
          {rows.map((row) => {
            const task = row.task;
            const chosen = props.selected.has(task);
            const background = chosen ? "bg-accent" : "bg-card";
            const label = props.taskLabel(task);
            return (
              <tr
                key={task}
                role="row"
                className={`border-b border-layer last:border-b-0 ${background} max-sm:grid max-sm:gap-x-2 max-sm:gap-y-2 max-sm:p-3 ${multi ? "max-sm:grid-cols-[1.5rem_minmax(0,1fr)]" : "max-sm:grid-cols-1"}`}
                onFocusCapture={() => props.onFocusRow(task)}
              >
                {multi && (
                  <td role="cell" className={`${STICKY} left-0 px-2 py-2 align-top max-sm:row-start-1 max-sm:p-0 ${background}`}>
                    <label className="flex h-8 w-6 items-center justify-center">
                      <input type="checkbox" className="h-4 w-4 accent-primary" aria-label={t("routing.cell.select", { task: label })} checked={chosen} onChange={(event) => props.onToggle(task, event.target.checked)} />
                    </label>
                  </td>
                )}
                <th role="rowheader" scope="row" className={`${STICKY} ${multi ? "left-10" : "left-0"} border-r border-layer px-2 py-2 text-left align-top font-normal max-sm:row-start-1 max-sm:border-r-0 max-sm:p-0 ${background}`}>
                  <span className="font-medium">{label}</span>
                  {row.custom && <span className="ml-1.5 inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 align-middle text-xs font-semibold text-emerald-800 dark:text-emerald-300">{t("routing.badge.custom")}</span>}
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{props.taskHelp(task)}</span>
                  {row.orphan && (
                    <span className="mt-1 flex items-start gap-1 text-xs font-normal text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {t("routing.warn.orphan")}
                    </span>
                  )}
                </th>
                <Field label={t("routing.table.endpoint")} indent={multi}>
                  <EndpointCell row={row} integrations={props.integrations} taskLabel={label} tabName={props.tabName} onChange={(value) => props.onEndpoint(task, value)} />
                </Field>
                <Field label={t("routing.table.model")} indent={multi}>
                  <ModelCell row={row} integrations={props.integrations} taskLabel={label} tabName={props.tabName} onChange={(value) => props.onModel(task, value)} />
                </Field>
                {multi && (
                  <Field label={t("routing.table.thinking")} indent>
                    {takesThinking(task)
                      ? <ThinkingCell row={row} taskLabel={label} tabName={props.tabName} describedBy={task === props.hintTask ? props.hintId : undefined} onChange={(value) => props.onThinking(task, value)} />
                      : <EndpointThinkingCell row={row} describedBy={task === props.hintTask ? props.hintId : undefined} />}
                  </Field>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
