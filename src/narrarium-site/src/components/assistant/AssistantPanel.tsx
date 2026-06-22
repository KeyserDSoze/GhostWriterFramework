import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bot, Loader2, Send, Sparkles, Wand2 } from "lucide-react";
import { useAssistantStore } from "@/assistant/store";
import { applyParagraphRewrite, runAssistantPrompt } from "@/assistant/service";
import { loadWriterContext, parseAppRoute } from "@/assistant/context";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { resolveBookToken } from "@/types/settings";
import { useWorkingBranch } from "@/github/useWorkingBranch";

export function AssistantPanel() {
  const location = useLocation();
  const route = useMemo(() => parseAppRoute(location.pathname), [location.pathname]);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const { branch } = useWorkingBranch(bookId);
  const { settings } = useSettingsStore();
  const { structures, workingBranches } = useBooksStore();
  const { toast } = useToast();
  const { open, setOpen, messages, addMessage, clear, busy, setBusy } = useAssistantStore();
  const [draft, setDraft] = useState("");
  const [contextLabel, setContextLabel] = useState("Narrarium");
  const [contextSummary, setContextSummary] = useState("");

  useEffect(() => {
    let active = true;
    const books = settings.books;
    void loadWriterContext(location.pathname, settings, books, structures).then((ctx) => {
      if (!active) return;
      setContextLabel(ctx.title);
      setContextSummary(ctx.summary);
    });
    return () => {
      active = false;
    };
  }, [location.pathname, settings, structures, workingBranches]);

  async function sendPrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    const books = settings.books;
    const routeContext = await loadWriterContext(location.pathname, settings, books, structures);
    const book = routeContext.book;
    const token = book ? resolveBookToken(book, settings) : "";
    addMessage({ id: crypto.randomUUID(), role: "user", text: trimmed });
    setDraft("");
    setBusy(true);
    try {
      const reply = await runAssistantPrompt({
        prompt: trimmed,
        context: routeContext,
        settings,
        book,
        branch,
        token,
      });
      addMessage(reply);
      setOpen(true);
    } catch (err) {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: err instanceof Error ? err.message : "Assistant request failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function applyRewrite(messageIndex: number) {
    const message = messages[messageIndex];
    if (!message?.action || !bookId) return;
    const book = settings.books.find((entry) => entry.id === message.action?.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) {
      toast({ title: "Missing token", description: "No GitHub token available for this book.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await applyParagraphRewrite({ action: message.action, book, branch, token });
      toast({ title: "Paragraph updated" });
      window.location.reload();
    } catch (err) {
      toast({ title: "Apply rewrite failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const panel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <p className="font-semibold">Writer Copilot</p>
          </div>
          <p className="text-xs text-muted-foreground">{contextLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={clear}>Clear</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </div>

      <div className="border-b px-4 py-3 text-xs text-muted-foreground">
        {contextSummary || "Context follows the current route and repository files."}
      </div>

      <div className="flex flex-wrap gap-2 border-b px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a concise summary of where I am and what matters next.")}>
          <Sparkles className="mr-1 h-4 w-4" />Summary
        </Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Review what I am looking at and tell me strengths, risks, and next actions.")}>
          Review
        </Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a writer note from the current context and save it.")}>
          Save note
        </Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Improve the current paragraph while preserving all facts.")}>
          <Wand2 className="mr-1 h-4 w-4" />Fix paragraph
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="space-y-3">
          {messages.length === 0 && (
            <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
              Ask for a summary, a review, a saved note, or a paragraph rewrite. The assistant uses the current route and loads the repo files it needs.
            </div>
          )}
          {messages.map((message, index) => (
            <div key={message.id} className={message.role === "user" ? "ml-8" : "mr-8"}>
              <div className={message.role === "user" ? "rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground" : "rounded-2xl border bg-background px-4 py-3 text-sm whitespace-pre-wrap"}>
                {message.text}
              </div>
              {message.action?.kind === "apply-paragraph-rewrite" && (
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant="secondary">Paragraph rewrite ready</Badge>
                  <Button size="sm" onClick={() => void applyRewrite(index)} disabled={busy}>Apply to paragraph</Button>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/app/books/${message.action.bookId}/chapters/${message.action.chapterSlug}`}>Open chapter</Link>
                  </Button>
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking…
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="border-t p-4">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt(draft);
          }}
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the assistant to summarize, review, create a note, or improve what you are editing…"
            className="min-h-[100px] resize-none"
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={!draft.trim() || busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
              Send
            </Button>
          </div>
        </form>
      </div>
    </div>
  );

  return (
    <>
      <Button
        type="button"
        className="fixed bottom-4 right-4 z-40 rounded-full shadow-lg lg:bottom-6 lg:right-6"
        onClick={() => setOpen(true)}
      >
        <Bot className="mr-2 h-4 w-4" />
        Copilot
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[720px] lg:right-6 lg:left-auto lg:top-auto lg:h-[80dvh] lg:w-[420px] lg:max-w-[420px] lg:translate-x-0 lg:translate-y-0 lg:bottom-6">
          {panel}
        </DialogContent>
      </Dialog>
    </>
  );
}
