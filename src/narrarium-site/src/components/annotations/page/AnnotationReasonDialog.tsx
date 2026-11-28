import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, Send, Sparkles, Square } from "lucide-react";
import "@/i18n/annotationsPage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { completeTextRouted } from "@/assistant/router";
import { currentRequest, untrustedData } from "@/assistant/promptTrust";
import type { LlmMessage } from "@/assistant/llm";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { useSettingsStore } from "@/store/settingsStore";
import { conversationInstruction, reasonNotesData, reasonSystem, REASON_MAX_NOTES, type ReasonMessage, type ReasonNote } from "@/annotations/fix";
import { annotationStatus, resolveTag, type Annotation, type ResolvedTag } from "@/annotations/model";
import { loadPassageContext } from "@/components/annotations/page/passageContext";
import { useBookAnnotations } from "@/annotations/useBookAnnotations";
import { useBookStructure } from "@/hooks/useBookStructure";
import { cn } from "@/lib/utils";

export type ReasonScope =
  | { kind: "note"; annotation: Annotation }
  | { kind: "chapter"; chapter: string; title: string; annotations: readonly Annotation[] }
  | { kind: "book"; annotations: readonly Annotation[] };

const SCENE_CONTEXT_CHARACTERS = 3000;

/**
 * «Let's reason together»: a short conversation with the AI about one note, the notes of a chapter or those of the whole book. The notes with their passages
 * and words are the context (a note also the blocks around its passage, read from the working copy); the AI suggests and asks, and changes nothing. A
 * conversation about one note can end in a proposal: «Propose a fix» opens the fix with what was said as its instruction, and the author reviews it there.
 */
export function AnnotationReasonDialog({ bookId, scope, catalog, titles, onClose, onFix }: {
  bookId: string;
  scope: ReasonScope | null;
  catalog: readonly ResolvedTag[];
  /** The title of a chapter by its slug, for the notes of a chapter or of the book. */
  titles?: ReadonlyMap<string, string>;
  onClose: () => void;
  /** A conversation about one note ended in a proposal: the fix of that note, with what was said. */
  onFix?: (annotation: Annotation, instruction: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const data = useBookAnnotations(bookId);
  const { structure } = useBookStructure(bookId);
  const [messages, setMessages] = useState<ReasonMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [problem, setProblem] = useState("");
  const request = useRef<AbortController | null>(null);
  const sceneContext = useRef<string>("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const notes: Annotation[] = scope ? (scope.kind === "note" ? [scope.annotation] : [...scope.annotations]) : [];
  const language = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    request.current?.abort();
    setMessages([]);
    setDraft("");
    setAsking(false);
    setStreaming("");
    setProblem("");
    sceneContext.current = "";
    if (scope?.kind === "note" && data.book && data.branch) {
      let live = true;
      void loadPassageContext({ token: data.token, book: data.book, branch: data.branch, chapter: structure?.chapters.find((entry) => entry.slug === scope.annotation.chapter), annotation: scope.annotation }).then((found) => {
        if (!live || !("context" in found)) return;
        const { target, chapterTitle, sceneTitle } = found.context;
        sceneContext.current = [`WHERE: ${chapterTitle} / ${sceneTitle}`, target.before ? `THE BLOCK BEFORE:\n${target.before.slice(-SCENE_CONTEXT_CHARACTERS)}` : "", `THE BLOCKS WITH THE PASSAGE:\n${target.original}`, target.after ? `THE BLOCK AFTER:\n${target.after.slice(0, SCENE_CONTEXT_CHARACTERS)}` : ""].filter(Boolean).join("\n\n");
      });
      return () => { live = false; request.current?.abort(); };
    }
    return () => request.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [messages, streaming]);

  const reasonNotes = useCallback((): ReasonNote[] => notes.map((annotation) => ({
    quote: annotation.quote,
    comment: annotation.comment,
    tag: resolveTag(catalog, annotation.tag, t("annotations.tag.missing")).name,
    chapter: titles?.get(annotation.chapter) ?? annotation.chapter,
    scene: annotation.paragraph,
    status: annotationStatus(annotation.status),
  })), [catalog, notes, t, titles]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const text = draft.trim();
    if (!text || asking || !scope) return;
    const history: ReasonMessage[] = [...messages, { role: "user", text }];
    setMessages(history);
    setDraft("");
    setProblem("");
    setAsking(true);
    setStreaming("");
    const controller = new AbortController();
    request.current = controller;
    const material = [reasonNotesData(reasonNotes()), sceneContext.current].filter(Boolean).join("\n\n");
    const [first, ...rest] = history;
    const llm: LlmMessage[] = [
      { role: "system", content: reasonSystem(scope.kind, language) },
      { role: "user", content: `${currentRequest(first.text)}\n\n${untrustedData("repository_content", material)}` },
      ...rest.map((message): LlmMessage => ({ role: message.role, content: message.text })),
    ];
    try {
      const reply = await completeTextRouted(useSettingsStore.getState().settings, llm, "copilot", {
        accountScope: localWorkspaceScope(),
        signal: controller.signal,
        label: "annotation:reason",
        onText: (partial) => { if (!controller.signal.aborted) setStreaming(partial); },
      });
      if (controller.signal.aborted) return;
      setMessages([...history, { role: "assistant", text: reply.trim() }]);
    } catch (error) {
      if (!controller.signal.aborted) setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) request.current = null;
      setAsking(false);
      setStreaming("");
    }
  };

  const stop = () => { request.current?.abort(); setAsking(false); setStreaming(""); };
  const close = () => { request.current?.abort(); onClose(); };
  const canFix = scope?.kind === "note" && messages.some((message) => message.role === "assistant") && !asking;
  const sent = Math.min(notes.length, REASON_MAX_NOTES);

  return (
    <Dialog open={Boolean(scope)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-3 overflow-hidden sm:max-w-2xl" data-annotation-reason="">
        <DialogHeader>
          <DialogTitle>{scope?.kind === "chapter" ? t("annotationsPage.reason.titleChapter", { chapter: scope.title }) : scope?.kind === "book" ? t("annotationsPage.reason.titleBook") : t("annotationsPage.reason.title")}</DialogTitle>
          <DialogDescription>{t("annotationsPage.reason.description")}</DialogDescription>
        </DialogHeader>
        {scope && scope.kind !== "note" && <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground" data-reason-sends="">{t("annotationsPage.reason.sends", { count: sent })}{notes.length > REASON_MAX_NOTES ? ` ${t("annotationsPage.reason.cut", { count: REASON_MAX_NOTES })}` : ""}</p>}
        {scope?.kind === "note" && (
          <figure className="space-y-1 rounded-md border-l-4 border-primary/50 bg-muted/40 px-3 py-2">
            <blockquote className="line-clamp-3 font-serif text-sm">{scope.annotation.quote}</blockquote>
            {scope.annotation.comment && <p className="whitespace-pre-wrap break-words text-sm">{scope.annotation.comment}</p>}
          </figure>
        )}

        <div ref={logRef} role="log" aria-live="polite" aria-label={t("annotationsPage.reason.conversation")} className="min-h-24 flex-1 space-y-2 overflow-y-auto rounded-md border p-2" tabIndex={0}>
          {messages.length === 0 && !asking && <p className="text-sm text-muted-foreground">{t("annotationsPage.reason.empty")}</p>}
          {messages.map((message, index) => (
            <div key={index} className={cn("max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm", message.role === "user" ? "ml-auto bg-primary/10" : "bg-muted")}>
              <span className="sr-only">{message.role === "user" ? t("annotationsPage.reason.you") : t("annotationsPage.reason.editor")}: </span>{message.text}
            </div>
          ))}
          {asking && (
            <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="sr-only">{t("annotationsPage.reason.editor")}: </span>
              {streaming || <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("annotationsPage.reason.thinking")}</span>}
            </div>
          )}
        </div>
        {problem && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{problem}</p>}

        <div className="grid gap-1.5">
          <Label htmlFor={`${base}-draft`}>{t("annotationsPage.reason.write")}</Label>
          <Textarea
            id={`${base}-draft`}
            value={draft}
            rows={2}
            disabled={asking}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}
            aria-describedby={`${base}-hint`}
          />
          <p id={`${base}-hint`} className="text-xs text-muted-foreground">{t("annotationsPage.reason.hint")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {messages.length > 0 && !asking && <Button type="button" variant="ghost" onClick={() => { setMessages([]); setProblem(""); }} className="mr-auto [@media(pointer:coarse)]:h-11"><RotateCcw aria-hidden="true" />{t("annotationsPage.reason.startOver")}</Button>}
          {canFix && onFix && scope?.kind === "note" && (
            <Button type="button" variant="outline" onClick={() => { onFix(scope.annotation, conversationInstruction(messages)); close(); }} className="[@media(pointer:coarse)]:h-11"><Sparkles aria-hidden="true" />{t("annotationsPage.reason.propose")}</Button>
          )}
          {asking
            ? <Button type="button" variant="outline" onClick={stop} className="[@media(pointer:coarse)]:h-11"><Square aria-hidden="true" />{t("annotationsPage.reason.stop")}</Button>
            : <Button type="button" disabled={!draft.trim()} onClick={() => void send()} className="[@media(pointer:coarse)]:h-11"><Send aria-hidden="true" />{t("annotationsPage.reason.send")}</Button>}
          <Button type="button" variant="ghost" onClick={close} className="[@media(pointer:coarse)]:h-11">{t("annotationsPage.reason.close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
