import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileDiff } from "@/components/diff/DiffView";
import { useSummaryDiffStore } from "@/store/summaryDiffStore";

export function SummaryDiffDialog() {
  const { t } = useTranslation();
  const { open, loading, title, oldText, newText, error, regenerate, apply, close } = useSummaryDiffStore();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent hideCloseButton className="left-1/2 top-1/2 flex h-[86dvh] max-h-[86dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[820px]">
        <div className="border-b px-4 py-3">
          <p className="font-semibold">{t("summary.regenerate")}</p>
          <p className="text-xs text-muted-foreground">{title}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("summary.generating")}</div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          ) : (
            <FileDiff previous={oldText || t("summary.noPrevious")} next={newText} />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
          <Button variant="outline" onClick={() => void regenerate()} disabled={loading}>{t("pipeline.regenerate")}</Button>
          <Button onClick={() => void apply()} disabled={loading || !newText.trim()}>{t("summary.keep")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
