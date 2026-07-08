import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Cpu, FlaskConical, GitCompareArrows, Loader2, X } from "lucide-react";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { loadFileContent } from "@/github/githubClient";
import { integrationChatModels } from "@/assistant/llm";
import { regenerateEntity } from "@/research/regenerateEntity";
import type { EntityKind } from "@/narrarium/canon";
import type { BookEntry } from "@/types/settings";
import type { ResearchFile } from "@/types/book";

export function RegenerateEntityDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: BookEntry;
  token: string;
  branch: string;
  entityKind: EntityKind;
  entityPath: string;
  entityName: string;
  currentContent: string;
  researchFiles: ResearchFile[];
  bookLanguage?: string;
  onAccept: (proposedBody: string, frontmatterPatches: Record<string, unknown>) => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();

  const [selectedResearch, setSelectedResearch] = useState<Set<string>>(new Set());
  const [customPrompt, setCustomPrompt] = useState("");
  const [llmOverride, setLlmOverride] = useState("");
  const [step, setStep] = useState<"configure" | "preview">("configure");
  const [proposedBody, setProposedBody] = useState("");
  const [proposedPatches, setProposedPatches] = useState<Record<string, unknown>>({});
  const [generating, setGenerating] = useState(false);
  const [researchContents, setResearchContents] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  // Preload research content whenever selection changes
  useEffect(() => {
    if (!props.open) return;
    const toLoad = [...selectedResearch].filter((slug) => !(slug in researchContents));
    if (!toLoad.length) return;
    for (const slug of toLoad) {
      const file = props.researchFiles.find((f) => f.slug === slug);
      if (!file) continue;
      loadFileContent(props.token, props.book.owner, props.book.repo, file.path, props.branch)
        .then((content) => setResearchContents((prev) => ({ ...prev, [slug]: content })))
        .catch(() => {});
    }
  }, [selectedResearch, props.open, props.researchFiles, props.token, props.book, props.branch, researchContents]);

  // Reset when opened/closed
  useEffect(() => {
    if (!props.open) return;
    setStep("configure");
    setProposedBody("");
    setProposedPatches({});
    setSelectedResearch(new Set());
    setCustomPrompt("");
    setGenerating(false);
  }, [props.open]);

  const llmOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: "", label: t("research.llmRouter") }];
    for (const integration of settings.aiIntegrations ?? []) {
      for (const model of integrationChatModels(integration)) {
        opts.push({ value: `${integration.id}::${model.name}`, label: `${integration.name} / ${model.name}` });
      }
    }
    return opts;
  }, [settings.aiIntegrations, t]);

  function toggleResearch(slug: string) {
    setSelectedResearch((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleGenerate() {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setGenerating(true);
    try {
      const lang = props.bookLanguage ?? i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";
      const [overrideIntegrationId, overrideModelName] = llmOverride ? llmOverride.split("::") : [undefined, undefined];
      const markdowns = [...selectedResearch].map((slug) => researchContents[slug]).filter(Boolean);

      const result = await regenerateEntity({
        settings,
        book: props.book,
        currentContent: props.currentContent,
        researchMarkdowns: markdowns,
        entityKind: props.entityKind,
        customPrompt: customPrompt.trim() || undefined,
        language: lang,
        overrideIntegrationId,
        overrideModelName,
        signal: abortRef.current.signal,
      });

      setProposedBody(result.proposedBody);
      setProposedPatches(result.proposedFrontmatterPatches);
      setStep("preview");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast({ title: t("canon.regenerateFailed"), description: String(err), variant: "destructive" });
      }
    } finally {
      setGenerating(false);
    }
  }

  function handleAccept() {
    props.onAccept(proposedBody, proposedPatches);
    props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="left-1/2 top-1/2 flex h-[88dvh] max-h-[88dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[740px]">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrows className="h-5 w-5 text-primary" />
            {t("canon.regenerateTitle")}: {props.entityName}
          </DialogTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("canon.regenerateDescription")}</p>
        </DialogHeader>

        {step === "configure" ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* Research file selection */}
              {props.researchFiles.length > 0 && (
                <div className="space-y-2">
                  <Label>{t("canon.regenerateResearch")}</Label>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-3">
                    {props.researchFiles.map((file) => {
                      const selected = selectedResearch.has(file.slug);
                      return (
                        <button
                          key={file.slug}
                          type="button"
                          onClick={() => toggleResearch(file.slug)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                            selected
                              ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          }`}
                        >
                          <Check className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "opacity-0"}`} />
                          <span className="truncate">{file.title || file.slug}</span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedResearch.size > 0 && (
                    <p className="text-xs text-muted-foreground">{selectedResearch.size} {t("canon.regenerateResearchSelected")}</p>
                  )}
                </div>
              )}

              {/* Custom prompt */}
              <div className="grid gap-2">
                <Label>{t("canon.regeneratePrompt")}</Label>
                <AutoTextarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder={t("canon.regeneratePromptPlaceholder")}
                  className="min-h-[100px] text-sm"
                />
              </div>

              {/* LLM override */}
              <div className="grid gap-2 sm:max-w-sm">
                <Label className="flex items-center gap-1"><Cpu className="h-3.5 w-3.5" />{t("research.llmLabel")}</Label>
                <Select value={llmOverride} onValueChange={setLlmOverride} disabled={generating}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {llmOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <Button variant="ghost" onClick={() => props.onOpenChange(false)}>{t("common.cancel")}</Button>
              <Button onClick={() => void handleGenerate()} disabled={generating}>
                {generating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-1 h-4 w-4" />}
                {generating ? t("research.creating") : t("canon.regenerateGenerate")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-5 py-2">
              <Badge variant="outline" className="text-xs">{t("canon.regenerateProposed")}</Badge>
              {Object.keys(proposedPatches).length > 0 && (
                <Badge variant="secondary" className="text-xs">{t("canon.regenerateHasPatches", { count: Object.keys(proposedPatches).length })}</Badge>
              )}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void handleGenerate()} disabled={generating}>
                {generating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="mr-1 h-3.5 w-3.5" />}
                {t("canon.regenerateAgain")}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              {generating ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />{t("research.creating")}
                </div>
              ) : (
                <AutoTextarea
                  value={proposedBody}
                  onChange={(e) => setProposedBody(e.target.value)}
                  className="text-sm leading-7"
                  minRows={16}
                />
              )}
            </div>

            {Object.keys(proposedPatches).length > 0 && (
              <>
                <Separator />
                <div className="px-5 py-3 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("canon.regeneratePatchedFields")}</p>
                  {Object.entries(proposedPatches).map(([key, val]) => (
                    <div key={key} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-muted-foreground">{key}:</span>
                      <span className="truncate">{String(val)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <Button variant="ghost" onClick={() => setStep("configure")}>{t("common.back")}</Button>
              <Button variant="ghost" onClick={() => props.onOpenChange(false)}><X className="mr-1 h-4 w-4" />{t("common.cancel")}</Button>
              <Button onClick={handleAccept} disabled={generating || !proposedBody.trim()}>
                {t("canon.regenerateAccept")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
