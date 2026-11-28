import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ScanSearch } from "lucide-react";
import { loadBookSnapshot, loadSpoilerSecretsOfBook, loadWrittenChapters, spoilerChecks, type AutopilotState, type DesignFinding } from "narrarium-engine";
import "@/i18n/bibleStudio";
import { Button } from "@/components/ui/button";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { cn } from "@/lib/utils";
import type { BookEntry } from "@/types/settings";

/**
 * The spoiler check on written text: it reads the chapters already written (this is why it runs when the author asks, not when the Bible opens) and looks, without a model, for a
 * sentence that states a secret before the chapter from which the reader may know it. The findings are given to the Bible, which lists them with the others.
 */
export default function SpoilerCheck({ book, branch, state, onFindings }: { book: BookEntry; branch: string; state: Pick<AutopilotState, "concept"> | null; onFindings: (findings: DesignFinding[], chapters: number) => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const run = async () => {
    setPhase("running");
    try {
      const store = createBrowserBookStore(book, branch);
      const snapshot = await loadBookSnapshot(store);
      const [chapters, secrets] = await Promise.all([
        loadWrittenChapters(store, snapshot),
        loadSpoilerSecretsOfBook(store, snapshot, new Map((state?.concept?.secrets ?? []).map((secret) => [secret.slug, secret.revealChapter]))),
      ]);
      onFindings(spoilerChecks({ chapters, secrets }), chapters.length);
      setPhase("idle");
    } catch {
      setPhase("failed");
    }
  };
  return (
    <div data-spoiler-check className="space-y-2 rounded-xl border border-dashed p-3">
      <h4 className="text-sm font-semibold">{t("bibleStudio.checks.spoilers.title")}</h4>
      <p className="max-w-3xl text-xs text-muted-foreground">{t("bibleStudio.checks.spoilers.intro")}</p>
      <Button type="button" size="sm" variant="outline" disabled={phase === "running"} onClick={() => void run()}>
        {phase === "running" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ScanSearch className="h-4 w-4" aria-hidden="true" />}
        {phase === "running" ? t("bibleStudio.checks.spoilers.running") : t("bibleStudio.checks.spoilers.run")}
      </Button>
      <p role="status" className={cn("text-xs", phase === "failed" && "font-medium text-destructive")}>{phase === "failed" ? t("bibleStudio.checks.spoilers.failed") : ""}</p>
    </div>
  );
}
