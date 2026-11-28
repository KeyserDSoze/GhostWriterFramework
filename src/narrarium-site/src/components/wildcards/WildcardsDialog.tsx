import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import {
  WILDCARD_MAX_VOICES, WILDCARD_PRESETS, loadBookSnapshot, wildcardMaterial, wildcardRoomContext, wildcardTargetLabel,
  type BookSnapshot, type WildcardConsultResult, type WildcardPresetId, type WildcardProfile, type WildcardTarget,
} from "narrarium-engine";
import "@/i18n/wildcards";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { WildcardIdeasReview } from "@/components/wildcards/WildcardIdeasReview";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { refreshBookAfterMutation } from "@/assistant/mutationRefresh";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBooksStore } from "@/store/booksStore";
import { useGenerateDiffStore } from "@/store/generateDiffStore";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useWildcardsDialogStore, type WildcardsRequest, type WildcardsSelection } from "@/store/wildcardsDialogStore";
import { resolveWorkingCopyToken } from "@/types/settings";
import { acceptedIdeas, outlineEntryWithIdeas, readSceneBody, recordWildcardDecisions, rewriteWithIdeas, writeSceneBody, type WildcardChoice } from "@/wildcards/applyIdeas";
import { consultBookRoom, roomEstimate } from "@/wildcards/roomRunner";
import { loadWildcardRoom } from "@/wildcards/wildcardFiles";

/**
 * «Out-of-the-box ideas…»: the room consulted on a selection, a scene or a chapter. The author chooses who is asked (a preset or the voices one by one) and,
 * if they want, a question, and sees what it will cost; the voices answer, and their ideas are in a table where each is accepted or skipped; one button
 * records the decisions in the journal of the room and hands the accepted ideas on: a rewrite of the selection or of the scene by its ghostwriter, or the
 * chapter's entry of the Synopsis, each shown as a difference that the author keeps or not. Loaded only when it is open.
 */

type Phase = "loading" | "choose" | "running" | "review" | "error";
type Choice = WildcardPresetId | "custom";

interface Loaded {
  snapshot: BookSnapshot;
  target: WildcardTarget;
  room: WildcardProfile[];
  materialChars: number;
  contextChars: number;
}

function resolveTarget(snapshot: BookSnapshot, request: WildcardsRequest): Omit<WildcardTarget, "label"> {
  const chapter = snapshot.chapters.find((entry) => entry.slug === request.target.chapter);
  if (!chapter) throw new Error(`Chapter not found: ${request.target.chapter}`);
  if (request.target.kind === "chapter") return { kind: "chapter", chapter: chapter.number };
  const wanted = request.target.paragraph ?? "";
  const paragraph = chapter.paragraphs.find((entry) => entry.slug === wanted) ?? chapter.paragraphs.find((entry) => entry.number === Number(wanted));
  return { kind: request.target.kind, chapter: chapter.number, ...(paragraph ? { paragraph: paragraph.number } : {}) };
}

function replaceSelection(selection: WildcardsSelection, text: string, staleMessage: string): void {
  const field = selection.editable;
  if (!field || !selection.range || field.value !== selection.sourceValue || field.value.slice(selection.range.start, selection.range.end) !== selection.text) throw new Error(staleMessage);
  const { start, end } = selection.range;
  const selected = field.value.slice(start, end);
  const lead = selected.match(/^\s*/)?.[0] ?? "";
  const trail = selected.match(/\s*$/)?.[0] ?? "";
  const next = field.value.slice(0, start) + lead + text + trail + field.value.slice(end);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  setter?.call(field, next);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  requestAnimationFrame(() => {
    field.focus();
    const caret = start + lead.length + text.length;
    field.setSelectionRange(caret, caret);
  });
}

export function WildcardsDialog() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const id = useId();
  const request = useWildcardsDialogStore((state) => state.request);
  const close = useWildcardsDialogStore((state) => state.close);
  const settings = useSettingsStore((state) => state.settings);
  const book = settings.books.find((entry) => entry.id === request?.bookId);
  const structure = useBooksStore((state) => (request ? state.structures[request.bookId] : undefined));
  const { branch } = useWorkingBranch(request?.bookId);
  const token = book ? resolveWorkingCopyToken(book, settings) : "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choice, setChoice] = useState<Choice>("creative-room");
  const [chosen, setChosen] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WildcardConsultResult | null>(null);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const language = structure?.language || settings.ui.language;

  useEffect(() => {
    if (!request || !book || !branch) return;
    let cancelled = false;
    setPhase(request.result ? "review" : "loading");
    setResult(request.result ?? null);
    setQuestion(request.question ?? "");
    setError("");
    setProgress({});
    void (async () => {
      try {
        const store = createBrowserBookStore(book, branch);
        const snapshot = await loadBookSnapshot(store);
        const base = resolveTarget(snapshot, request);
        const target: WildcardTarget = { ...base, label: wildcardTargetLabel(base, snapshot) };
        const [{ room }, material, context] = await Promise.all([
          loadWildcardRoom({ settings, token, book, branch, structure: structure ?? null }),
          wildcardMaterial(store, snapshot, target, request.selection?.text),
          wildcardRoomContext(store, snapshot, target),
        ]);
        if (cancelled) return;
        setLoaded({ snapshot, target, room: room.filter((profile) => profile.enabled && !profile.warnings?.length), materialChars: material.length, contextChars: (context.synopsis ?? "").length + (context.canon ?? "").length + (context.storySoFar ?? "").length });
        if (!request.result) setPhase("choose");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => { cancelled = true; };
    // The request is what opens the dialog: what it reads is read again only for a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, book?.id, branch]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const voices = useMemo(() => {
    if (!loaded) return [] as WildcardProfile[];
    const slugs = choice === "custom" ? chosen : WILDCARD_PRESETS.find((preset) => preset.id === choice)?.slugs ?? [];
    return slugs.map((slug) => loaded.room.find((profile) => profile.slug === slug)).filter((profile): profile is WildcardProfile => Boolean(profile)).slice(0, WILDCARD_MAX_VOICES);
  }, [choice, chosen, loaded]);

  const estimate = loaded && voices.length ? roomEstimate(settings, { voices: voices.length, materialChars: loaded.materialChars, contextChars: loaded.contextChars }) : null;
  const money = (value: number) => new Intl.NumberFormat(i18n.language, { style: "currency", currency: estimate?.cost?.currency || settings.costCurrency || "USD", maximumFractionDigits: value < 0.1 ? 3 : 2 }).format(value);
  const estimateText = estimate
    ? estimate.cost
      ? t("wildcards.dialog.estimate", { calls: estimate.calls.min === estimate.calls.max ? estimate.calls.min : `${estimate.calls.min}–${estimate.calls.max}`, cost: `${money(estimate.cost.min)}–${money(estimate.cost.max)}` })
      : t("wildcards.dialog.estimateNoPrice", { calls: `${estimate.calls.min}–${estimate.calls.max}` })
    : "";

  function onOpenChange(open: boolean) {
    if (open) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    close();
  }

  async function ask() {
    if (!request || !book || !loaded || !voices.length) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase("running");
    setProgress(Object.fromEntries(voices.map((voice) => [voice.slug, "waiting"])));
    try {
      const consulted = await consultBookRoom({
        settings, book, branch,
        snapshot: loaded.snapshot,
        panel: loaded.room,
        target: loaded.target,
        ...(request.selection ? { material: request.selection.text } : {}),
        ...(choice === "custom" ? { voices: voices.map((voice) => voice.slug) } : { preset: choice }),
        maxVoices: WILDCARD_MAX_VOICES,
        ...(question.trim() ? { question: question.trim() } : {}),
        by: "author",
        signal: controller.signal,
        onVoice: (event) => setProgress((current) => ({ ...current, [event.slug]: event.status })),
      });
      if (controller.signal.aborted) return;
      setResult(consulted);
      setPhase("review");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function apply(choices: Record<string, WildcardChoice>): Promise<string> {
    if (!request || !book || !result || !loaded) return "";
    const decided = await recordWildcardDecisions({ token, book, branch, entry: result.entry, choices, language });
    const accepted = acceptedIdeas(decided);
    const counts = { accepted: accepted.length, skipped: Object.values(choices).filter((value) => value === "skip").length };
    const recorded = t("wildcards.review.applied", counts);
    if (!accepted.length) return recorded;
    const store = createBrowserBookStore(book, branch);
    const chapter = loaded.snapshot.chapters.find((entry) => entry.number === loaded.target.chapter);
    const paragraph = chapter?.paragraphs.find((entry) => entry.number === loaded.target.paragraph);
    const diff = useGenerateDiffStore.getState();
    if (request.target.kind === "chapter") {
      const entry = await outlineEntryWithIdeas({ store, chapter: loaded.target.chapter!, ideas: accepted, language });
      if (!entry) return `${recorded} ${t("wildcards.review.noEntry", { chapter: loaded.target.chapter })}`;
      close();
      toast({ title: recorded });
      void diff.start(async () => ({
        title: t("wildcards.review.entryTitle", { chapter: loaded.target.chapter }),
        oldText: entry.oldText,
        newText: entry.newText,
        apply: async () => {
          const [{ browserOutlineSource }, { commitWithJournal }] = await Promise.all([import("@/outline/outlineSource"), import("@/outline/outlineJournal")]);
          await commitWithJournal(browserOutlineSource(book, branch), [{ path: entry.path, content: entry.newText, expectedHash: entry.hash }], `Add the accepted ideas of the room to chapter ${loaded.target.chapter} of the Synopsis`, { by: "author", language });
          await refreshBookAfterMutation({ book, token, branch });
        },
      }));
      return recorded;
    }
    if (!chapter) return recorded;
    if (request.target.kind === "selection" && request.selection) {
      const selection = request.selection;
      close();
      toast({ title: recorded });
      void diff.start(async () => ({
        title: t("wildcards.review.rewriteTitle"),
        oldText: selection.text,
        newText: await rewriteWithIdeas({ settings, store, snapshot: loaded.snapshot, chapter, ...(paragraph ? { paragraph } : {}), text: selection.text, ideas: accepted, language, kind: "selection" }),
        apply: async () => replaceSelection(selection, useGenerateDiffStore.getState().newText, t("wildcards.review.stale")),
      }));
      return recorded;
    }
    if (!paragraph) return recorded;
    if (useSaveStore.getState().current?.dirty) throw new Error(t("wildcards.review.unsaved"));
    const scene = await readSceneBody({ token, book, branch, path: paragraph.path });
    close();
    toast({ title: recorded });
    void diff.start(async () => ({
      title: t("wildcards.review.rewriteTitle"),
      oldText: scene.body,
      newText: await rewriteWithIdeas({ settings, store, snapshot: loaded.snapshot, chapter, paragraph, text: scene.body, ideas: accepted, language, kind: "paragraph" }),
      apply: async () => {
        await writeSceneBody({ token, book, branch, path: paragraph.path, sha: scene.sha, body: useGenerateDiffStore.getState().newText, message: `Rewrite ${paragraph.path.split("/").pop()} with the accepted ideas of the room` });
        await refreshBookAfterMutation({ book, token, branch });
      },
    }));
    return recorded;
  }

  const applyLabel = request?.target.kind === "selection" ? t("wildcards.review.applySelection") : request?.target.kind === "paragraph" ? t("wildcards.review.applyParagraph") : t("wildcards.review.applyChapter");
  const label = loaded?.target.label ?? "";

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto" data-wildcards-dialog="">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" aria-hidden />{t("wildcards.dialog.title")}</DialogTitle>
          <DialogDescription>{t("wildcards.dialog.description", { target: label || "…" })}</DialogDescription>
        </DialogHeader>

        {phase === "loading" && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("wildcards.dialog.loading")}</p>}
        {phase === "error" && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{t("wildcards.dialog.failed", { reason: error })}</p>}

        {phase === "choose" && loaded && (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("wildcards.dialog.who")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {[...WILDCARD_PRESETS.map((preset) => preset.id), "custom" as const].map((value) => (
                  <label key={value} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${choice === value ? "border-primary bg-primary/5" : "border-field"}`}>
                    <input type="radio" name={`${id}-preset`} value={value} checked={choice === value} onChange={() => setChoice(value)} className="mt-1 accent-primary" />
                    <span>
                      <span className="block font-medium">{value === "custom" ? t("wildcards.dialog.custom") : t(`wildcards.presets.${value}`)}</span>
                      {value !== "custom" && <span className="block text-xs text-muted-foreground">{(WILDCARD_PRESETS.find((preset) => preset.id === value)?.slugs ?? []).map((slug) => loaded.room.find((profile) => profile.slug === slug)?.name ?? slug).join(", ")}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {choice === "custom" && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("wildcards.dialog.voicesLabel")}</legend>
                <p className="text-xs text-muted-foreground">{t("wildcards.dialog.voicesHint")}</p>
                {(["provocateur", "sentinel"] as const).map((group) => (
                  <div key={group} className="space-y-1">
                    <p className="text-xs font-semibold">{t(`wildcards.filters.${group}`)}</p>
                    <ul className="flex flex-wrap gap-2">
                      {loaded.room.filter((profile) => profile.group === group).map((profile) => {
                        const checked = chosen.includes(profile.slug);
                        return (
                          <li key={profile.id}>
                            <label className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${checked ? "border-primary bg-primary/10" : "border-field"}`}>
                              <input type="checkbox" checked={checked} disabled={!checked && chosen.length >= WILDCARD_MAX_VOICES} onChange={() => setChosen((current) => (checked ? current.filter((slug) => slug !== profile.slug) : [...current, profile.slug]))} className="accent-primary" />
                              {profile.name}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </fieldset>
            )}
            <div className="grid gap-2">
              <Label htmlFor={`${id}-question`}>{t("wildcards.dialog.question")}</Label>
              <Textarea id={`${id}-question`} value={question} onChange={(event) => setQuestion(event.target.value)} aria-describedby={`${id}-question-hint`} className="min-h-16" />
              <p id={`${id}-question-hint`} className="text-xs text-muted-foreground">{t("wildcards.dialog.questionHint")}</p>
            </div>
            {voices.length ? <p className="text-sm" data-wildcards-estimate="">{estimateText}</p> : <p className="text-sm text-destructive">{t("wildcards.dialog.noVoices")}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("wildcards.dialog.cancel")}</Button>
              <Button onClick={() => void ask()} disabled={!voices.length}><Sparkles className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.dialog.ask")}</Button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-2" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("wildcards.dialog.asking")}</p>
            <ul className="space-y-1 text-sm">
              {voices.map((voice) => <li key={voice.slug}>{voice.name}: {t(`wildcards.dialog.${progress[voice.slug] === "ok" ? "done" : progress[voice.slug] === "failed" ? "failedVoice" : progress[voice.slug] === "skipped" ? "skipped" : "running"}`)}</li>)}
            </ul>
          </div>
        )}

        {phase === "review" && result && (
          <div className="space-y-3">
            {result.ideas.length ? null : <p className="text-sm text-muted-foreground">{t("wildcards.dialog.none")}</p>}
            <WildcardIdeasReview result={result} applyLabel={applyLabel} onApply={apply} disabled={!loaded} />
            <div className="flex justify-end"><Button variant="ghost" onClick={() => onOpenChange(false)}>{t("wildcards.dialog.close")}</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
