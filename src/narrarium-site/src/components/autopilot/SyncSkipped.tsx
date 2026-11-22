import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { SYNC_MAX_FILE_BYTES, type SyncSkippedFile } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/autopilot/format";

/** Files are listed this many at a time: a book with a folder of images can leave thousands out. */
const PAGE = 50;

/**
 * The files a sync did not move (too large, not a safe path, not text), with the reason for each and what to do. A sync that left
 * files out is not "all synced", so this says how many, in a fold-out the keyboard and a screen reader can open; the files
 * stay where they are, and the next sync says it again until they can be moved.
 */
export function SyncSkipped({ skipped }: { skipped: readonly SyncSkippedFile[] | undefined }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [limit, setLimit] = useState(PAGE);
  if (!skipped?.length) return null;
  const reason = (file: SyncSkippedFile) => t(`autopilot.where.skipReason.${file.reason}`, { limit: formatSize(SYNC_MAX_FILE_BYTES), defaultValue: file.reason });
  const shown = skipped.slice(0, limit);

  return (
    <details className="rounded-lg border border-amber-500/40 bg-amber-500/5 text-xs">
      <summary id={titleId} className="flex cursor-pointer list-none items-center gap-1.5 p-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        {t("autopilot.where.skippedTitle", { count: skipped.length })}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-muted-foreground">{t("autopilot.where.skippedHint")}</p>
        <ul aria-labelledby={titleId} className="space-y-1.5">
          {shown.map((file) => (
            <li key={`${file.reason}:${file.path}`} className="space-y-0.5 rounded-md border bg-background/70 p-2">
              <code className="block break-all">{file.path}</code>
              <p className="text-muted-foreground">{reason(file)}{file.size === undefined ? "" : ` · ${formatSize(file.size)}`}</p>
            </li>
          ))}
        </ul>
        {skipped.length > limit && (
          <Button size="sm" variant="ghost" className="w-full" onClick={() => setLimit((current) => current + PAGE)}>
            {t("autopilot.plan.run.showMore", { count: Math.min(PAGE, skipped.length - limit) })}
          </Button>
        )}
      </div>
    </details>
  );
}
