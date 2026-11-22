import { useId } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * What the engine could not read of a profile file (`warnings`), at the top of the form that edits it. It does not block anything
 * and does not interrupt a screen reader: it is a status. The lines are the engine's own words, in English, each naming the file.
 */
export function ProfileWarnings({ warnings, description, className }: { warnings: readonly string[] | undefined; description?: string; className?: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  if (!warnings?.length) return null;
  return (
    <Alert role="status" aria-labelledby={titleId} className={className}>
      <TriangleAlert className="h-4 w-4" aria-hidden />
      <AlertDescription className="space-y-2">
        <p id={titleId} className="font-semibold">{t("profileFile.warningsTitle", { count: warnings.length })}</p>
        <p>{description ?? t("profileFile.warningsBody")}</p>
        <ul className="list-disc space-y-1 break-words pl-5 text-xs">
          {warnings.map((warning, index) => <li key={index} lang="en">{warning}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Saving a profile writes the whole file from the values the form holds: when the file had problems, what could not be read is
 * lost. The author is asked first; a file without problems is saved without a question.
 */
export function confirmProfileSave(t: TFunction, warnings: readonly string[] | undefined): boolean {
  return !warnings?.length || window.confirm(t("profileFile.saveConfirm"));
}
