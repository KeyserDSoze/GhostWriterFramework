import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ScanSearch, Sparkles, TriangleAlert } from "lucide-react";
import type { OutlineChapterEntry } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { useProseAssist } from "@/components/editor/useProseAssist";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import type { ProseEditorExtraAction } from "@/components/editor/proseEditorStore";
import type { EntryDraft } from "@/components/outline/useOutlineEditor";
import { NoCompletionCandidatesError } from "@/assistant/router";
import { parseStructuredOutput } from "@/assistant/structuredOutput";
import { selectMentionedCanonFiles, type CanonContextCandidate } from "@/assistant/canonContext";
import { checkMessages, checkOutputSchema, completeOutlineRequest, descriptionMessages, developMessages, improveMessages, NEARBY_ENTRIES, summarizeMessages, type OutlineAssistContext } from "@/outline/outlineAssistPrompts";
import type { OutlineSource } from "@/outline/outlineSource";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookStructure } from "@/types/book";
import type { ChatCapability } from "@/types/settings";

/** Canon files a request carries at most. */
const CANON_FILES = 8;

export interface OutlineAssistRequest {
  id: number;
  kind: "develop" | "check";
  number: number;
  /** The text of the entry when the request was made: the answer applies only over it. */
  before: string;
  loading: boolean;
  text?: string;
  issues?: string[];
  error?: string;
}

interface AssistInput {
  structure: BookStructure | null | undefined;
  source: OutlineSource | null;
  entries: readonly OutlineChapterEntry[];
  drafts: ReadonlyMap<number, EntryDraft>;
  /** The description of the book as the author sees it now. */
  description: string;
  editEntry: (number: number, patch: Partial<Pick<EntryDraft, "body">>) => void;
  announce: (text: string) => void;
}

function canonCandidates(structure: BookStructure | null | undefined): CanonContextCandidate[] {
  if (!structure) return [];
  return [
    ...structure.characters.map((file) => ({ path: file.path, name: file.name, section: "characters" as const })),
    ...structure.locations.map((file) => ({ path: file.path, name: file.name, section: "locations" as const })),
    ...structure.factions.map((file) => ({ path: file.path, name: file.name, section: "factions" as const })),
    ...structure.items.map((file) => ({ path: file.path, name: file.name, section: "items" as const })),
    ...structure.timelines.map((file) => ({ path: file.path, name: file.name, section: "timelines" as const })),
  ];
}

/**
 * The assistant of the Outline's text areas: what «Improve» and «Summarize» send for an entry, and the two actions of the Outline, «Develop this
 * chapter» and «Check against the canon and the nearby chapters», which always end in a preview the author applies or cancels. Nothing is saved:
 * an applied text is an unsaved change of the entry, like one typed by hand.
 */
export function useOutlineAssist(input: AssistInput) {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const [request, setRequest] = useState<OutlineAssistRequest | null>(null);
  const latest = useRef({ ...input, settings, t });
  latest.current = { ...input, settings, t };
  const counter = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  /** The text of an entry as the author sees it: the draft when there is one. */
  const textOf = useCallback((number: number) => {
    const { drafts, entries } = latest.current;
    const draft = drafts.get(number);
    const entry = entries.find((candidate) => candidate.number === number);
    return { title: draft?.title ?? entry?.title ?? "", body: draft?.body ?? entry?.body ?? "" };
  }, []);

  const contextFor = useCallback(async (number: number, body?: string): Promise<OutlineAssistContext> => {
    const { entries, structure, source, description, settings: current } = latest.current;
    const index = entries.findIndex((entry) => entry.number === number);
    const around = index < 0 ? [] : [...entries.slice(Math.max(0, index - NEARBY_ENTRIES), index), ...entries.slice(index + 1, index + 1 + NEARBY_ENTRIES)];
    const nearby = around.map((entry) => ({ number: entry.number, ...textOf(entry.number) }));
    const own = textOf(number);
    const text = body ?? own.body;
    const mentioned = selectMentionedCanonFiles(canonCandidates(structure), [own.title, text, ...nearby.map((entry) => `${entry.title}\n${entry.body}`)].join("\n"), CANON_FILES);
    const canon = source && mentioned.length ? await source.readFiles(mentioned.map((file) => file.path)).catch(() => []) : [];
    return { language: structure?.language ?? current.ui.language, bookTitle: structure?.title ?? "", description, number, title: own.title, body: text, nearby, canon };
  }, [textOf]);

  const complete = useCallback((messages: Parameters<typeof completeOutlineRequest>[1], capability: ChatCapability, label: string, signal?: AbortSignal) => completeOutlineRequest(latest.current.settings, messages, capability, label, signal), []);

  const open = useCallback((kind: "develop" | "check", number: number) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const id = ++counter.current;
    const before = textOf(number).body;
    setRequest({ id, kind, number, before, loading: true });
    void (async () => {
      try {
        const context = await contextFor(number, before);
        if (kind === "develop") {
          const text = (await complete(developMessages(context), "editor-actions", "outline:develop", controller.signal)).trim();
          if (counter.current === id) setRequest({ id, kind, number, before, loading: false, text });
        } else {
          const raw = await complete(checkMessages(context), "review", "outline:check", controller.signal);
          const parsed = parseStructuredOutput(raw, checkOutputSchema);
          if (counter.current === id) setRequest({ id, kind, number, before, loading: false, issues: parsed.issues.map((issue) => issue.trim()).filter(Boolean), text: parsed.revised.trim() });
        }
      } catch (error) {
        if (controller.signal.aborted || counter.current !== id) return;
        const message = error instanceof NoCompletionCandidatesError ? latest.current.t("outline.assist.noAi") : error instanceof Error ? error.message : String(error);
        setRequest({ id, kind, number, before, loading: false, error: message });
      }
    })();
  }, [complete, contextFor, textOf]);

  const close = useCallback(() => {
    inFlight.current?.abort();
    counter.current += 1;
    setRequest(null);
  }, []);

  const apply = useCallback(() => {
    const current = request;
    if (!current?.text) return;
    const { t: say } = latest.current;
    // The answer was made for the text the entry had: over a text changed since, it is not applied.
    if (textOf(current.number).body !== current.before) {
      setRequest({ ...current, error: say("outline.assist.stale") });
      return;
    }
    latest.current.editEntry(current.number, { body: current.text });
    latest.current.announce(say("outline.assist.applied", { number: current.number }));
    setRequest(null);
  }, [request, textOf]);

  const improveText = useCallback((number: number) => async (body: string, selection: string | null) => {
    const context = await contextFor(number, body);
    return complete(improveMessages(context, selection), "editor-actions", "outline:improve");
  }, [complete, contextFor]);

  const summarizeText = useCallback((number: number) => async (body: string, selection: string | null) => {
    const context = await contextFor(number, body);
    return complete(summarizeMessages(context, selection), "chat-resume", "outline:summarize");
  }, [complete, contextFor]);

  const describeText = useCallback((kind: "improve" | "summarize") => async (body: string, selection: string | null) => {
    const { structure, settings: current } = latest.current;
    return complete(descriptionMessages(kind, { language: structure?.language ?? current.ui.language, bookTitle: structure?.title ?? "", body, selection }), kind === "improve" ? "editor-actions" : "chat-resume", `outline:${kind}-description`);
  }, [complete]);

  const extraFor = useCallback((number: number): ProseEditorExtraAction[] => [
    { id: "outline-develop", label: t("outline.assist.develop"), icon: "sparkles", run: () => open("develop", number) },
    { id: "outline-check", label: t("outline.assist.check"), icon: "check", run: () => open("check", number) },
    // The labels follow the language of the app: the entry registers them again when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [open, t, i18n.language]);

  const entryLabels = useMemo(() => ({ improveAll: t("outline.assist.improveEntry"), summaryAll: t("outline.assist.summarizeEntry") }), [t]);
  const descriptionLabels = useMemo(() => ({ improveAll: t("outline.assist.improveDescription"), summaryAll: t("outline.assist.summarizeDescription") }), [t]);
  return useMemo(() => ({ request, open, close, apply, improveText, summarizeText, describeText, extraFor, entryLabels, descriptionLabels, language: i18n.language }), [request, open, close, apply, improveText, summarizeText, describeText, extraFor, entryLabels, descriptionLabels, i18n.language]);
}

export type OutlineAssistController = ReturnType<typeof useOutlineAssist>;

/**
 * Registers the text area of one entry with the context menu: «Improve» and «Summarize» (with the site's own preview, over the selection or
 * the whole text) and the two actions of the Outline. Rendered by the entry, next to its text area.
 */
export function OutlineBodyAssist({ number, textareaRef, value, onChange, controller }: { number: number; textareaRef: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void; controller: OutlineAssistController }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const assist = useProseAssist({
    textareaRef,
    getBody: () => valueRef.current,
    setBody: onChange,
    buildSource: () => null,
    improveText: controller.improveText(number),
    summarizeText: controller.summarizeText(number),
  });
  useRegisterProseEditor(textareaRef, { improve: assist.improve, summarize: assist.summarize, synonym: () => undefined, extra: controller.extraFor(number), labels: controller.entryLabels }, [controller.language]);
  return <>{assist.dialogs}</>;
}

/** «Improve» and «Summarize» on the description of the book. */
export function useOutlineDescriptionAssist({ textareaRef, value, onChange, controller, enabled }: { textareaRef: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void; controller: OutlineAssistController; enabled: boolean }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const assist = useProseAssist({
    textareaRef,
    getBody: () => valueRef.current,
    setBody: onChange,
    buildSource: () => null,
    improveText: controller.describeText("improve"),
    summarizeText: controller.describeText("summarize"),
  });
  useRegisterProseEditor(textareaRef, { improve: assist.improve, summarize: assist.summarize, synonym: () => undefined, labels: controller.descriptionLabels, enabled }, [enabled, controller.language]);
  return assist.dialogs;
}

/** The answer of «Develop this chapter» or of «Check»: what would change, applied only when the author says so. */
export function OutlineAssistDialog({ controller }: { controller: OutlineAssistController }) {
  const { t } = useTranslation();
  const request = controller.request;
  const develop = request?.kind === "develop";
  const changes = Boolean(request?.text && request.text !== request.before);
  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) controller.close(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[96vw] max-w-none flex-col gap-3 sm:w-[820px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {develop ? <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> : <ScanSearch className="h-4 w-4 text-primary" aria-hidden="true" />}
            {request ? t(develop ? "outline.assist.developTitle" : "outline.assist.checkTitle", { number: request.number }) : ""}
          </DialogTitle>
          <DialogDescription>{t(develop ? "outline.assist.developHint" : "outline.assist.checkHint")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {request?.loading && <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("pipeline.generating")}</p>}
          {request?.error && <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("outline.assist.failed")} {request.error}</p>}
          {request && !request.loading && !request.error && request.kind === "check" && (
            <section className="space-y-1">
              <h3 className="text-sm font-semibold">{t("outline.assist.issues")}</h3>
              {request.issues?.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{request.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t("outline.assist.noIssues")}</p>}
            </section>
          )}
          {request && !request.loading && changes && (
            <section className="space-y-1">
              <h3 className="text-sm font-semibold">{t("outline.assist.proposed")}</h3>
              <FileDiff previous={request.before} next={request.text ?? ""} className="max-h-[50vh]" />
            </section>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={controller.close}>{t("common.cancel")}</Button>
          {changes && !request?.error && <Button type="button" onClick={controller.apply}>{t("outline.assist.apply")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
