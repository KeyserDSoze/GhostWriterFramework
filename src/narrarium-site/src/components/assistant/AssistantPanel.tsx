import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  GitBranch,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Paperclip,
  Send,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  createEmptyAssistantSession,
  useAssistantStore,
  type AssistantAttachment,
  type AssistantFileUpdate,
} from "@/assistant/store";
import { applyParagraphRewrite, compactAssistantSession, runAssistantPrompt } from "@/assistant/service";
import { loadWriterContext, parseAppRoute } from "@/assistant/context";
import { deleteAssistantSession, listAssistantSessions, loadAssistantSession, saveAssistantSession } from "@/assistant/chatCloud";
import { parseAttachment } from "@/assistant/attachments";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useAuthStore } from "@/store/authStore";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveBookToken } from "@/types/settings";
import {
  compareBranches,
  createBranchFromBase,
  createFile,
  deleteFile,
  readFileWithSha,
  revertFileToRef,
  updateFile,
  type BranchDiffFile,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { speakText, type SpeechController } from "@/assistant/speech";

const ATTACHMENT_TARGETS = [
  { value: "paragraph", label: "Import as paragraph" },
  { value: "chapter", label: "Import as chapter" },
  { value: "note", label: "Import as note" },
  { value: "character", label: "Import as character" },
  { value: "location", label: "Import as location" },
  { value: "faction", label: "Import as faction" },
  { value: "item", label: "Import as item" },
  { value: "secret", label: "Import as secret" },
  { value: "timeline", label: "Import as timeline event" },
  { value: "script", label: "Import as script" },
  { value: "draft", label: "Import as draft" },
] as const;

type AttachmentTarget = (typeof ATTACHMENT_TARGETS)[number]["value"];

export function AssistantPanel() {
  const { t } = useTranslation();
  const location = useLocation();
  const route = useMemo(() => parseAppRoute(location.pathname), [location.pathname]);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const { branch } = useWorkingBranch(bookId);
  const { settings, patchSettings } = useSettingsStore();
  const { structures, workingBranches, clearBook } = useBooksStore();
  const { save } = useSettings();
  const { user, accessToken } = useAuthStore();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    open,
    setOpen,
    sessions,
    setSessions,
    currentSession,
    setCurrentSession,
    updateCurrentSession,
    busy,
    setBusy,
  } = useAssistantStore();

  const [draft, setDraft] = useState("");
  const [contextLabel, setContextLabel] = useState("Narrarium");
  const [contextSummary, setContextSummary] = useState("");
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [availableCount, setAvailableCount] = useState(0);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [diffFiles, setDiffFiles] = useState<BranchDiffFile[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [attachmentTarget, setAttachmentTarget] = useState<AttachmentTarget>("paragraph");
  const [fullScreen, setFullScreen] = useState(false);
  const [listening, setListening] = useState(false);
  const [autoSend, setAutoSend] = useState(false);
  const [speechController, setSpeechController] = useState<SpeechController | null>(null);

  useEffect(() => {
    let active = true;
    void loadWriterContext(location.pathname, settings, settings.books, structures, workingBranches).then((ctx) => {
      if (!active) return;
      setContextLabel(ctx.title);
      setContextSummary(ctx.summary);
      setContextFiles(ctx.loadedFilePaths);
      setAvailableCount(ctx.availableFiles.length);
    });
    return () => {
      active = false;
    };
  }, [location.pathname, settings, structures, workingBranches]);

  useEffect(() => {
    if (!open || !user || !accessToken) return;
    setLoadingSessions(true);
    void listAssistantSessions(user.provider, accessToken)
      .then((items) => setSessions(items))
      .catch((err) => toast({ title: "Failed to load chats", description: String(err), variant: "destructive" }))
      .finally(() => setLoadingSessions(false));
  }, [open, user, accessToken, setSessions, toast]);

  useEffect(() => {
    if (!user || !accessToken || !currentSession) return;
    const timer = setTimeout(() => {
      void saveAssistantSession(user.provider, accessToken, currentSession)
        .then((fileId) => {
          const savedSession = currentSession.fileId === fileId ? currentSession : { ...currentSession, fileId };
          if (currentSession.fileId !== fileId) setCurrentSession(savedSession);
          setSessions([
            {
              id: savedSession.id,
              fileId,
              title: savedSession.title,
              contextTitle: savedSession.contextTitle,
              updatedAt: savedSession.updatedAt,
            },
            ...sessions.filter((session) => session.fileId !== fileId && session.id !== savedSession.id),
          ]);
        })
        .catch((err) => toast({ title: "Failed to save chat", description: String(err), variant: "destructive" }));
    }, 300);
    return () => clearTimeout(timer);
  }, [currentSession, user, accessToken, setCurrentSession, setSessions, sessions, toast]);

  useEffect(() => {
    if (!currentSession || busy || currentSession.messages.length <= 12) return;
    let active = true;
    setBusy(true);
    void compactAssistantSession({ session: currentSession, settings })
      .then((compacted) => { if (active) setCurrentSession(compacted); })
      .catch(() => undefined)
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [currentSession, settings, setCurrentSession, busy, setBusy]);

  function ensureSession() {
    if (currentSession) return currentSession;
    const next = createEmptyAssistantSession(contextLabel);
    setCurrentSession(next);
    return next;
  }

  function newChat() {
    setCurrentSession(createEmptyAssistantSession(contextLabel));
    setOpen(true);
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    const session = ensureSession();
    setBusy(true);
    try {
      const parsed: AssistantAttachment[] = [];
      for (const file of Array.from(files)) parsed.push(await parseAttachment(file));
      updateCurrentSession((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        attachments: [...current.attachments, ...parsed],
      }));
      if (!session.messages.length) setOpen(true);
    } catch (err) {
      toast({ title: "Attachment failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(id: string) {
    updateCurrentSession((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
  }

  function appendDraftText(text: string) {
    setDraft((current) => current ? current + " " + text : text);
  }

  function startSpeechToText() {
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast({ title: "STT non disponibile", description: "Il browser non supporta SpeechRecognition.", variant: "destructive" });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = settings.ui.language === "it" ? "it-IT" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    setListening(true);
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results).map((result: any) => result[0]?.transcript ?? "").join(" ").trim();
      if (transcript) {
        if (autoSend) void sendPrompt(transcript);
        else appendDraftText(transcript);
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.start();
  }

  function stopReading() {
    speechController?.stop();
    setSpeechController(null);
  }

  async function readText(text: string) {
    stopReading();
    try {
      const controller = await speakText(text, settings);
      setSpeechController(controller);
    } catch (err) {
      toast({ title: "TTS failed", description: String(err), variant: "destructive" });
    }
  }

  function readCurrentContext() {
    const text = [contextLabel, contextSummary, ...contextFiles].join("\n");
    void readText(text);
  }
  async function sendPrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    const routeContext = await loadWriterContext(location.pathname, settings, settings.books, structures, workingBranches);
    const book = routeContext.book;
    const token = book ? resolveBookToken(book, settings) : "";
    const session = ensureSession();
    const userMessage = { id: crypto.randomUUID(), role: "user" as const, text: trimmed };
    updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, userMessage] }));
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
        history: [...session.messages, userMessage],
        compactSummary: session.compactSummary,
        compactedMessageCount: session.compactedMessageCount,
        attachments: session.attachments,
      });
      updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, reply] }));
      setOpen(true);
    } catch (err) {
      updateCurrentSession((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [...current.messages, { id: crypto.randomUUID(), role: "assistant", text: err instanceof Error ? err.message : "Assistant request failed." }],
      }));
    } finally {
      setBusy(false);
    }
  }

  function buildAttachmentImportPrompt(): string {
    const label = ATTACHMENT_TARGETS.find((entry) => entry.value === attachmentTarget)?.label ?? attachmentTarget;
    return `Use the attached files as source material and ${label.toLowerCase()} in the current book context.`;
  }

  async function handleImportAttachments() {
    if (!(currentSession?.attachments.length ?? 0)) {
      toast({ title: "No attachments", description: "Attach at least one file first." });
      return;
    }
    await sendPrompt(buildAttachmentImportPrompt());
  }

  async function openSession(fileId: string) {
    if (!user || !accessToken) return;
    setBusy(true);
    try {
      const session = await loadAssistantSession(user.provider, accessToken, fileId);
      setCurrentSession(session);
      setOpen(true);
    } catch (err) {
      toast({ title: "Failed to open chat", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentSession() {
    if (!user || !accessToken || !currentSession?.fileId) return;
    try {
      await deleteAssistantSession(user.provider, accessToken, currentSession.fileId);
      setSessions(sessions.filter((session) => session.fileId !== currentSession.fileId));
      setCurrentSession(null);
    } catch (err) {
      toast({ title: "Failed to delete chat", description: String(err), variant: "destructive" });
    }
  }

  async function applyRewrite(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "apply-paragraph-rewrite" || !bookId) return;
    const action = message.action;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    setBusy(true);
    try {
      await applyParagraphRewrite({ action, book, branch, token });
      toast({ title: "Paragraph updated" });
      window.location.reload();
    } catch (err) {
      toast({ title: "Apply rewrite failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function applySelectedFileUpdates(messageIndex: number, selectedPaths?: string[]) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "apply-file-updates") return;
    const action = message.action;
    const updates = selectedPaths?.length
      ? action.updates.filter((update) => selectedPaths.includes(update.path))
      : action.updates;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token || updates.length === 0) return;
    setBusy(true);
    try {
      const undoUpdates: AssistantFileUpdate[] = [];
      for (const update of updates) {
        const existing = await readFileWithSha(token, book.owner, book.repo, branch, update.path).catch(() => null);
        undoUpdates.push({ ...update, previousContent: existing?.content ?? null });
        if (existing) await updateFile(token, book.owner, book.repo, branch, update.path, existing.sha, update.content, `Update ${update.path}`);
        else await createFile(token, book.owner, book.repo, branch, update.path, update.content, `Add ${update.path}`);
      }
      useAssistantStore.getState().updateMessage(message.id, {
        text: `${message.text}\n\nApplied ${updates.length} file change${updates.length === 1 ? "" : "s"}. You can undo this assistant change if needed.`,
        action: { kind: "undo-file-updates", bookId: action.bookId, updates: undoUpdates },
      });
      toast({ title: "File updates applied" });
    } catch (err) {
      toast({ title: "Apply file updates failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function applyBranchSwitch(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "switch-book-branch") return;
    const action = message.action;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    setBusy(true);
    try {
      if (action.createIfMissing) {
        await createBranchFromBase(token, book.owner, book.repo, action.baseBranch ?? "main", action.branchName);
      }
      patchSettings({
        books: settings.books.map((entry) =>
          entry.id === book.id ? { ...entry, activeBranch: action.branchName } : entry,
        ),
      });
      await save();
      clearBook(book.id);
      toast({ title: `Switched to branch ${action.branchName}` });
      window.location.reload();
    } catch (err) {
      toast({ title: "Branch switch failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function undoFileUpdates(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "undo-file-updates") return;
    const action = message.action;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    setBusy(true);
    try {
      for (const update of action.updates) {
        const current = await readFileWithSha(token, book.owner, book.repo, branch, update.path).catch(() => null);
        if (update.previousContent == null) {
          if (current) await deleteFile(token, book.owner, book.repo, branch, update.path, current.sha, `Undo add ${update.path}`);
        } else if (current) {
          await updateFile(token, book.owner, book.repo, branch, update.path, current.sha, update.previousContent, `Undo update ${update.path}`);
        } else {
          await createFile(token, book.owner, book.repo, branch, update.path, update.previousContent, `Undo delete ${update.path}`);
        }
      }
      useAssistantStore.getState().updateMessage(message.id, { action: undefined, text: `${message.text}\n\nUndo applied.` });
      toast({ title: "Undo applied" });
    } catch (err) {
      toast({ title: "Undo failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function loadBranchDiff() {
    if (!bookId) return;
    const book = settings.books.find((entry) => entry.id === bookId);
    const structure = structures[bookId];
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !structure || !token) return;
    setLoadingDiff(true);
    try {
      const files = await compareBranches(token, book.owner, book.repo, structure.defaultBranch, branch);
      setDiffFiles(files);
      setSyncOpen(true);
    } catch (err) {
      toast({ title: "Failed to load branch diff", description: String(err), variant: "destructive" });
    } finally {
      setLoadingDiff(false);
    }
  }

  async function revertDiffFile(file: BranchDiffFile) {
    if (!bookId) return;
    const book = settings.books.find((entry) => entry.id === bookId);
    const structure = structures[bookId];
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !structure || !token) return;
    setBusy(true);
    try {
      await revertFileToRef(token, book.owner, book.repo, branch, file.filename, structure.defaultBranch);
      toast({ title: `Reverted ${file.filename}` });
      await loadBranchDiff();
    } catch (err) {
      toast({ title: "Revert failed", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const syncPanel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <p className="font-semibold">Branch diff / Sync</p>
          <p className="text-xs text-muted-foreground">Compare working branch with default branch</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setSyncOpen(false)}>Close</Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-4">
        {diffFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No branch differences found.</p>
        ) : (
          <div className="space-y-3">
            {diffFiles.map((file) => (
              <div key={file.filename} className="rounded-xl border bg-background p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-xs">{file.filename}</p>
                    <p className="text-xs text-muted-foreground">{file.status} · +{file.additions} -{file.deletions}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void revertDiffFile(file)} disabled={busy}>Revert file</Button>
                </div>
                {file.patch && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">{file.patch}</pre>}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );

  const panel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <p className="font-semibold">{t("assistant.title")}</p>
          </div>
          <p className="text-xs text-muted-foreground">{contextLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={newChat}>{t("assistant.new")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setFullScreen((value) => !value)}>{fullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("assistant.close")}</Button>
        </div>
      </div>

      <div className="border-b px-4 py-3 space-y-3">
        <div className="text-xs text-muted-foreground">{contextSummary || "Context follows the current route and repository files."}</div>
        <details className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">{t("assistant.contextInspector")}</summary>
          <div className="mt-2 space-y-2">
            <p>{availableCount} {t("assistant.filesInManifest")}.</p>
            <p>{t("assistant.loadedNow")}:</p>
            <div className="space-y-1">
              {contextFiles.length ? contextFiles.map((path) => <div key={path} className="font-mono">{path}</div>) : <div>none</div>}
            </div>
          </div>
        </details>
        <div className="flex items-center gap-2">
          <Select value={currentSession?.fileId ?? currentSession?.id ?? ""} onValueChange={(value) => { if (value === "__new__") newChat(); else void openSession(value); }}>
            <SelectTrigger className="h-8 flex-1"><SelectValue placeholder={loadingSessions ? t("assistant.loadingChats") : t("assistant.savedChat")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__new__">{t("assistant.new")}</SelectItem>
              {sessions.map((session) => <SelectItem key={session.fileId ?? session.id} value={session.fileId ?? session.id}>{session.title}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void deleteCurrentSession()} disabled={!currentSession?.fileId}><Trash2 className="h-4 w-4" /></Button>
        </div>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void attachFiles(event.target.files)} accept=".pdf,.docx,.md,.markdown,.txt,image/png,image/jpeg,.jpg,.jpeg" />
        <div className="flex flex-wrap gap-2">
          {(currentSession?.attachments ?? []).map((attachment) => (
            <Badge key={attachment.id} variant="secondary" className="gap-1 pr-1">
              {attachment.name}
              <button type="button" onClick={() => removeAttachment(attachment.id)} className="rounded p-0.5 hover:bg-black/10"><X className="h-3 w-3" /></button>
            </Badge>
          ))}
        </div>
        {currentSession?.compactSummary && <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap"><p className="mb-1 font-medium text-foreground">Compaction summary</p>{currentSession.compactSummary}</div>}
      </div>

      <div className="flex flex-wrap gap-2 border-b px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a concise summary of where I am and what matters next.")}><Sparkles className="mr-1 h-4 w-4" />{t("assistant.summary")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Review what I am looking at and tell me strengths, risks, and next actions.")}>{t("assistant.review")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Write or refresh the resume for the current chapter.")}>{t("assistant.resume")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Write or refresh the evaluation for what I am looking at.")}>{t("assistant.evaluation")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Update plot.md for the current book.")}>{t("assistant.plot")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a writer note from the current context and save it.")}>{t("assistant.saveNote")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Search the current book for relevant characters, paragraphs, or canon keywords.")}>{t("assistant.search")}</Button>
        <Button variant="outline" size="sm" onClick={() => void loadBranchDiff()} disabled={loadingDiff}>{t("assistant.syncDiff")}</Button><Button variant="outline" size="sm" onClick={readCurrentContext}>{speechController ? t("assistant.stopReading") : t("assistant.readContext")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Improve the current paragraph while preserving all facts.")}><Wand2 className="mr-1 h-4 w-4" />{t("assistant.fixParagraph")}</Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="space-y-3">
          {currentSession?.messages.length ? null : <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">{t("assistant.empty")}</div>}
          {(currentSession?.messages ?? []).map((message, index) => (
            <div key={message.id} className={message.role === "user" ? "ml-8" : "mr-8"}>
              <div className={message.role === "user" ? "rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground" : "rounded-2xl border bg-background px-4 py-3 text-sm whitespace-pre-wrap"}>{message.text}</div>
              {message.action?.kind === "switch-book-branch" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">Branch action ready</Badge>
                  <Button size="sm" onClick={() => void applyBranchSwitch(index)} disabled={busy}><GitBranch className="mr-1 h-4 w-4" />Apply branch</Button>
                </div>
              )}
              {message.action?.kind === "apply-file-updates" && (
                <div className="mt-2 rounded-xl border bg-muted/30 p-3 text-xs">
                  <p className="mb-2 font-medium">Proposed multi-file changes</p>
                  <div className="space-y-2">
                    {message.action.updates.map((update) => (
                      <details key={update.path} className="rounded border bg-background p-2">
                        <summary className="cursor-pointer font-mono">{update.path}</summary>
                        {update.reason && <p className="mt-2 text-muted-foreground">{update.reason}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => void applySelectedFileUpdates(index, [update.path])} disabled={busy}>Apply only this file</Button>
                        </div>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{update.content}</pre>
                      </details>
                    ))}
                  </div>
                  <Button className="mt-2" size="sm" onClick={() => void applySelectedFileUpdates(index)} disabled={busy}>Apply all file updates</Button>
                </div>
              )}
              {message.action?.kind === "undo-file-updates" && <div className="mt-2 flex items-center gap-2"><Badge variant="secondary">Assistant changes applied</Badge><Button size="sm" variant="outline" onClick={() => void undoFileUpdates(index)} disabled={busy}>Undo assistant changes</Button></div>}
              {message.action?.kind === "apply-paragraph-rewrite" && <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="secondary">Paragraph rewrite ready</Badge><Button size="sm" onClick={() => void applyRewrite(index)} disabled={busy}>Apply to paragraph</Button><Button asChild size="sm" variant="outline"><Link to={`/app/books/${message.action.bookId}/chapters/${message.action.chapterSlug}`}>Open chapter</Link></Button></div>}
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("assistant.thinking")}</div>}
        </div>
      </ScrollArea>

      <div className="border-t p-4">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void sendPrompt(draft); }}>
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("assistant.placeholder")} className="min-h-[100px] resize-none" />
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Select value={attachmentTarget} onValueChange={(value) => setAttachmentTarget(value as AttachmentTarget)}>
                <SelectTrigger className="h-9 w-full sm:w-[220px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ATTACHMENT_TARGETS.map((target) => <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleImportAttachments()} disabled={busy || !(currentSession?.attachments.length)}>
                {t("assistant.importAttachments")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={listening ? undefined : startSpeechToText} disabled={busy || listening}>
                  {listening ? <Square className="mr-1 h-4 w-4" /> : <Mic className="mr-1 h-4 w-4" />}
                  {listening ? t("assistant.stopMic") : t("assistant.microphone")}
                </Button>
                <Button type="button" variant={autoSend ? "default" : "outline"} size="sm" onClick={() => setAutoSend((value) => !value)}>
                  {t("assistant.autoSend")}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft("")}>{t("assistant.clear")}</Button>
                <Button type="submit" disabled={!draft.trim() || busy}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}{t("assistant.send")}</Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="mr-1 h-4 w-4" />{t("assistant.attachFiles")}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );

  return (
    <>
      <Button type="button" className="fixed bottom-4 right-4 z-40 rounded-full shadow-lg lg:bottom-6 lg:right-6" onClick={() => setOpen(true)}>
        <Bot className="mr-2 h-4 w-4" />Copilot
      </Button>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent className="left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[920px]">{syncPanel}</DialogContent></Dialog>
      <Dialog open={open} onOpenChange={setOpen}><DialogContent className={fullScreen ? "left-1/2 top-1/2 h-[96dvh] max-h-[96dvh] w-[98vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0" : "left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[720px] lg:right-6 lg:left-auto lg:top-auto lg:bottom-6 lg:h-[80dvh] lg:w-[420px] lg:max-w-[420px] lg:translate-x-0 lg:translate-y-0"}>{panel}</DialogContent></Dialog>
    </>
  );
}
