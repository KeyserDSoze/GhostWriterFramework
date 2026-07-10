import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { useToast } from "@/components/ui/use-toast";
import { improveProse, synonymsFor, type PipelineSource } from "@/narrarium/pipeline";
import { completeTextRouted } from "@/assistant/router";

/** Split a selection into leading whitespace, core text, and trailing whitespace
 * so a replacement keeps the surrounding spaces (e.g. double-click that grabs the trailing space). */
function splitEdges(text: string): { lead: string; core: string; trail: string } {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const trail = text.match(/\s*$/)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  return { lead, core, trail };
}

export function useProseAssist(opts: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  getBody: () => string;
  setBody: (next: string) => void;
  buildSource: () => PipelineSource | null;
  ghostwriter?: string;
  improveText?: (body: string, selection: string | null) => Promise<string>;
  summarizeText?: (body: string, selection: string | null) => Promise<string>;
  onSaveSummary?: (summary: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [improveOpen, setImproveOpen] = useState(false);
  const [improveLoading, setImproveLoading] = useState(false);
  const [improveNew, setImproveNew] = useState("");
  const [improveSelection, setImproveSelection] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [summarySelection, setSummarySelection] = useState<string | null>(null);

  const [synonymOpen, setSynonymOpen] = useState(false);
  const [synonymLoading, setSynonymLoading] = useState(false);
  const [synonymWord, setSynonymWord] = useState("");
  const [synonymOptions, setSynonymOptions] = useState<string[]>([]);
  const [synonymSeen, setSynonymSeen] = useState<string[]>([]);

  function captureRange() {
    const el = opts.textareaRef.current;
    if (el && el.selectionEnd > el.selectionStart) {
      const r = { start: el.selectionStart, end: el.selectionEnd };
      setRange(r);
      return opts.getBody().slice(r.start, r.end);
    }
    setRange(null);
    return null;
  }

  async function runImprove(selection: string | null) {
    const src = opts.buildSource();
    if (!src && !opts.improveText) return;
    setImproveLoading(true);
    try {
      setImproveNew(opts.improveText
        ? await opts.improveText(opts.getBody(), selection)
        : await improveProse(src!, opts.getBody(), selection, opts.ghostwriter));
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setImproveLoading(false);
    }
  }

  async function runSummary(selection: string | null) {
    const src = opts.buildSource();
    if (!src && !opts.summarizeText) return;
    setSummaryLoading(true);
    try {
      setSummaryText(opts.summarizeText
        ? await opts.summarizeText(opts.getBody(), selection)
        : await completeTextRouted(src!.settings, [
            { role: "system", content: "Summarize the selected text clearly and concisely. Return only the summary." },
            { role: "user", content: selection ?? opts.getBody() },
          ], "chat-resume", { label: "editor:summarize" }));
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setSummaryLoading(false);
    }
  }

  function improve(_selection: string | null) {
    const sel = captureRange();
    setImproveSelection(sel);
    setImproveNew("");
    setImproveOpen(true);
    void runImprove(sel);
  }

  function applyImprove() {
    const body = opts.getBody();
    if (improveSelection && range) {
      const { lead, trail } = splitEdges(body.slice(range.start, range.end));
      opts.setBody(body.slice(0, range.start) + lead + improveNew.trim() + trail + body.slice(range.end));
    } else {
      opts.setBody(improveNew);
    }
    setImproveOpen(false);
  }

  function summarize(_selection: string | null) {
    const sel = captureRange();
    setSummarySelection(sel);
    setSummaryText("");
    setSummaryOpen(true);
    void runSummary(sel);
  }

  function applySummary() {
    const body = opts.getBody();
    if (summarySelection && range) {
      const { lead, trail } = splitEdges(body.slice(range.start, range.end));
      opts.setBody(body.slice(0, range.start) + lead + summaryText.trim() + trail + body.slice(range.end));
    } else {
      opts.setBody(summaryText);
    }
    setSummaryOpen(false);
  }

  async function loadSynonyms(exclude: string[], word?: string) {
    const src = opts.buildSource();
    const target = word ?? synonymWord;
    if (!src || !target) return;
    setSynonymLoading(true);
    try {
      const options = await synonymsFor(src, opts.getBody(), target, { count: 3, exclude, ghostwriterSlug: opts.ghostwriter });
      setSynonymOptions(options);
      setSynonymSeen((prev) => [...prev, ...options]);
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setSynonymLoading(false);
    }
  }

  function synonym(selection: string) {
    const sel = captureRange() ?? selection;
    const core = splitEdges(sel).core;
    setSynonymWord(core);
    setSynonymOptions([]);
    setSynonymSeen([]);
    setSynonymOpen(true);
    void loadSynonyms([], core);
  }

  function applySynonym(word: string) {
    const body = opts.getBody();
    if (range) {
      const { lead, trail } = splitEdges(body.slice(range.start, range.end));
      opts.setBody(body.slice(0, range.start) + lead + word + trail + body.slice(range.end));
    }
    setSynonymOpen(false);
  }

  const dialogs = (
    <>
      <Dialog open={improveOpen} onOpenChange={(next) => { if (!next) setImproveOpen(false); }}>
        <DialogContent className="left-1/2 top-1/2 flex h-[88dvh] max-h-[88dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[820px]">
          <div className="border-b px-4 py-3">
            <p className="font-semibold">{improveSelection ? t("ctx.improveSelection") : t("ctx.improveAll")}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {improveLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
            ) : (
              <FileDiff previous={improveSelection ?? opts.getBody()} next={improveNew} />
            )}
          </div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <Button variant="ghost" onClick={() => setImproveOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="outline" onClick={() => void runImprove(improveSelection)} disabled={improveLoading}>{t("pipeline.regenerate")}</Button>
            <Button onClick={applyImprove} disabled={improveLoading || !improveNew.trim()}>{t("pipeline.apply")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={synonymOpen} onOpenChange={(next) => { if (!next) setSynonymOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <div className="space-y-3">
            <div>
              <p className="font-semibold">{t("ctx.synonym")}</p>
              <p className="text-xs text-muted-foreground">{t("ctx.synonymFor", { word: synonymWord })}</p>
            </div>
            {synonymLoading && synonymOptions.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {synonymOptions.map((option) => (
                  <button key={option} type="button" onClick={() => applySynonym(option)} className="rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent">{option}</button>
                ))}
                {synonymOptions.length === 0 && <p className="text-sm text-muted-foreground">{t("ctx.noSynonyms")}</p>}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => void loadSynonyms(synonymSeen)} disabled={synonymLoading}>{synonymLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("ctx.moreSynonyms")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setSynonymOpen(false)}>{t("common.cancel")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={summaryOpen} onOpenChange={(next) => { if (!next) setSummaryOpen(false); }}>
        <DialogContent className="max-w-2xl">
          <div className="space-y-4">
            <div>
              <p className="font-semibold">{t("ctx.summary")}</p>
              <p className="text-xs text-muted-foreground">{summarySelection ? t("ctx.summarySelection") : t("ctx.summaryAll")}</p>
            </div>
            {summaryLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
            ) : (
              <textarea value={summaryText} onChange={(event) => setSummaryText(event.target.value)} className="min-h-48 w-full rounded-md border bg-background p-3 text-sm leading-6" />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setSummaryOpen(false)}>{t("common.cancel")}</Button>
              {opts.onSaveSummary && <Button variant="outline" onClick={() => void opts.onSaveSummary?.(summaryText)} disabled={summaryLoading || !summaryText.trim()}>{t("ctx.saveSummaryNote")}</Button>}
              <Button onClick={applySummary} disabled={summaryLoading || !summaryText.trim()}>{t("ctx.replaceWithSummary")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  return { improve, summarize, synonym, dialogs };
}
