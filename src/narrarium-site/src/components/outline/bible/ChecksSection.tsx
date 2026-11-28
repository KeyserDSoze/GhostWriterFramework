import { Suspense, lazy, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { findingText, spoilerCheckSummary, type AutopilotState, type DesignFinding } from "narrarium-engine";
import "@/i18n/design";
import "@/i18n/bibleStudio";
import { Label } from "@/components/ui/label";
import { FindingIcon } from "@/components/outline/bible/bibleParts";
import type { BookEntry } from "@/types/settings";

const SpoilerCheck = lazy(() => import("@/components/outline/bible/SpoilerCheck"));

/** The findings of the checks, with their severity and where, filtered by severity, and the spoiler check on written text that the author starts. */
export function ChecksSection({ findings, language, shownChapters, onShowEntry, book, branch, state }: {
  findings: readonly DesignFinding[];
  language: string;
  shownChapters: ReadonlySet<number>;
  onShowEntry: (number: number) => void;
  book: BookEntry | undefined;
  branch: string;
  state: AutopilotState | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [severity, setSeverity] = useState<"all" | "warning" | "info">("all");
  const [spoilers, setSpoilers] = useState<{ findings: DesignFinding[]; chapters: number } | null>(null);
  const all = [...findings, ...(spoilers?.findings ?? [])];
  const shown = all.filter((finding) => severity === "all" || finding.severity === severity);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("design.bible.checks.intro")}</p>
      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor={`${id}-severity`} className="text-xs font-medium">{t("bibleStudio.decisions.filterLabel")}</Label>
          <select id={`${id}-severity`} value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)} className="h-9 rounded-md border border-field bg-background px-2 text-sm">
            <option value="all">{t("bibleStudio.checks.filters.all")}</option>
            <option value="warning">{t("bibleStudio.checks.filters.warning")}</option>
            <option value="info">{t("bibleStudio.checks.filters.info")}</option>
          </select>
          <p role="status" className="text-xs text-muted-foreground">{t("bibleStudio.checks.count", { shown: shown.length, total: all.length })}</p>
        </div>
      )}
      {all.length === 0
        ? <p data-bible-checks="none" className="text-sm">{t("design.bible.checks.none")}</p>
        : (
          <ul data-bible-checks className="space-y-1.5 text-sm">
            {shown.map((finding, index) => (
              <li key={`${finding.code}-${index}`} data-design-finding={finding.code} data-finding-severity={finding.severity} className="flex items-start gap-2">
                <FindingIcon finding={finding} />
                <span className="min-w-0">
                  <span className="sr-only">{t(`bibleStudio.checks.severity.${finding.severity}`)}: </span>
                  {findingText(finding, language)}
                  {finding.chapter !== undefined && shownChapters.has(finding.chapter) && (
                    <> <button type="button" className="inline-flex min-h-6 items-center text-xs underline underline-offset-4 [@media(pointer:coarse)]:min-h-11" onClick={() => onShowEntry(finding.chapter!)}>{t("design.bible.checks.show", { number: finding.chapter })}</button></>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      {spoilers && <p role="status" data-spoiler-summary className="text-xs text-muted-foreground">{spoilerCheckSummary(spoilers.chapters, spoilers.findings.length, language)}</p>}
      {book && (
        <Suspense fallback={null}>
          <SpoilerCheck book={book} branch={branch} state={state} onFindings={(found, chapters) => setSpoilers({ findings: found, chapters })} />
        </Suspense>
      )}
    </div>
  );
}
