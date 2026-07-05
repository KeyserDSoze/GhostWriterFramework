import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  BookOpen,
  ChevronDown,
  ClipboardCheck,
  Copy,
  FileText,
  Ghost,
  GitBranch,
  History,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Mic,
  Minimize2,
  Paperclip,
  Pause,
  Play,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  Users,
  Volume2,
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
import { useUiStore } from "@/store/uiStore";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveBookToken } from "@/types/settings";
import {
  compareBranches,
  createBranchFromBase,
  createFile,
  deleteFile,
  loadFileContent,
  readFileWithSha,
  revertFileToRef,
  updateFile,
  type BranchDiffFile,
} from "@/github/githubClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { speakText, splitIntoStrofe, transcribeAudio, type SpeechController } from "@/assistant/speech";
import { completeText, resolveWritingIntegration } from "@/assistant/llm";
import { classifyConfirmationRouted, sttMode } from "@/assistant/router";
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

type QuickAction = {
  id: string;
  labelKey: string;
  icon: typeof Sparkles;
  run: () => void;
  disabled?: boolean;
};

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
  const floatingHidden = useUiStore((s) => s.floatingHidden);
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
  const localAudioHandledRef = useRef(false);
  const localAudioDoneRef = useRef<Promise<void> | null>(null);
  // Live "strofe" memory: every spoken segment of the current reading, the live index,
  // and a pending rewrite proposal awaiting a spoken "yes"/"no" confirmation.
  const liveStrofeRef = useRef<string[]>([]);
  const liveStrofeIndexRef = useRef(0);
  const speechControllerRef = useRef<SpeechController | null>(null);
  const manualEndRef = useRef(false);
  const pendingRewriteRef = useRef<{ from: number; to: number; segments: string[] } | null>(null);
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
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "thinking" | "speaking" | "paused" | "not-heard">("idle");
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState("");
  const [manualEnd, setManualEnd] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const [liveStrofeCount, setLiveStrofeCount] = useState(0);
  const [liveStrofeIndex, setLiveStrofeIndex] = useState(0);
  const [diffMode, setDiffMode] = useState<Record<string, boolean>>({});
  const [previousContents, setPreviousContents] = useState<Record<string, string>>({});
  const [loadingDiffPath, setLoadingDiffPath] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "history">("chat");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (open && isMobile) setFullScreen(true);
  }, [open, isMobile]);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    manualEndRef.current = manualEnd;
  }, [manualEnd]);

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

    if (sttMode(settings) === "ai") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];
        mediaRecorderRef.current = recorder;
        setListening(true);
        if (voiceModeRef.current) setVoiceStatus("listening");
        // Manual mode: keep recording until the user explicitly presses "Done".
        if (!manualEndRef.current) monitorSilence(stream);
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
              setLastVoiceTranscript(t("assistant.noSpeechHeard"));
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
    recognition.continuous = manualEndRef.current ? true : false;
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
        // Manual mode: never auto-submit on a final result; wait for the Done button.
        if (voiceModeRef.current && hasFinal && !speechRecognitionSentRef.current && !manualEndRef.current) {
          speechRecognitionSentRef.current = true;
          try { recognition.stop(); } catch {}
          void handleVoiceTranscript(transcript);
        }
        else if (autoSend && !manualEndRef.current) void sendPrompt(transcript);
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
      if (voiceModeRef.current) {
        setLastVoiceTranscript(t("assistant.noSpeechHeard"));
        setVoiceStatus("not-heard");
        window.setTimeout(() => {
          if (voiceModeRef.current) setVoiceStatus("idle");
        }, 1800);
      }
    };
    recognition.start();
  }

  function stopReading() {
    speechController?.stop();
    speechControllerRef.current = null;
    setSpeechController(null);
    setLivePaused(false);
  }

  function setLiveController(controller: SpeechController | null) {
    speechControllerRef.current = controller;
    setSpeechController(controller);
    setLivePaused(controller?.isPaused() ?? false);
  }

  /** Read prose as sentence-level "strofe", tracking the live index and heard count. */
  async function readText(text: string, opts?: { startIndex?: number; segments?: string[] }): Promise<SpeechController | null> {
    stopReading();
    const segments = opts?.segments ?? splitIntoStrofe(text);
    liveStrofeRef.current = segments;
    setLiveStrofeCount(segments.length);
    const startIndex = Math.max(0, opts?.startIndex ?? 0);
    liveStrofeIndexRef.current = startIndex;
    setLiveStrofeIndex(startIndex);
    try {
      const controller = await speakText(text, settings, {
        segments,
        startIndex,
        onSegment: (index) => {
          liveStrofeIndexRef.current = index;
          setLiveStrofeIndex(index);
        },
      });
      setLiveController(controller);
      void controller.done.finally(() => {
        if (speechControllerRef.current === controller) {
          speechControllerRef.current = null;
          setSpeechController(null);
          setLivePaused(false);
        }
      });
      return controller;
    } catch (err) {
      toast({ title: t("assistant.toastTtsFailed"), description: String(err), variant: "destructive" });
      return null;
    }
  }

  function pauseReading() {
    const controller = speechControllerRef.current;
    if (!controller) return;
    controller.pause();
    setLivePaused(true);
    if (voiceModeRef.current) setVoiceStatus("paused");
  }

  function resumeReading() {
    const controller = speechControllerRef.current;
    if (!controller) return;
    controller.resume();
    setLivePaused(false);
    if (voiceModeRef.current) setVoiceStatus("speaking");
  }

  function togglePauseReading() {
    const controller = speechControllerRef.current;
    if (!controller) return;
    if (controller.isPaused()) resumeReading();
    else pauseReading();
  }

  function lastAssistantReply(): AssistantMessage | undefined {
    return [...(currentSession?.messages ?? [])].reverse().find((message) => message.role === "assistant" && message.text.trim());
  }

  async function readLastAssistantReply() {
    const reply = lastAssistantReply();
    if (!reply) {
      toast({ title: t("assistant.noLastReply") });
      return;
    }
    await readText(reply.text);
  }

  async function copyAssistantMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t("assistant.copied") });
    } catch (err) {
      toast({ title: t("assistant.copyFailed"), description: String(err), variant: "destructive" });
    }
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
    if (localAudioHandledRef.current) {
      await localAudioDoneRef.current?.catch(() => undefined);
      localAudioHandledRef.current = false;
      localAudioDoneRef.current = null;
      if (voiceModeRef.current) setVoiceStatus("idle");
      return;
    }
    if (reply?.text && !localAudioHandledRef.current) {
      setVoiceStatus("speaking");
      const controller = await readText(reply.text);
      await controller?.done.catch(() => undefined);
    }
    localAudioHandledRef.current = false;
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
      // Pressing while listening submits the current turn (works for manual mode too).
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      speechRecognitionRef.current?.stop?.();
      return;
    }
    // While paused, let the user talk over the pause to issue strofe commands
    // WITHOUT tearing down the paused playback (resume can continue afterwards).
    if (voiceStatus === "paused") {
      await startSpeechToText();
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

  /** Manual-mode "Done": stop capturing and submit whatever was heard. */
  function finishTurn() {
    if (!listening) return;
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    speechRecognitionRef.current?.stop?.();
  }

  function interruptLiveVoice() {
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    localAudioHandledRef.current = false;
    localAudioDoneRef.current = null;
    pendingRewriteRef.current = null;
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
    localAudioHandledRef.current = false;
    const routeContext = await loadWriterContext(location.pathname, settings, settings.books, structures, workingBranches);
    const book = routeContext.book;
    const token = book ? resolveBookToken(book, settings) : "";
    const session = ensureSession();
    const userMessage = { id: crypto.randomUUID(), role: "user" as const, text: trimmed };
    updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, userMessage] }));
    setDraft("");
    setBusy(true);
    try {
      const strofaReply = await tryHandleStrofaCommand(trimmed);
      if (strofaReply) {
        updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, strofaReply] }));
        setOpen(true);
        return strofaReply;
      }
      const localReply = await tryHandleLocalVoiceTool(trimmed, { context: routeContext, book, token, spokenMode: options?.spokenMode });
      if (localReply) {
        updateCurrentSession((current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, localReply] }));
        setOpen(true);
        return localReply;
      }
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

  async function tryHandleLocalVoiceTool(
    prompt: string,
    input: {
      context: Awaited<ReturnType<typeof loadWriterContext>>;
      book: Awaited<ReturnType<typeof loadWriterContext>>["book"];
      token: string;
      spokenMode?: boolean;
    },
  ): Promise<AssistantMessage | null> {
    const readTarget = resolveReadTarget(prompt, input.context);
    if (!readTarget || !input.book || !input.token || !input.context.structure) return null;
    const includeFrontmatter = /\b(frontmatter|metadat|metadata|intestazion|header|campi|fields)\b/.test(prompt.toLowerCase());
    const text = await loadReadTargetText(readTarget, input.book, input.token, input.context.structure.loadedBranch, includeFrontmatter);
    if (!text.trim()) return makeAssistantReply(t("assistant.readTargetEmpty"));
    const title = readTarget.kind === "chapter" ? readTarget.chapter.title : readTarget.paragraph.title;
    const reply = makeAssistantReply(t("assistant.readingTarget", { title }));
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText(text);
    localAudioDoneRef.current = controller?.done ?? Promise.resolve();
    return reply;
  }

  function makeAssistantReply(text: string): AssistantMessage {
    return { id: crypto.randomUUID(), role: "assistant", text };
  }

  /** The strofa currently being spoken (or last one if playback already finished). */
  function liveStrofaIndex(): number {
    const total = liveStrofeRef.current.length;
    if (!total) return -1;
    return Math.min(liveStrofeIndexRef.current, total - 1);
  }

  /** Parse "ultime N", "ultima", "N strofe fa" → inclusive [from, to] window of indices. */
  function parseStrofaWindow(lower: string): { from: number; to: number } | null {
    const live = liveStrofaIndex();
    if (live < 0) return null;
    const numberWords: Record<string, number> = {
      una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6,
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    };
    const readWord = (raw?: string): number | null => {
      if (!raw) return null;
      const digits = raw.match(/\d+/);
      if (digits) return Math.max(1, parseInt(digits[0], 10));
      const word = raw.trim().toLowerCase();
      return numberWords[word] ?? null;
    };
    // "N strofe/strofa fa" / "N stanzas ago" → a single past strofa.
    const agoMatch = lower.match(/(\d+|una|uno|due|tre|quattro|cinque|sei|one|two|three|four|five|six)\s+(?:strofe?|stanzas?|frasi?|periodi?|righe?)\s+(?:fa|prima|indietro|ago|back|earlier)/);
    if (agoMatch) {
      const n = readWord(agoMatch[1]) ?? 1;
      const idx = Math.max(0, live - n);
      return { from: idx, to: idx };
    }
    // "ultime N strofe" / "last N strofe".
    const lastNMatch = lower.match(/(?:ultime?|last)\s+(\d+|una|uno|due|tre|quattro|cinque|sei|one|two|three|four|five|six)\s+(?:strofe?|stanzas?|frasi?|periodi?|righe?)?/);
    if (lastNMatch) {
      const n = readWord(lastNMatch[1]) ?? 1;
      return { from: Math.max(0, live - n + 1), to: live };
    }
    // "ultima strofa" / "last strofa" (singular, default 1).
    if (/(?:ultim[ao]|last|precedente|previous)\s+(?:strofa|stanza|frase|periodo|riga)/.test(lower)) {
      return { from: live, to: live };
    }
    return null;
  }

  function strofeSlice(window: { from: number; to: number }): string {
    return liveStrofeRef.current.slice(window.from, window.to + 1).join(" ").trim();
  }

  /** Handle in-memory strofe commands (repeat / quote / rewrite / synonym / confirm). */
  async function tryHandleStrofaCommand(prompt: string): Promise<AssistantMessage | null> {
    const lower = prompt.toLowerCase().trim();

    // 1) Confirmation of a pending rewrite proposal.
    if (pendingRewriteRef.current) {
      const yes = /\b(s[iì]|sì|ok|va bene|conferma|sostituisci|yes|sure|replace|confirm)\b/.test(lower);
      const no = /\b(no|annulla|lascia|cancel|keep|stop)\b/.test(lower);
      if (yes) return applyPendingRewrite();
      if (no) {
        pendingRewriteRef.current = null;
        return makeAssistantReply(t("assistant.rewriteCancelled"));
      }
      // Ambiguous → ask the cheap "simple-tasks" model with a forced tool to decide.
      const decision = await classifyConfirmationRouted(settings, prompt);
      if (decision === "yes") return applyPendingRewrite();
      if (decision === "no") {
        pendingRewriteRef.current = null;
        return makeAssistantReply(t("assistant.rewriteCancelled"));
      }
      // Still unclear → fall through to other handlers/LLM.
    }

    if (!liveStrofeRef.current.length) return null;

    const isStrofaTopic = /\b(strofe?|stanzas?|frasi?|periodi?|righe?)\b/.test(lower) ||
      /\b(ultim[ao]|last|precedente|previous)\b/.test(lower);
    if (!isStrofaTopic) return null;

    const window = parseStrofaWindow(lower);

    // 2) Rewrite / synonym request.
    const wantsRewrite = /\b(riscriv|rescriv|cambia|modific|sostitu|migliora|rewrite|rephrase|change|replace|improve)\b/.test(lower);
    const synonymMatch = lower.match(/\b(?:sinonimo|synonym)\b[^a-zàèéìòù]*(?:di|of|for|per)?\s*["“']?([\p{L}][\p{L}\s'-]*?)["”']?(?:\s|$|\.|,)/u);
    if ((wantsRewrite || synonymMatch) && window) {
      return proposeRewrite(window, { synonymWord: synonymMatch?.[1]?.trim(), instruction: prompt });
    }

    // 3) Repeat / read back recent strofe.
    const wantsRepeat = /\b(ripeti|rileggi|rip[eé]tere|ridimmi|dimmi|cosa hai detto|che hai detto|repeat|read again|say again|what did you say)\b/.test(lower);
    if (wantsRepeat && window) {
      const text = strofeSlice(window);
      if (!text) return makeAssistantReply(t("assistant.strofaEmpty"));
      localAudioHandledRef.current = true;
      setVoiceStatus("speaking");
      const controller = await readText(text);
      localAudioDoneRef.current = controller?.done ?? Promise.resolve();
      return makeAssistantReply(text);
    }

    return null;
  }

  /** Ask the LLM to rewrite the selected strofe; speak the proposal and await confirmation. */
  async function proposeRewrite(
    window: { from: number; to: number },
    opts: { synonymWord?: string; instruction: string },
  ): Promise<AssistantMessage | null> {
    const integration = resolveWritingIntegration(settings);
    if (!integration) return makeAssistantReply(t("assistant.rewriteNoModel"));
    const original = strofeSlice(window);
    if (!original) return makeAssistantReply(t("assistant.strofaEmpty"));
    const langName = settings.ui.language === "it" ? "Italian" : "English";
    const task = opts.synonymWord
      ? `Rewrite the passage replacing the word "${opts.synonymWord}" with a fitting synonym, keeping everything else identical in meaning and tone.`
      : `Rewrite the passage following this instruction: "${opts.instruction}". Keep the same language, meaning and roughly the same length.`;
    setVoiceStatus("thinking");
    startWaitingTone();
    let rewritten = "";
    try {
      rewritten = (await completeText(integration, [
        { role: "system", content: `You are a prose editor. ${task} Reply with ONLY the rewritten passage in ${langName}, no quotes, no preamble.` },
        { role: "user", content: original },
      ], "writing")).trim();
    } catch (err) {
      stopWaitingTone();
      return makeAssistantReply(t("assistant.rewriteFailed", { error: String(err) }));
    }
    stopWaitingTone();
    if (!rewritten) return makeAssistantReply(t("assistant.rewriteFailed", { error: "empty" }));
    const newSegments = splitIntoStrofe(rewritten);
    pendingRewriteRef.current = { from: window.from, to: window.to, segments: newSegments };
    const spoken = `${t("assistant.rewriteProposal")} ${rewritten} ${t("assistant.rewriteConfirmAsk")}`;
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText(spoken);
    localAudioDoneRef.current = controller?.done ?? Promise.resolve();
    return makeAssistantReply(spoken);
  }

  /** Replace the proposed strofe in memory and resume reading from there. */
  async function applyPendingRewrite(): Promise<AssistantMessage | null> {
    const pending = pendingRewriteRef.current;
    pendingRewriteRef.current = null;
    if (!pending) return makeAssistantReply(t("assistant.rewriteCancelled"));
    const segments = [...liveStrofeRef.current];
    segments.splice(pending.from, pending.to - pending.from + 1, ...pending.segments);
    liveStrofeRef.current = segments;
    setLiveStrofeCount(segments.length);
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText("", { segments, startIndex: pending.from });
    localAudioDoneRef.current = controller?.done ?? Promise.resolve();
    return makeAssistantReply(t("assistant.rewriteApplied"));
  }

  function resolveReadTarget(prompt: string, context: Awaited<ReturnType<typeof loadWriterContext>>):
    | { kind: "chapter"; chapter: NonNullable<typeof context.chapter> }
    | { kind: "paragraph"; chapter: NonNullable<typeof context.chapter>; paragraph: NonNullable<typeof context.paragraph> }
    | null {
    const lower = prompt.toLowerCase();
    if (!/\b(leggi|leggimi|riproduci|ascolta|read|play)\b/.test(lower)) return null;
    const structure = context.structure;
    if (!structure) return null;
    const paragraphThenChapterMatch = lower.match(/(?:paragrafo|paragraph|scena|scene)\s+(\d+).*?(?:capitolo|chapter)\s+(\d+)/);
    const chapterThenParagraphMatch = lower.match(/(?:capitolo|chapter)\s+(\d+).*?(?:paragrafo|paragraph|scena|scene)\s+(\d+)/);
    if (paragraphThenChapterMatch || chapterThenParagraphMatch) {
      const paragraphNumber = (paragraphThenChapterMatch?.[1] ?? chapterThenParagraphMatch?.[2] ?? "").padStart(3, "0");
      const chapterNumber = (paragraphThenChapterMatch?.[2] ?? chapterThenParagraphMatch?.[1] ?? "").padStart(3, "0");
      const chapter = structure.chapters.find((entry) => entry.slug.startsWith(`${chapterNumber}-`));
      const paragraph = chapter?.paragraphs.find((entry) => entry.number === paragraphNumber);
      if (chapter && paragraph) return { kind: "paragraph", chapter, paragraph };
    }
    const paragraphMatch = lower.match(/(?:questo\s+)?(?:paragrafo|paragraph|scena|scene)\s*(\d+)?/);
    if (paragraphMatch && context.chapter) {
      const paragraphNumber = paragraphMatch[1]?.padStart(3, "0");
      const paragraph = paragraphNumber
        ? context.chapter.paragraphs.find((entry) => entry.number === paragraphNumber)
        : context.paragraph;
      if (paragraph) return { kind: "paragraph", chapter: context.chapter, paragraph };
    }
    const chapterMatch = lower.match(/(?:questo\s+)?(?:capitolo|chapter)\s*(\d+)?/);
    if (chapterMatch) {
      const chapterNumber = chapterMatch[1]?.padStart(3, "0");
      const chapter = chapterNumber
        ? structure.chapters.find((entry) => entry.slug.startsWith(`${chapterNumber}-`))
        : context.chapter;
      if (chapter) return { kind: "chapter", chapter };
    }
    return null;
  }

  async function loadReadTargetText(
    target: { kind: "chapter"; chapter: Awaited<ReturnType<typeof loadWriterContext>>["chapter"] } | { kind: "paragraph"; chapter: Awaited<ReturnType<typeof loadWriterContext>>["chapter"]; paragraph: Awaited<ReturnType<typeof loadWriterContext>>["paragraph"] },
    book: NonNullable<Awaited<ReturnType<typeof loadWriterContext>>["book"]>,
    token: string,
    readBranch: string,
    includeFrontmatter = false,
  ): Promise<string> {
    const prepare = (raw: string) => (includeFrontmatter ? raw.trim() : stripFrontmatterForSpeech(raw));
    if (target.kind === "paragraph" && target.paragraph) {
      return prepare(await loadFileContent(token, book.owner, book.repo, target.paragraph.path, readBranch));
    }
    if (target.kind === "chapter" && target.chapter) {
      const chapterIntro = await loadFileContent(token, book.owner, book.repo, `${target.chapter.path}/chapter.md`, readBranch).catch(() => "");
      const paragraphs = await Promise.all(target.chapter.paragraphs.map((paragraph) => loadFileContent(token, book.owner, book.repo, paragraph.path, readBranch).catch(() => "")));
      return [`# ${target.chapter.title}`, prepare(chapterIntro), ...paragraphs.map(prepare)].filter(Boolean).join("\n\n");
    }
    return "";
  }

  function stripFrontmatterForSpeech(raw: string): string {
    return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
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

  async function deleteSavedSession(fileId: string) {
    if (!user || !accessToken) return;
    try {
      await deleteAssistantSession(user.provider, accessToken, fileId);
      setSessions(sessions.filter((session) => session.fileId !== fileId));
      if (currentSession?.fileId === fileId) setCurrentSession(null);
      toast({ title: t("assistant.toastChatDeleted") });
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

  const contextActions = useMemo<QuickAction[]>(() => {
    const actions: QuickAction[] = [];
    const ask = (prompt: string) => () => void sendPrompt(prompt);
    const canonSection = route.kind === "canon" ? route.section : undefined;

    if (route.kind === "paragraph" || route.kind === "paragraph-workspace") {
      actions.push({ id: "fix", labelKey: "assistant.actions.fixParagraph", icon: Wand2, run: ask("Improve the current paragraph while preserving all facts.") });
      actions.push({ id: "review", labelKey: "assistant.actions.review", icon: Sparkles, run: ask("Review this paragraph and give strengths, risks, and concrete next actions.") });
      actions.push({ id: "evaluation", labelKey: "assistant.actions.evaluation", icon: ClipboardCheck, run: ask("Write or refresh the evaluation for this paragraph.") });
      actions.push({ id: "resume", labelKey: "assistant.actions.resume", icon: FileText, run: ask("Write or refresh the resume for the current chapter.") });
    } else if (route.kind === "chapter" || route.kind === "chapter-workspace") {
      actions.push({ id: "summary", labelKey: "assistant.actions.summary", icon: Sparkles, run: ask("Summarize this chapter: what happens, who is present, and what matters next.") });
      actions.push({ id: "review", labelKey: "assistant.actions.review", icon: Sparkles, run: ask("Review this chapter and give strengths, risks, and concrete next actions.") });
      actions.push({ id: "resume", labelKey: "assistant.actions.resume", icon: FileText, run: ask("Write or refresh the resume for this chapter.") });
      actions.push({ id: "evaluation", labelKey: "assistant.actions.evaluation", icon: ClipboardCheck, run: ask("Write or refresh the evaluation for this chapter.") });
    } else if (canonSection === "characters") {
      actions.push({ id: "enrich", labelKey: "assistant.actions.enrichCharacter", icon: Users, run: ask("Enrich this character sheet: deepen motivation, voice, relationships, and arc while preserving canon.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this character against the loaded canon and flag contradictions or gaps.") });
      actions.push({ id: "appearances", labelKey: "assistant.actions.findAppearances", icon: Search, run: ask("Search the book for scenes and chapters where this character appears or is mentioned.") });
    } else if (canonSection === "locations") {
      actions.push({ id: "enrich", labelKey: "assistant.actions.enrichLocation", icon: BookOpen, run: ask("Enrich this location: atmosphere, sensory detail, story function, and risks, preserving canon.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this location against the loaded canon and flag contradictions or gaps.") });
      actions.push({ id: "appearances", labelKey: "assistant.actions.findAppearances", icon: Search, run: ask("Search the book for scenes set in or referencing this location.") });
    } else if (canonSection === "factions") {
      actions.push({ id: "enrich", labelKey: "assistant.actions.enrichFaction", icon: Users, run: ask("Enrich this faction: mission, ideology, methods, and alliances, preserving canon.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this faction against the loaded canon and flag contradictions or gaps.") });
      actions.push({ id: "appearances", labelKey: "assistant.actions.findAppearances", icon: Search, run: ask("Search the book for scenes and characters tied to this faction.") });
    } else if (canonSection === "items") {
      actions.push({ id: "enrich", labelKey: "assistant.actions.enrichItem", icon: BookOpen, run: ask("Enrich this item: appearance, purpose, significance, and limitations, preserving canon.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this item against the loaded canon and flag contradictions or gaps.") });
      actions.push({ id: "appearances", labelKey: "assistant.actions.findAppearances", icon: Search, run: ask("Search the book for scenes where this item appears or matters.") });
    } else if (canonSection === "secrets") {
      actions.push({ id: "reveal", labelKey: "assistant.actions.reviewReveal", icon: Sparkles, run: ask("Review this secret: holders, stakes, protection, and reveal timing, and flag leak risks.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this secret against the loaded canon and flag premature reveals or contradictions.") });
    } else if (canonSection === "timelines") {
      actions.push({ id: "enrich", labelKey: "assistant.actions.enrichTimeline", icon: BookOpen, run: ask("Enrich this timeline event: participants, significance, and consequences, preserving canon.") });
      actions.push({ id: "consistency", labelKey: "assistant.actions.checkConsistency", icon: Sparkles, run: ask("Check this event against the loaded canon and flag chronology contradictions.") });
    } else {
      actions.push({ id: "summary", labelKey: "assistant.actions.summary", icon: Sparkles, run: ask("Create a concise summary of where I am in this book and what matters next.") });
      actions.push({ id: "plot", labelKey: "assistant.actions.plot", icon: FileText, run: ask("Update plot.md for the current book.") });
      actions.push({ id: "search", labelKey: "assistant.actions.search", icon: Search, run: ask("Search the current book for relevant characters, paragraphs, or canon keywords.") });
    }

    actions.push({ id: "note", labelKey: "assistant.actions.saveNote", icon: FileText, run: ask("Create a writer note from the current context and save it.") });
    if (bookId) actions.push({ id: "diff", labelKey: "assistant.actions.syncDiff", icon: GitBranch, run: () => void loadBranchDiff(), disabled: loadingDiff });
    return actions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, bookId, loadingDiff]);

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

  const messagesView = (
    <div className="space-y-4">
      {currentSession?.messages.length ? null : (
        <div className="rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">{t("assistant.empty")}</div>
      )}
      {(currentSession?.messages ?? []).map((message, index) => (
        <div key={message.id} className={message.role === "user" ? "flex justify-end" : "group flex justify-start"}>
          <div className={message.role === "user" ? "max-w-[85%]" : "w-full max-w-[92%]"}>
            <div className={message.role === "user" ? "rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm" : "rounded-2xl rounded-bl-sm border bg-background px-4 py-3 text-sm leading-7 whitespace-pre-wrap shadow-sm"}>{message.text}</div>
            {message.role === "assistant" && message.text.trim() && (
              <div className="mt-1 flex items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => void copyAssistantMessage(message.text)}>
                  <Copy className="h-3.5 w-3.5" />{t("assistant.copyMessage")}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => void readText(message.text)}>
                  <Volume2 className="h-3.5 w-3.5" />{t("assistant.listenMessage")}
                </Button>
              </div>
            )}
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
        </div>
      ))}
      {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("assistant.thinking")}</div>}
    </div>
  );

  const historyView = (
    <div className="space-y-2">
      <Button variant="outline" size="sm" className="w-full justify-start" onClick={newChat}>
        <MessageSquarePlus className="mr-2 h-4 w-4" />{t("assistant.newChat")}
      </Button>
      {loadingSessions && <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("assistant.loadingChats")}</div>}
      {!loadingSessions && sessions.length === 0 && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("assistant.noSavedChats")}</p>}
      {sessions.map((session) => {
        const id = session.fileId ?? session.id;
        const active = (currentSession?.fileId ?? currentSession?.id) === id;
        return (
          <div key={id} className={active ? "flex items-center gap-2 rounded-xl border bg-primary/5 p-2" : "flex items-center gap-2 rounded-xl border p-2 hover:bg-muted/40"}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { void openSession(id); setActiveTab("chat"); }}>
              <p className="truncate text-sm font-medium">{session.title || t("assistant.untitledChat")}</p>
              <p className="truncate text-xs text-muted-foreground">{session.contextTitle || t("assistant.title")}</p>
            </button>
            {session.fileId && (
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => void deleteSavedSession(session.fileId!)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );

  const panel = (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Ghost className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{t("assistant.title")}</p>
            <p className="truncate text-xs text-muted-foreground leading-tight">{contextLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant={voiceMode ? "default" : "ghost"} size="icon" className="h-8 w-8" title={t("assistant.liveVoice")} onClick={toggleVoiceMode}><Ghost className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title={fullScreen ? t("assistant.exitFullscreen") : t("assistant.fullscreen")} onClick={() => setFullScreen((value) => !value)}>{fullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title={t("assistant.close")} onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "chat" | "history")} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-3 py-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="chat"><Bot className="mr-1.5 h-3.5 w-3.5" />{t("assistant.tabChat")}</TabsTrigger>
            <TabsTrigger value="history"><History className="mr-1.5 h-3.5 w-3.5" />{t("assistant.tabHistory")}</TabsTrigger>
          </TabsList>
        </div>

        {activeTab === "history" ? (
          <ScrollArea className="min-h-0 flex-1 px-3 py-3">{historyView}</ScrollArea>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1">
                    <Sparkles className="h-4 w-4" />{t("assistant.quickActions")}<ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel className="text-xs">{contextLabel}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {contextActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <DropdownMenuItem key={action.id} disabled={action.disabled} onSelect={() => action.run()}>
                        <Icon className="mr-2 h-4 w-4" />{t(action.labelKey)}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" size="sm" className="h-8 gap-1" onClick={speechController ? stopReading : () => void readLastAssistantReply()}>
                {speechController ? <Square className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                <span className="hidden sm:inline">{speechController ? t("assistant.stopReading") : t("assistant.read")}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="ml-auto h-8 text-xs text-muted-foreground">{t("assistant.contextInspector")}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel className="text-xs">{contextSummary || t("assistant.contextFollows")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <div className="max-h-60 space-y-1 overflow-auto px-2 py-1 text-xs text-muted-foreground">
                    <p>{t("assistant.filesInManifestCount", { count: availableCount })}</p>
                    <p className="font-medium text-foreground">{t("assistant.loadedNow")}</p>
                    {contextFiles.length ? contextFiles.map((path) => <div key={path} className="truncate font-mono">{path}</div>) : <div>{t("assistant.none")}</div>}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {currentSession?.attachments.length ? (
              <div className="flex flex-wrap gap-2 border-b px-3 py-2">
                {currentSession.attachments.map((attachment) => (
                  <Badge key={attachment.id} variant="secondary" className="gap-1 pr-1">
                    {attachment.name}
                    <button type="button" onClick={() => removeAttachment(attachment.id)} className="rounded p-0.5 hover:bg-black/10"><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
              </div>
            ) : null}

            <ScrollArea className="min-h-0 flex-1 px-3 py-4">
              {currentSession?.compactSummary && <div className="mb-3 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap"><p className="mb-1 font-medium text-foreground">{t("assistant.compactionSummary")}</p>{currentSession.compactSummary}</div>}
              {messagesView}
            </ScrollArea>

            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void attachFiles(event.target.files)} accept=".pdf,.docx,.md,.markdown,.txt,image/png,image/jpeg,.jpg,.jpeg" />
            <div className="border-t p-3">
              <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void sendPrompt(draft); }}>
                <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("assistant.placeholder")} className="min-h-[76px] resize-none" />
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" title={t("assistant.attachFiles")} onClick={() => fileInputRef.current?.click()}><Paperclip className="h-4 w-4" /></Button>
                  <Button type="button" variant={listening ? "default" : "ghost"} size="icon" className="h-9 w-9 shrink-0" title={listening ? t("assistant.stopMic") : t("assistant.microphone")} onClick={() => void startSpeechToText()} disabled={busy || voiceMode}>
                    {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" title={t("assistant.more")}><ChevronDown className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      <DropdownMenuLabel className="text-xs">{t("assistant.importAttachments")}</DropdownMenuLabel>
                      {ATTACHMENT_TARGETS.map((target) => (
                        <DropdownMenuItem key={target.value} onSelect={() => setAttachmentTarget(target.value)}>
                          <span className={attachmentTarget === target.value ? "font-medium text-foreground" : ""}>{t(target.labelKey)}</span>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={busy || !(currentSession?.attachments.length)} onSelect={() => void handleImportAttachments()}>
                        <Paperclip className="mr-2 h-4 w-4" />{t("assistant.importSelected", { target: t(ATTACHMENT_TARGETS.find((entry) => entry.value === attachmentTarget)?.labelKey ?? "assistant.importParagraph") })}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setAutoSend((value) => !value)}>
                        <Mic className="mr-2 h-4 w-4" />{autoSend ? t("assistant.autoSendOn") : t("assistant.autoSendOff")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="ml-auto flex items-center gap-1.5">
                    {draft.trim() && <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setDraft("")}>{t("assistant.clear")}</Button>}
                    <Button type="submit" size="sm" className="h-9" disabled={!draft.trim() || busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-1.5 hidden sm:inline">{t("assistant.send")}</span></Button>
                  </div>
                </div>
              </form>
            </div>
          </>
        )}
      </Tabs>
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
          {liveStrofeCount > 0 && (
            <p className="text-xs font-medium text-muted-foreground">
              {t("assistant.strofaCounter", { current: Math.min(liveStrofeIndex + 1, liveStrofeCount), total: liveStrofeCount })}
            </p>
          )}
          {lastVoiceTranscript && <p className="rounded-2xl border bg-background/70 px-4 py-3 text-sm text-muted-foreground">“{lastVoiceTranscript}”</p>}
        </div>

        <div className="flex items-center gap-4">
          {(voiceStatus === "speaking" || voiceStatus === "paused") && speechController && (
            <button
              type="button"
              onClick={togglePauseReading}
              title={livePaused ? t("assistant.resumeAudio") : t("assistant.pauseAudio")}
              className="flex h-16 w-16 items-center justify-center rounded-full border bg-background text-foreground shadow-lg transition hover:scale-105 active:scale-95"
            >
              {livePaused ? <Play className="h-7 w-7" /> : <Pause className="h-7 w-7" />}
              <span className="sr-only">{livePaused ? t("assistant.resumeAudio") : t("assistant.pauseAudio")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void startVoiceTurn()}
            className={voiceStatus === "idle" || voiceStatus === "not-heard" || voiceStatus === "paused" ? "flex h-36 w-36 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-2xl transition hover:scale-105 active:scale-95 sm:h-44 sm:w-44" : "flex h-36 w-36 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-2xl transition hover:scale-105 active:scale-95 sm:h-44 sm:w-44"}
          >
            {voiceStatus === "idle" || voiceStatus === "not-heard" || voiceStatus === "paused" ? <Mic className="h-14 w-14" /> : <Square className="h-14 w-14" />}
            <span className="sr-only">{voiceStatus === "idle" || voiceStatus === "not-heard" || voiceStatus === "paused" ? t("assistant.talk") : t("assistant.interrupt")}</span>
          </button>

          {manualEnd && listening && (
            <button
              type="button"
              onClick={finishTurn}
              title={t("assistant.doneTalking")}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-105 active:scale-95"
            >
              <Send className="h-6 w-6" />
              <span className="sr-only">{t("assistant.doneTalking")}</span>
            </button>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {voiceStatus === "paused"
            ? t("assistant.pausedHint")
            : voiceStatus === "idle" || voiceStatus === "not-heard"
              ? (manualEnd ? t("assistant.manualTalkHint") : t("assistant.bigTalkHint"))
              : t("assistant.interruptHint")}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border"
            checked={manualEnd}
            onChange={(event) => setManualEnd(event.target.checked)}
          />
          {t("assistant.manualEndLabel")}
        </label>
      </div>
    </div>
  );

  return (
    <>
      {!floatingHidden && (
        <div className="fixed bottom-4 right-4 z-40 flex overflow-hidden rounded-full shadow-lg lg:bottom-6 lg:right-6">
          <button type="button" className="flex items-center gap-2 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" onClick={() => { setVoiceMode(false); voiceModeRef.current = false; setOpen(true); }}>
            <Bot className="h-4 w-4" />{t("assistant.floatingButton")}
          </button>
          <span className="w-px self-stretch bg-primary-foreground/20" />
          <button type="button" className="flex items-center justify-center bg-primary px-3 py-2.5 text-primary-foreground transition hover:bg-primary/90" title={t("assistant.liveVoice")} onClick={() => { setVoiceMode(true); voiceModeRef.current = true; setOpen(true); }}>
            <Ghost className="h-5 w-5" />
          </button>
        </div>
      )}
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent hideCloseButton className="left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[920px]">{syncPanel}</DialogContent></Dialog>
      <Dialog open={open} onOpenChange={(next) => { if (!next) interruptLiveVoice(); setOpen(next); }}><DialogContent hideCloseButton className={voiceMode || fullScreen ? "left-1/2 top-1/2 h-[96dvh] max-h-[96dvh] w-[98vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0" : "left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[720px] lg:right-6 lg:left-auto lg:top-auto lg:bottom-6 lg:h-[80dvh] lg:w-[420px] lg:max-w-[420px] lg:translate-x-0 lg:translate-y-0"}>{voiceMode ? liveVoicePanel : panel}</DialogContent></Dialog>
    </>
  );
}
