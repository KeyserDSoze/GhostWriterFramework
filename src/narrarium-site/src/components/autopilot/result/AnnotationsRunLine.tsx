import { useTranslation } from "react-i18next";
import { Highlighter } from "lucide-react";
import type { AnnotationsRecord } from "narrarium-engine";
import { formatDate } from "@/autopilot/format";

/**
 * What the last campaign of annotations did, in one line: «The autopilot answered 4 of 5 notes in 2 chapters». A campaign the author cancelled says so. The notes it
 * closed say «Handled by the autopilot» on the page of the notes.
 */
export function AnnotationsRunLine({ record }: { record: AnnotationsRecord }) {
  const { t } = useTranslation();
  return (
    <p data-annotations-result="" className="flex items-start gap-2 text-sm">
      <Highlighter className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>
        {record.cancelled ? t("autopilot.annotations.resultCancelled", { handled: record.handled, notes: record.notes }) : t("autopilot.annotations.result", { handled: record.handled, notes: t("autopilot.annotations.rowNotes", { count: record.notes }), chapters: t("autopilot.annotations.chaptersCount", { count: record.chapters.length }) })}
        <span className="ml-1.5 text-xs text-muted-foreground">{formatDate(record.endedAt)}</span>
      </span>
    </p>
  );
}
