import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FileEdit, Loader2, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { FileDiff } from "@/components/diff/DiffView";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import { createOrUpdateTextFile } from "@/github/githubClient";
import { mergeDraftAndFinal, type PipelineSource } from "@/narrarium/pipeline";

export type MergeSide = "draft" | "final";

export interface MergeContext {
  buildSource: () => PipelineSource | null;
  /** Full current draft body (no frontmatter). */
  getDraftBody: () => string;
  /** Full current final body (no frontmatter). */
  getFinalBody: () => string;
  /** Existing frontmatter block (verbatim, incl. --- fences) for each side, if known. */
  getDraftFrontmatter?: () => string;
  getFinalFrontmatter?: () => string;
  /** Paths of the two files. */
  draftPath: string;
  finalPath: string;
  /** Fallback frontmatter builders when a side has no file yet. */
  defaultDraftFrontmatter?: () => string;
  defaultFinalFrontmatter?: () => string;
  ghostwriterSlug?: string;
  /** Called after a successful apply so the page can refresh its local state. */
  onApplied?: (side: MergeSide, body: string) => void;
}

function joinDoc(frontmatter: string, body: string): string {
  if (!frontmatter) return `${body.trim()}\n`;
  return `${frontmatter.trimEnd()}\n\n${body.trim()}\n`;
}

/**
 * Reusable "merge draft + final" flow: runs the AI merge, shows a review dialog
 * with a diff and the model's explanation, and lets the user apply the merged
 * text to either the draft or the final file.
 */
export function useMergeDraftFinal(ctx: MergeContext) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [merged, setMerged] = useState("");
  const [explanation, setExplanation] = useState("");
  const [draftSnapshot, setDraftSnapshot] = useState("");
  const [finalSnapshot, setFinalSnapshot] = useState("");
  const [compareSide, setCompareSide] = useState<MergeSide>("final");

  async function run() {
    const src = ctx.buildSource();
    if (!src) return;
    const draftBody = ctx.getDraftBody();
    const finalBody = ctx.getFinalBody();
    if (!draftBody.trim() && !finalBody.trim()) {
      toast({ title: t("merge.bothEmpty") });
      return;
    }
    setDraftSnapshot(draftBody);
    setFinalSnapshot(finalBody);
    setMerged("");
    setExplanation("");
    setOpen(true);
    setLoading(true);
    try {
      const result = await mergeDraftAndFinal(src, draftBody, finalBody, ctx.ghostwriterSlug);
      setMerged(result.text);
      setExplanation(result.explanation);
    } catch (err) {
      toast({ title: t("merge.failed"), description: String(err), variant: "destructive" });
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  async function apply(side: MergeSide) {
    const src = ctx.buildSource();
    if (!src || !merged.trim()) return;
    const path = side === "draft" ? ctx.draftPath : ctx.finalPath;
    if (!path) return;
    const existingFm = side === "draft" ? ctx.getDraftFrontmatter?.() : ctx.getFinalFrontmatter?.();
    const fallbackFm = side === "draft" ? ctx.defaultDraftFrontmatter?.() : ctx.defaultFinalFrontmatter?.();
    const frontmatter = existingFm || fallbackFm || "";
    setApplying(true);
    try {
      await createOrUpdateTextFile(src.token, src.owner, src.repo, src.branch, path, joinDoc(frontmatter, merged), `Merge draft and final into ${side} ${path}`);
      toast({ title: side === "draft" ? t("merge.appliedToDraft") : t("merge.appliedToFinal") });
      ctx.onApplied?.(side, merged);
      setOpen(false);
    } catch (err) {
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setApplying(false);
    }
  }

  const previous = compareSide === "draft" ? draftSnapshot : finalSnapshot;

  const dialog = (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !applying) setOpen(false); }}>
      <DialogContent className="flex h-[90dvh] max-h-[90dvh] w-[97vw] max-w-none flex-col gap-0 p-0 sm:w-[980px]">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Wand2 className="h-4 w-4 text-primary" />
          <div>
            <p className="font-semibold">{t("merge.title")}</p>
            <p className="text-xs text-muted-foreground">{t("merge.subtitle")}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t("merge.generating")}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1.35fr_1fr]">
            <div className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
              <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                <p className="text-sm font-semibold">{t("merge.mergedResult")}</p>
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-muted-foreground">{t("merge.compareWith")}</span>
                  <Button size="sm" variant={compareSide === "draft" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => setCompareSide("draft")}>{t("chapter.draft")}</Button>
                  <Button size="sm" variant={compareSide === "final" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => setCompareSide("final")}>{t("stageIndex.final")}</Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <FileDiff previous={previous} next={merged} />
              </div>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="border-b px-4 py-2"><p className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="h-3.5 w-3.5 text-primary" />{t("merge.explanation")}</p></div>
              <div
                className="doc-prose min-h-0 flex-1 max-w-none overflow-auto p-4 text-sm leading-6"
                dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(explanation || "") }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={applying}>{t("common.cancel")}</Button>
          <Button variant="outline" onClick={() => void run()} disabled={loading || applying}><Wand2 className="mr-1.5 h-4 w-4" />{t("pipeline.regenerate")}</Button>
          <Button variant="outline" onClick={() => void apply("draft")} disabled={loading || applying || !merged.trim()}>
            {applying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileEdit className="mr-1.5 h-4 w-4" />}{t("merge.applyToDraft")}
          </Button>
          <Button onClick={() => void apply("final")} disabled={loading || applying || !merged.trim()}>
            {applying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-1.5 h-4 w-4" />}{t("merge.applyToFinal")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { run, dialog, busy: loading || applying };
}
