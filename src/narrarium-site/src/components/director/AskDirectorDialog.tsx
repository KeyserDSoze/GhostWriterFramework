import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clapperboard, Loader2, RotateCcw } from "lucide-react";
import type { AskDirectorResult, EvaluationTarget } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DirectorOpinionView } from "@/components/director/DirectorOpinionView";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAskDirectorStore } from "@/store/askDirectorStore";
import { useBooksStore } from "@/store/booksStore";

type TargetKind = EvaluationTarget["kind"];

function paragraphSlugOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

/** Global "What does the director think?" dialog for the book, a chapter or a scene. */
export function AskDirectorDialog() {
  const { t } = useTranslation();
  const request = useAskDirectorStore((state) => state.request);
  const close = useAskDirectorStore((state) => state.close);
  const markSaved = useAskDirectorStore((state) => state.markSaved);
  const structure = useBooksStore((state) => (request ? state.structures[request.bookId] : undefined));
  const [kind, setKind] = useState<TargetKind>("book");
  const [chapter, setChapter] = useState("");
  const [paragraph, setParagraph] = useState("");
  const [question, setQuestion] = useState("");
  const [save, setSave] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AskDirectorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!request) return;
    const target = request.target;
    setKind(target.kind);
    setChapter(target.kind === "book" ? "" : target.chapter);
    setParagraph(target.kind === "paragraph" ? target.paragraph : "");
    setQuestion("");
    setSave(true);
    setResult(null);
    setError(null);
  }, [request]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const chapters = structure?.chapters ?? [];
  const paragraphs = useMemo(() => chapters.find((entry) => entry.slug === chapter)?.paragraphs ?? [], [chapters, chapter]);
  const ready = kind === "book" || (kind === "chapter" && Boolean(chapter)) || (kind === "paragraph" && Boolean(chapter && paragraph));

  function onOpenChange(open: boolean) {
    if (open) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRunning(false);
    close();
  }

  async function ask() {
    if (!request || !ready) return;
    const target: EvaluationTarget = kind === "book" ? { kind } : kind === "chapter" ? { kind, chapter } : { kind, chapter, paragraph };
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const runtime = await loadAutopilotRuntime();
      const answer = await runtime.askDirector(request.bookId, { target, question: question.trim() || undefined, save, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(answer);
      if (answer.saved) markSaved();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const runtime = await loadAutopilotRuntime().catch(() => null);
      setError(runtime ? runtime.describeError(cause) : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRunning(false);
      }
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clapperboard className="h-5 w-5 text-primary" />{t("director.ask.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("director.ask.description")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <DirectorOpinionView opinion={result.opinion} />
            {result.saved && <p className="text-xs text-muted-foreground">{t("director.opinion.saved", { path: result.path })}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setResult(null)}><RotateCcw className="h-4 w-4" />{t("director.ask.again")}</Button>
              {request && (
                <Button asChild variant="ghost">
                  <Link to={`/app/books/${encodeURIComponent(request.bookId)}/director`} onClick={() => onOpenChange(false)}>{t("director.ask.openPage")}</Link>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t("director.ask.about")}</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as TargetKind)} disabled={running}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="book">{t("director.ask.target.book")}</SelectItem>
                    <SelectItem value="chapter" disabled={!chapters.length}>{t("director.ask.target.chapter")}</SelectItem>
                    <SelectItem value="paragraph" disabled={!chapters.length}>{t("director.ask.target.paragraph")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {kind !== "book" && (
                <div className="space-y-1.5">
                  <Label>{t("director.ask.target.chapter")}</Label>
                  <Select value={chapter || undefined} onValueChange={(value) => { setChapter(value); setParagraph(""); }} disabled={running}>
                    <SelectTrigger><SelectValue placeholder={t("director.ask.chooseChapter")} /></SelectTrigger>
                    <SelectContent>
                      {chapters.map((entry) => <SelectItem key={entry.slug} value={entry.slug}>{entry.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {kind === "paragraph" && (
                <div className="space-y-1.5">
                  <Label>{t("director.ask.target.paragraph")}</Label>
                  <Select value={paragraph || undefined} onValueChange={setParagraph} disabled={running || !paragraphs.length}>
                    <SelectTrigger><SelectValue placeholder={t("director.ask.chooseParagraph")} /></SelectTrigger>
                    <SelectContent>
                      {paragraphs.map((entry) => <SelectItem key={entry.path} value={paragraphSlugOf(entry.path)}>{entry.number}. {entry.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ask-director-question">{t("director.ask.question")}</Label>
              <Textarea
                id="ask-director-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={t("director.ask.questionPlaceholder")}
                rows={3}
                disabled={running}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void ask();
                  }
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={save} onCheckedChange={setSave} disabled={running} />
              {t("director.ask.save")}
            </label>
            {error && <Alert variant="destructive"><AlertDescription>{t("director.ask.failed")}: {error}</AlertDescription></Alert>}
            <div className="flex items-center gap-3">
              <Button onClick={() => void ask()} disabled={!ready || running}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
                {running ? t("director.ask.running") : t("director.ask.run")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
