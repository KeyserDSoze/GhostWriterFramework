import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  Ghost,
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
  type AssistantMessage,
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
import { speakText, transcribeAudio, type SpeechController } from "@/assistant/speech";
import { FileDiff, PatchDiff } from "@/components/diff/DiffView";

const ATTACHMENT_TARGETS = [
  { value: "paragraph", labelKey: "assistant.importParagraph" },
  { value: "chapter", labelKey: "assistant.importChapter" },
  { value: "note", labelKey: "assistant.importNote" },
  { value: "character", labelKey: "assistant.importCharacter" },
  { value: "location", labelKey: "assistant.importLocation" },
  { value: "faction", labelKey: "assistant.importFaction" },
  { value: "item", labelKey: "assistant.importItem" },
  { value: "secret", labelKey: "assistant.importSecret" },
  { value: "timeline", labelKey: "assistant.importTimeline" },
  { value: "script", labelKey: "assistant.importScript" },
  { value: "draft", labelKey: "assistant.importDraft" },
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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const speechRecognitionTranscriptRef = useRef("");
  const speechRecognitionSentRef = useRef(false);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceModeRef = useRef(false);
  const liveAbortRef = useRef<AbortController | null>(null);
  const waitingToneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState("");
  const [diffMode, setDiffMode] = useState<Record<string, boolean>>({});
  const [previousContents, setPreviousContents] = useState<Record<string, string>>({});
  const [loadingDiffPath, setLoadingDiffPath] = useState<string | null>(null);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

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
      .catch((err) => toast({ title: t("assistant.toastLoadChatsFailed"), description: String(err), variant: "destructive" }))
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
        .catch((err) => toast({ title: t("assistant.toastSaveChatFailed"), description: String(err), variant: "destructive" }));
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

  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
      if (waitingToneTimerRef.current) clearInterval(waitingToneTimerRef.current);
      liveAbortRef.current?.abort();
      if (audioContextRef.current) void audioContextRef.current.close().catch(() => undefined);
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    };
  }, []);

  function playWaitTick() {
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.value = 0.035;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      window.setTimeout(() => {
        oscillator.stop();
        void context.close().catch(() => undefined);
      }, 120);
    } catch {
      // Audio cues are best-effort only.
    }
  }

  function startWaitingTone() {
    stopWaitingTone();
    playWaitTick();
    waitingToneTimerRef.current = setInterval(playWaitTick, 1500);
  }

  function stopWaitingTone() {
    if (waitingToneTimerRef.current) {
      clearInterval(waitingToneTimerRef.current);
      waitingToneTimerRef.current = null;
    }
  }

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
      toast({ title: t("assistant.toastAttachFailed"), description: String(err), variant: "destructive" });
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

  function stopSilenceMonitor() {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  }

  function monitorSilence(stream: MediaStream) {
    const AudioContextCtor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context: AudioContext = new AudioContextCtor();
    audioContextRef.current = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const SILENCE_THRESHOLD = 0.012;
    const SILENCE_MS = 1800;
    let hasSpoken = false;
    let silenceStart = 0;

    silenceTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (const value of buffer) {
        const normalized = (value - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const now = Date.now();
      if (rms >= SILENCE_THRESHOLD) {
        hasSpoken = true;
        silenceStart = now;
      } else if (hasSpoken) {
        if (!silenceStart) silenceStart = now;
        if (now - silenceStart >= SILENCE_MS && mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }
    }, 150);
  }

  async function startSpeechToText() {
    if (listening && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      return;
    }

    if (settings.speech.sttProvider === "ai") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];
        mediaRecorderRef.current = recorder;
        setListening(true);
        if (voiceModeRef.current) setVoiceStatus("listening");
        monitorSilence(stream);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          stopSilenceMonitor();
          stream.getTracks().forEach((track) => track.stop());
          setListening(false);
          mediaRecorderRef.current = null;
          if (voiceModeRef.current) setVoiceStatus("thinking");
          try {
            const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
            const transcript = (await transcribeAudio(blob, settings)).trim();
            if (transcript) {
              if (voiceModeRef.current) void handleVoiceTranscript(transcript);
              else if (autoSend) void sendPrompt(transcript);
              else appendDraftText(transcript);
            } else if (voiceModeRef.current) {
              setVoiceStatus("idle");
            }
          } catch (err) {
            if (voiceModeRef.current) setVoiceStatus("idle");
            toast({ title: t("assistant.toastSttFailed"), description: String(err), variant: "destructive" });
          }
        };
        recorder.start();
      } catch (err) {
        stopSilenceMonitor();
        setListening(false);
        toast({ title: t("assistant.toastMicUnavailable"), description: String(err), variant: "destructive" });
      }
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast({ title: t("assistant.toastSttUnavailable"), description: t("assistant.sttBrowserUnsupported"), variant: "destructive" });
      return;
    }
    const recognition = new SpeechRecognition();
    speechRecognitionRef.current = recognition;
    speechRecognitionTranscriptRef.current = "";
    speechRecognitionSentRef.current = false;
    recognition.lang = settings.ui.language === "it" ? "it-IT" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = voiceModeRef.current;
    setListening(true);
    if (voiceModeRef.current) setVoiceStatus("listening");
    recognition.onresult = (event: any) => {
      let hasFinal = false;
      const transcript = Array.from(event.results).map((result: any) => {
        if (result.isFinal) hasFinal = true;
        return result[0]?.transcript ?? "";
      }).join(" ").trim();
      if (transcript) speechRecognitionTranscriptRef.current = transcript;
      if (transcript) {
        if (voiceModeRef.current && hasFinal && !speechRecognitionSentRef.current) {
          speechRecognitionSentRef.current = true;
          try { recognition.stop(); } catch {}
          void handleVoiceTranscript(transcript);
        }
        else if (autoSend) void sendPrompt(transcript);
        else if (!voiceModeRef.current) appendDraftText(transcript);
      }
    };
    recognition.onerror = () => {
      speechRecognitionRef.current = null;
      speechRecognitionTranscriptRef.current = "";
      setListening(false);
      if (voiceModeRef.current) setVoiceStatus("idle");
    };
    recognition.onend = () => {
      speechRecognitionRef.current = null;
      setListening(false);
      const transcript = speechRecognitionTranscriptRef.current.trim();
      if (voiceModeRef.current && transcript && !speechRecognitionSentRef.current) {
        speechRecognitionSentRef.current = true;
        void handleVoiceTranscript(transcript);
        return;
      }
      if (voiceModeRef.current) setVoiceStatus("idle");
    };
    recognition.start();
  }

  function stopReading() {
    speechController?.stop();
    setSpeechController(null);
  }

  async function readText(text: string): Promise<SpeechController | null> {
    stopReading();
    try {
      const controller = await speakText(text, settings);
      setSpeechController(controller);
      void controller.done.finally(() => setSpeechController((current) => current === controller ? null : current));
      return controller;
    } catch (err) {
      toast({ title: t("assistant.toastTtsFailed"), description: String(err), variant: "destructive" });
      return null;
    }
  }

  function readCurrentContext() {
    const text = [contextLabel, contextSummary, ...contextFiles].join("\n");
    void readText(text);
  }
  async function handleVoiceTranscript(transcript: string) {
    setLastVoiceTranscript(transcript);
    setVoiceStatus("thinking");
    startWaitingTone();
    const abortController = new AbortController();
    liveAbortRef.current = abortController;
    const reply = await sendPrompt(transcript, { spokenMode: true, signal: abortController.signal });
    stopWaitingTone();
    if (abortController.signal.aborted) return;
    liveAbortRef.current = null;
    if (!voiceModeRef.current) return;
    if (reply?.text) {
      setVoiceStatus("speaking");
      const controller = await readText(reply.text);
      await controller?.done.catch(() => undefined);
    }
    if (voiceModeRef.current) setVoiceStatus("idle");
  }

  function toggleVoiceMode() {
    setVoiceMode((enabled) => {
      const next = !enabled;
      voiceModeRef.current = next;
      if (!next) {
        interruptLiveVoice();
        setVoiceStatus("idle");
      } else {
        setOpen(true);
        setVoiceStatus("idle");
      }
      return next;
    });
  }

  async function startVoiceTurn() {
    if (listening) {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      speechRecognitionRef.current?.stop?.();
      return;
    }
    if (voiceStatus === "thinking" || voiceStatus === "speaking") {
      interruptLiveVoice();
      return;
    }
    if (!voiceModeRef.current) {
      setVoiceMode(true);
      voiceModeRef.current = true;
    }
    await startSpeechToText();
  }

  function interruptLiveVoice() {
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    stopWaitingTone();
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    speechRecognitionRef.current?.stop?.();
    speechRecognitionRef.current = null;
    stopReading();
    setListening(false);
    setVoiceStatus("idle");
  }

  async function sendPrompt(prompt: string, options?: { spokenMode?: boolean; signal?: AbortSignal }): Promise<AssistantMessage | null> {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return null;
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
        spokenMode: options?.spokenMode,
        signal: options?.signal,
      });
      updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, reply] }));
      setOpen(true);
      return reply;
    } catch (err) {
      if (options?.signal?.aborted) return null;
      const errorMessage = { id: crypto.randomUUID(), role: "assistant" as const, text: err instanceof Error ? err.message : t("assistant.requestFailed") };
      updateCurrentSession((current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [...current.messages, errorMessage],
      }));
      return errorMessage;
    } finally {
      setBusy(false);
    }
  }

  function buildAttachmentImportPrompt(): string {
    const entry = ATTACHMENT_TARGETS.find((entry) => entry.value === attachmentTarget);
    const label = (entry ? t(entry.labelKey) : attachmentTarget).toLowerCase();
    return `Use the attached files as source material and ${label} in the current book context.`;
  }

  async function handleImportAttachments() {
    if (!(currentSession?.attachments.length ?? 0)) {
      toast({ title: t("assistant.toastNoAttachments"), description: t("assistant.attachFirst") });
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
      toast({ title: t("assistant.toastOpenChatFailed"), description: String(err), variant: "destructive" });
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
      toast({ title: t("assistant.toastDeleteChatFailed"), description: String(err), variant: "destructive" });
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
      toast({ title: t("assistant.toastParagraphUpdated") });
      window.location.reload();
    } catch (err) {
      toast({ title: t("assistant.toastRewriteFailed"), description: String(err), variant: "destructive" });
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
        text: `${message.text}\n\n${t("assistant.appliedFileChanges", { count: updates.length })}`,
        action: { kind: "undo-file-updates", bookId: action.bookId, updates: undoUpdates },
      });
      toast({ title: t("assistant.toastFileUpdatesApplied") });
    } catch (err) {
      toast({ title: t("assistant.toastFileUpdatesFailed"), description: String(err), variant: "destructive" });
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
      toast({ title: t("assistant.toastBranchSwitched", { branch: action.branchName }) });
      window.location.reload();
    } catch (err) {
      toast({ title: t("assistant.toastBranchSwitchFailed"), description: String(err), variant: "destructive" });
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
      useAssistantStore.getState().updateMessage(message.id, { action: undefined, text: `${message.text}\n\n${t("assistant.undoApplied")}` });
      toast({ title: t("assistant.toastUndoApplied") });
    } catch (err) {
      toast({ title: t("assistant.toastUndoFailed"), description: String(err), variant: "destructive" });
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
      toast({ title: t("assistant.toastBranchDiffFailed"), description: String(err), variant: "destructive" });
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
      toast({ title: t("assistant.toastReverted", { file: file.filename }) });
      await loadBranchDiff();
    } catch (err) {
      toast({ title: t("assistant.toastRevertFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleDiff(messageId: string, update: AssistantFileUpdate) {
    const key = `${messageId}::${update.path}`;
    if (diffMode[key]) {
      setDiffMode((current) => ({ ...current, [key]: false }));
      return;
    }
    if (previousContents[key] === undefined) {
      const book = bookId ? settings.books.find((entry) => entry.id === bookId) : undefined;
      const token = book ? resolveBookToken(book, settings) : "";
      if (book && token) {
        setLoadingDiffPath(key);
        try {
          const existing = await readFileWithSha(token, book.owner, book.repo, branch, update.path).catch(() => null);
          setPreviousContents((current) => ({ ...current, [key]: existing?.content ?? update.previousContent ?? "" }));
        } finally {
          setLoadingDiffPath(null);
        }
      } else {
        setPreviousContents((current) => ({ ...current, [key]: update.previousContent ?? "" }));
      }
    }
    setDiffMode((current) => ({ ...current, [key]: true }));
  }

  const syncPanel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <p className="font-semibold">{t("assistant.syncTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("assistant.syncSubtitle")}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setSyncOpen(false)}>{t("assistant.close")}</Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-4">
        {diffFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("assistant.noBranchDiff")}</p>
        ) : (
          <div className="space-y-3">
            {diffFiles.map((file) => (
              <div key={file.filename} className="rounded-xl border bg-background p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-xs">{file.filename}</p>
                    <p className="text-xs text-muted-foreground">{file.status} · +{file.additions} -{file.deletions}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void revertDiffFile(file)} disabled={busy}>{t("assistant.revertFile")}</Button>
                </div>
                {file.patch && <PatchDiff patch={file.patch} className="max-h-64" />}
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
          <Button variant={voiceMode ? "default" : "ghost"} size="sm" onClick={toggleVoiceMode}>{voiceMode ? t("assistant.liveOn") : t("assistant.liveVoice")}</Button>
          <Button variant="ghost" size="sm" onClick={newChat}>{t("assistant.new")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setFullScreen((value) => !value)}>{fullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("assistant.close")}</Button>
        </div>
      </div>

      <div className="border-b px-4 py-3 space-y-3">
        <div className="text-xs text-muted-foreground">{contextSummary || t("assistant.contextFollows")}</div>
        {voiceMode && (
          <div className="flex items-center gap-3 rounded-2xl border bg-primary/5 p-3">
            <div className={voiceStatus === "speaking" ? "flex h-12 w-12 animate-pulse items-center justify-center rounded-full bg-primary text-primary-foreground" : "flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground"}>
              <Bot className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("assistant.liveVoice")}</p>
              <p className="text-xs text-muted-foreground">{t(`assistant.voiceStatus.${voiceStatus}`)}</p>
            </div>
            <Button size="sm" onClick={() => void startVoiceTurn()} disabled={busy || voiceStatus === "speaking"}>
              {listening ? <Square className="mr-1 h-4 w-4" /> : <Mic className="mr-1 h-4 w-4" />}
              {listening ? t("assistant.stopMic") : t("assistant.talk")}
            </Button>
          </div>
        )}
        <details className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">{t("assistant.contextInspector")}</summary>
          <div className="mt-2 space-y-2">
            <p>{availableCount} {t("assistant.filesInManifest")}.</p>
            <p>{t("assistant.loadedNow")}:</p>
            <div className="space-y-1">
              {contextFiles.length ? contextFiles.map((path) => <div key={path} className="font-mono">{path}</div>) : <div>{t("assistant.none")}</div>}
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
        {currentSession?.compactSummary && <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap"><p className="mb-1 font-medium text-foreground">{t("assistant.compactionSummary")}</p>{currentSession.compactSummary}</div>}
      </div>

      <div className="flex flex-wrap gap-2 border-b px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a concise summary of where I am and what matters next.")}><Sparkles className="mr-1 h-4 w-4" />{t("assistant.summary")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Review what I am looking at and tell me strengths, risks, and next actions.")}>{t("assistant.review")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Write or refresh the resume for the current chapter.")}>{t("assistant.resume")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Write or refresh the evaluation for what I am looking at.")}>{t("assistant.evaluation")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Update plot.md for the current book.")}>{t("assistant.plot")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Create a writer note from the current context and save it.")}>{t("assistant.saveNote")}</Button>
        <Button variant="outline" size="sm" onClick={() => void sendPrompt("Search the current book for relevant characters, paragraphs, or canon keywords.")}>{t("assistant.search")}</Button>
        <Button variant="outline" size="sm" onClick={() => void loadBranchDiff()} disabled={loadingDiff}>{t("assistant.syncDiff")}</Button><Button variant="outline" size="sm" onClick={speechController ? stopReading : readCurrentContext}>{speechController ? t("assistant.stopReading") : t("assistant.readContext")}</Button>
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
                  <Badge variant="secondary">{t("assistant.branchActionReady")}</Badge>
                  <Button size="sm" onClick={() => void applyBranchSwitch(index)} disabled={busy}><GitBranch className="mr-1 h-4 w-4" />{t("assistant.applyBranch")}</Button>
                </div>
              )}
              {message.action?.kind === "apply-file-updates" && (
                <div className="mt-2 rounded-xl border bg-muted/30 p-3 text-xs">
                  <p className="mb-2 font-medium">{t("assistant.proposedChanges")}</p>
                  <div className="space-y-2">
                    {message.action.updates.map((update) => {
                      const diffKey = `${message.id}::${update.path}`;
                      const showDiff = diffMode[diffKey];
                      return (
                        <details key={update.path} className="rounded border bg-background p-2">
                          <summary className="cursor-pointer font-mono">{update.path}</summary>
                          {update.reason && <p className="mt-2 text-muted-foreground">{update.reason}</p>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => void toggleDiff(message.id, update)} disabled={loadingDiffPath === diffKey}>
                              {loadingDiffPath === diffKey ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                              {showDiff ? t("assistant.hideDiff") : t("assistant.showDiff")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void applySelectedFileUpdates(index, [update.path])} disabled={busy}>{t("assistant.applyThisFile")}</Button>
                          </div>
                          {showDiff ? (
                            <FileDiff previous={previousContents[diffKey] ?? ""} next={update.content} className="mt-2 max-h-64" />
                          ) : (
                            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{update.content}</pre>
                          )}
                        </details>
                      );
                    })}
                  </div>
                  <Button className="mt-2" size="sm" onClick={() => void applySelectedFileUpdates(index)} disabled={busy}>{t("assistant.applyAllFiles")}</Button>
                </div>
              )}
              {message.action?.kind === "undo-file-updates" && <div className="mt-2 flex items-center gap-2"><Badge variant="secondary">{t("assistant.changesApplied")}</Badge><Button size="sm" variant="outline" onClick={() => void undoFileUpdates(index)} disabled={busy}>{t("assistant.undoChanges")}</Button></div>}
              {message.action?.kind === "apply-paragraph-rewrite" && <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="secondary">{t("assistant.rewriteReady")}</Badge><Button size="sm" onClick={() => void applyRewrite(index)} disabled={busy}>{t("assistant.applyToParagraph")}</Button><Button asChild size="sm" variant="outline"><Link to={`/app/books/${message.action.bookId}/chapters/${message.action.chapterSlug}`}>{t("assistant.openChapter")}</Link></Button></div>}
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
                  {ATTACHMENT_TARGETS.map((target) => <SelectItem key={target.value} value={target.value}>{t(target.labelKey)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleImportAttachments()} disabled={busy || !(currentSession?.attachments.length)}>
                {t("assistant.importAttachments")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void startSpeechToText()} disabled={busy || voiceMode}>
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

  const liveVoicePanel = (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_20%,hsl(var(--primary)/0.18),transparent_34%),linear-gradient(180deg,hsl(var(--card)),hsl(var(--background)))]">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <p className="font-semibold">{t("assistant.liveVoice")}</p>
          <p className="text-xs text-muted-foreground">{contextLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { interruptLiveVoice(); voiceModeRef.current = false; setVoiceMode(false); }}>{t("assistant.backToChat")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("assistant.close")}</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6 py-8 text-center">
        <div className="relative">
          <div className={voiceStatus === "speaking" ? "absolute inset-0 animate-ping rounded-full bg-primary/20" : "absolute inset-0 rounded-full bg-primary/10"} />
          <div className="relative flex h-44 w-44 items-center justify-center rounded-full border bg-background/80 shadow-2xl backdrop-blur sm:h-56 sm:w-56">
            <Ghost className={voiceStatus === "listening" ? "h-24 w-24 animate-pulse text-primary sm:h-32 sm:w-32" : "h-24 w-24 text-primary sm:h-32 sm:w-32"} />
          </div>
        </div>

        <div className="max-w-lg space-y-2">
          <p className="text-2xl font-semibold tracking-tight">{voiceStatus === "idle" ? t("assistant.liveReady") : t(`assistant.voiceStatusTitle.${voiceStatus}`)}</p>
          <p className="text-sm leading-6 text-muted-foreground">{t(`assistant.voiceStatus.${voiceStatus}`)}</p>
          {lastVoiceTranscript && <p className="rounded-2xl border bg-background/70 px-4 py-3 text-sm text-muted-foreground">“{lastVoiceTranscript}”</p>}
        </div>

        <button
          type="button"
          onClick={() => void startVoiceTurn()}
          className={voiceStatus === "idle" ? "flex h-36 w-36 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl transition hover:scale-105 active:scale-95 sm:h-44 sm:w-44" : "flex h-36 w-36 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-2xl transition hover:scale-105 active:scale-95 sm:h-44 sm:w-44"}
        >
          {voiceStatus === "idle" ? <Mic className="h-14 w-14" /> : <Square className="h-14 w-14" />}
          <span className="sr-only">{voiceStatus === "idle" ? t("assistant.talk") : t("assistant.interrupt")}</span>
        </button>

        <div className="text-xs text-muted-foreground">
          {voiceStatus === "idle" ? t("assistant.bigTalkHint") : t("assistant.interruptHint")}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Button type="button" className="fixed bottom-4 right-4 z-40 rounded-full shadow-lg lg:bottom-6 lg:right-6" onClick={() => setOpen(true)}>
        <Bot className="mr-2 h-4 w-4" />{t("assistant.floatingButton")}
      </Button>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent hideCloseButton className="left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[920px]">{syncPanel}</DialogContent></Dialog>
      <Dialog open={open} onOpenChange={(next) => { if (!next) interruptLiveVoice(); setOpen(next); }}><DialogContent hideCloseButton className={voiceMode || fullScreen ? "left-1/2 top-1/2 h-[96dvh] max-h-[96dvh] w-[98vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0" : "left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[720px] lg:right-6 lg:left-auto lg:top-auto lg:bottom-6 lg:h-[80dvh] lg:w-[420px] lg:max-w-[420px] lg:translate-x-0 lg:translate-y-0"}>{voiceMode ? liveVoicePanel : panel}</DialogContent></Dialog>
    </>
  );
}
