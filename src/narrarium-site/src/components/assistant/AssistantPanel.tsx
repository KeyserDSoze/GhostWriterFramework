import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Bot,
  BookOpen,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
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
  type AssistantSessionMeta,
} from "@/assistant/store";
import { appendAssistantNote, applyParagraphRewrite, compactAssistantSession, runAssistantPrompt } from "@/assistant/service";
import { assistantMarkdownToRichPlainText, buildAssistantSessionMarkdown, buildAssistantSessionPdfBlob, renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import { loadWriterContext, parseAppRoute } from "@/assistant/context";
import { resolveNavigateAction, resolveReadAloudAction, type ReadAloudAction } from "@/assistant/planner";
import { deleteAssistantSession, listAssistantSessions, loadAssistantSession, saveAssistantSession } from "@/assistant/chatCloud";
import { AssistantSessionSaveQueue, assistantSessionSaveFingerprint, attachAssistantSessionCloudHandle, upsertAssistantSessionMeta } from "@/assistant/sessionAutosave";
import { assistantSessionCompactionTarget, mergeAssistantSessionCompaction } from "@/assistant/sessionCompaction";
import { isAssistantRequestOwned } from "@/assistant/sessionOwnership";
import { isMediaOperationOwned, stopMediaStreamTracks } from "@/assistant/mediaOwnership";
import { assistantActionToolId, policyTargetEnabled, quickActionToolId } from "@/assistant/toolPolicy";
import { hasAssistantActionProvenance, sourceRevisionFromFiles, validateAssistantAction } from "@/assistant/actionValidation";
import { copilotToolRegistry, isCopilotToolIdEnabled } from "@/assistant/tools/registry";
import { ensureBuiltinCopilotToolsRegistered } from "@/assistant/tools/builtinTools";
import { accountIdentity, isAccountIdentityCurrent } from "@/auth/accountIdentity";
import { parseAttachment } from "@/assistant/attachments";
import type { AttachmentImportTarget } from "@/assistant/attachmentImport";
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
import { resolveBookExportSettings, resolveBookToken } from "@/types/settings";
import {
  compareBranches,
  createBranchFromBase,
  deleteFile,
  isGitHubFileNotFoundError,
  listBranchCommits,
  loadFileContent,
  readFileWithSha,
  reorderParagraphsInChapter,
  revertFileToRef,
  type BranchDiffFile,
} from "@/github/githubClient";
import { uploadDriveFile } from "@/drive/exportDriveClient";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { speakText, splitIntoStrofe, transcribeAudio, type SpeechController } from "@/assistant/speech";
import { classifyConfirmationRouted, completeTextRouted, sttMode } from "@/assistant/router";
import { FileDiff, PatchDiff } from "@/components/diff/DiffView";
import { commitAndPushTextFileMutation, RepositoryConflictError, resolveRepositoryHeadForMutation, sha256Text } from "@/repository/safeRepositoryMutation";
import { currentRevisionToken, fileRevisionMatches, fileUpdateCounts, markFileUpdatesApplied, markFileUpdatesFailed, markFileUpdatesUndone, pendingFileUpdates } from "@/assistant/multiFileOperation";
import { buildCanonEntityDocument } from "@/narrarium/canon";
import { BrowserSpeechFallbackRequired } from "@/assistant/mediaFallback";
import { optionalRepositoryRead } from "@/repository/repositoryError";
import { refreshBookAfterMutation, runPromptWithMutationRefresh } from "@/assistant/mutationRefresh";

ensureBuiltinCopilotToolsRegistered();

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

type QuickAction = {
  id: string;
  labelKey: string;
  icon: typeof Sparkles;
  run: () => void;
  disabled?: boolean;
};

type MediaOperation = { generation: number; signal: AbortSignal };

export function AssistantPanel() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseAppRoute(location.pathname), [location.pathname]);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const { branch, ensuring: branchEnsuring, ready: branchReady, error: branchError } = useWorkingBranch(bookId);
  const { settings, patchSettings } = useSettingsStore();
  const { structures, workingBranches, clearBook } = useBooksStore();
  const { save } = useSettings();
  const { user, accessToken } = useAuthStore();
  const floatingHidden = useUiStore((s) => s.floatingHidden);
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const speechRecognitionTranscriptRef = useRef("");
  const speechRecognitionSentRef = useRef(false);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceModeRef = useRef(false);
  const waitingToneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notHeardTimerRef = useRef<number | null>(null);
  const waitingCueContextsRef = useRef(new Set<AudioContext>());
  const waitingCueTimersRef = useRef(new Set<number>());
  const mediaGenerationRef = useRef(0);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const localAudioHandledRef = useRef(false);
  const localAudioDoneRef = useRef<Promise<void> | null>(null);
  // Live "strofe" memory: every spoken segment of the current reading, the live index,
  // and a pending rewrite proposal awaiting a spoken "yes"/"no" confirmation.
  const liveStrofeRef = useRef<string[]>([]);
  const liveStrofeIndexRef = useRef(0);
  const speechControllerRef = useRef<SpeechController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const manualEndRef = useRef(false);
  const pendingRewriteRef = useRef<{ from: number; to: number; segments: string[] } | null>(null);
  const sessionSaveQueueRef = useRef(new AssistantSessionSaveQueue());
  const queuedSessionFingerprintsRef = useRef(new Map<string, string>());
  const compactionRunRef = useRef(0);
  const activePromptRef = useRef<{ requestId: string; sessionId: string; controller: AbortController } | null>(null);
  const attachmentRunRef = useRef(0);
  const activeAttachmentRunRef = useRef<number | null>(null);
  const openSessionRunRef = useRef(0);
  const activeOpenSessionRunRef = useRef<number | null>(null);
  const openSessionAbortRef = useRef<AbortController | null>(null);
  const cloudAccountAbortRef = useRef(new AbortController());
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
  const [attachmentTarget, setAttachmentTarget] = useState<AttachmentImportTarget>("paragraph");
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
    if (!open) cancelMediaOperations({ disableVoice: true });
  }, [open]);

  useEffect(() => {
    cancelMediaOperations({ disableVoice: true });
    return () => cancelMediaOperations({ disableVoice: true, updateUi: false });
  }, [user?.provider, user?.email, accessToken]);

  useEffect(() => {
    manualEndRef.current = manualEnd;
  }, [manualEnd]);

  useEffect(() => {
    cloudAccountAbortRef.current.abort();
    cloudAccountAbortRef.current = new AbortController();
    sessionSaveQueueRef.current.reset();
    queuedSessionFingerprintsRef.current.clear();
    return () => {
      cloudAccountAbortRef.current.abort();
      sessionSaveQueueRef.current.reset();
      queuedSessionFingerprintsRef.current.clear();
      cancelSessionOperations();
    };
  }, [user?.provider, user?.email, accessToken]);

  const lastMessageText = currentSession?.messages[currentSession.messages.length - 1]?.text;
  useEffect(() => {
    if (busy) messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [busy, lastMessageText]);

  useEffect(() => {
    let active = true;
    void loadWriterContext(location.pathname, settings, settings.books, structures, workingBranches, branch).then((ctx) => {
      if (!active) return;
      setContextLabel(ctx.title);
      setContextSummary(ctx.summary);
      setContextFiles(ctx.loadedFilePaths);
      setAvailableCount(ctx.availableFiles.length);
    }).catch((error) => {
      if (!active) return;
      setContextFiles([]);
      toast({ title: settings.ui.language === "it" ? "Impossibile caricare il contesto repository" : "Could not load repository context", description: String(error), variant: "destructive" });
    });
    return () => {
      active = false;
    };
  }, [branch, location.pathname, settings, structures, workingBranches]);

  useEffect(() => {
    if (!open || !user || !accessToken) return;
    let active = true;
    const controller = new AbortController();
    const expectedIdentity = accountIdentity(user);
    setLoadingSessions(true);
    void listAssistantSessions(user.provider, accessToken, { signal: controller.signal, isCurrent: () => isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user) })
      .then((items) => {
        if (active && isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) setSessions(items);
      })
      .catch((err) => {
        if (active && isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) {
          toast({ title: t("assistant.toastLoadChatsFailed"), description: String(err), variant: "destructive" });
        }
      })
      .finally(() => {
        if (active && isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) setLoadingSessions(false);
      });
    return () => { active = false; controller.abort(); };
  }, [open, user, accessToken, setSessions, toast]);

  useEffect(() => {
    if (!user || !accessToken || !currentSession) return;
    const expectedIdentity = accountIdentity(user);
    const fingerprint = assistantSessionSaveFingerprint(currentSession);
    if (queuedSessionFingerprintsRef.current.get(currentSession.id) === fingerprint) return;
    const timer = setTimeout(() => {
      queuedSessionFingerprintsRef.current.set(currentSession.id, fingerprint);
      void sessionSaveQueueRef.current.enqueue(
        currentSession,
        (session) => saveAssistantSession(user.provider, accessToken, session),
        (savedSnapshot, handle) => {
          if (!isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
          const state = useAssistantStore.getState();
          const latest = state.currentSession?.id === savedSnapshot.id ? state.currentSession : null;
          const sessionWithFileId = attachAssistantSessionCloudHandle(state.currentSession, savedSnapshot.id, handle);
          if (sessionWithFileId !== state.currentSession) state.setCurrentSession(sessionWithFileId);
          const metadataSource = latest ?? savedSnapshot;
          state.setSessions(upsertAssistantSessionMeta(state.sessions, metadataSource, handle));
        },
        (err) => {
          if (isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) {
            toast({ title: t("assistant.toastSaveChatFailed"), description: String(err), variant: "destructive" });
          }
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [currentSession, user, accessToken, toast]);

  useEffect(() => {
    if (!currentSession || busy || assistantSessionCompactionTarget(currentSession) === null) return;
    const sourceSession = currentSession;
    const controller = new AbortController();
    const runId = ++compactionRunRef.current;
    void compactAssistantSession({ session: sourceSession, settings, signal: controller.signal })
      .then((compacted) => {
        if (controller.signal.aborted || compactionRunRef.current !== runId) return;
        const state = useAssistantStore.getState();
        const merged = mergeAssistantSessionCompaction(state.currentSession, sourceSession.id, compacted);
        if (merged !== state.currentSession) state.setCurrentSession(merged);
      })
      .catch((err) => {
        if (!controller.signal.aborted && compactionRunRef.current === runId) {
          toast({ title: t("assistant.toastCompactionFailed"), description: String(err), variant: "destructive" });
        }
      });
    return () => controller.abort();
  }, [currentSession?.id, currentSession?.messages.length, currentSession?.compactedMessageCount, settings, busy, toast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelMediaOperations({ disableVoice: true, updateUi: false });
    };
  }, []);

  function playWaitTick() {
    try {
      const context = new AudioContext();
      waitingCueContextsRef.current.add(context);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.value = 0.035;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      const timer = window.setTimeout(() => {
        waitingCueTimersRef.current.delete(timer);
        oscillator.stop();
        waitingCueContextsRef.current.delete(context);
        void context.close().catch(() => undefined);
      }, 120);
      waitingCueTimersRef.current.add(timer);
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
    const existing = useAssistantStore.getState().currentSession;
    if (existing) return existing;
    const next = createEmptyAssistantSession(contextLabel);
    setCurrentSession(next);
    return next;
  }

  function cancelSessionOperations() {
    let releasedBusy = false;
    if (activePromptRef.current) {
      activePromptRef.current.controller.abort();
      activePromptRef.current = null;
      releasedBusy = true;
    }
    if (activeAttachmentRunRef.current !== null) {
      attachmentRunRef.current += 1;
      activeAttachmentRunRef.current = null;
      releasedBusy = true;
    }
    if (activeOpenSessionRunRef.current !== null) {
      openSessionAbortRef.current?.abort();
      openSessionAbortRef.current = null;
      openSessionRunRef.current += 1;
      activeOpenSessionRunRef.current = null;
      releasedBusy = true;
    }
    if (releasedBusy) setBusy(false);
  }

  function beginMediaOperation(): { generation: number; signal: AbortSignal } {
    cancelMediaOperations();
    const controller = new AbortController();
    mediaAbortRef.current = controller;
    return { generation: mediaGenerationRef.current, signal: controller.signal };
  }

  function currentMediaOperation(): { generation: number; signal: AbortSignal } {
    const current = mediaAbortRef.current;
    if (current && !current.signal.aborted) return { generation: mediaGenerationRef.current, signal: current.signal };
    return beginMediaOperation();
  }

  function ownsMediaOperation(generation: number, signal: AbortSignal): boolean {
    return mountedRef.current && isMediaOperationOwned(mediaGenerationRef.current, generation, signal.aborted);
  }

  function cancelMediaOperations(options: { disableVoice?: boolean; updateUi?: boolean } = {}) {
    mediaGenerationRef.current += 1;
    mediaAbortRef.current?.abort();
    mediaAbortRef.current = null;
    stopWaitingTone();
    stopSilenceMonitor();
    if (notHeardTimerRef.current) {
      clearTimeout(notHeardTimerRef.current);
      notHeardTimerRef.current = null;
    }
    for (const timer of waitingCueTimersRef.current) clearTimeout(timer);
    waitingCueTimersRef.current.clear();
    for (const context of waitingCueContextsRef.current) void context.close().catch(() => undefined);
    waitingCueContextsRef.current.clear();

    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.abort?.(); } catch {}
      try { recognition.stop?.(); } catch {}
    }
    speechRecognitionTranscriptRef.current = "";
    speechRecognitionSentRef.current = true;

    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state === "recording") {
        try { recorder.stop(); } catch {}
      }
    }
    stopMediaStreamTracks(mediaStreamRef.current);
    mediaStreamRef.current = null;
    audioChunksRef.current = [];

    speechControllerRef.current?.stop();
    speechControllerRef.current = null;
    window.speechSynthesis?.cancel();
    localAudioHandledRef.current = false;
    localAudioDoneRef.current = null;
    pendingRewriteRef.current = null;
    if (options.disableVoice) voiceModeRef.current = false;

    if (options.updateUi !== false && mountedRef.current) {
      setListening(false);
      setSpeechController(null);
      setLivePaused(false);
      setVoiceStatus("idle");
      if (options.disableVoice) setVoiceMode(false);
    }
  }

  function newChat() {
    cancelSessionOperations();
    setCurrentSession(createEmptyAssistantSession(contextLabel));
    setActiveTab("chat");
    setOpen(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void attachFiles(event.dataTransfer.files);
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    const session = ensureSession();
    const runId = ++attachmentRunRef.current;
    activeAttachmentRunRef.current = runId;
    setBusy(true);
    try {
      const parsed: AssistantAttachment[] = [];
      for (const file of Array.from(files)) parsed.push(await parseAttachment(file));
      if (activeAttachmentRunRef.current !== runId) return;
      useAssistantStore.getState().updateSession(session.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        attachments: [...current.attachments, ...parsed],
      }));
      if (!session.messages.length) setOpen(true);
    } catch (err) {
      if (activeAttachmentRunRef.current === runId) {
        toast({ title: t("assistant.toastAttachFailed"), description: String(err), variant: "destructive" });
      }
    } finally {
      if (activeAttachmentRunRef.current === runId) {
        activeAttachmentRunRef.current = null;
        setBusy(false);
      }
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

  async function startSpeechToText(forceBrowser = false, candidateIndex = 0) {
    if (listening && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      return;
    }

    const operation = voiceModeRef.current ? currentMediaOperation() : beginMediaOperation();

    const mode = sttMode(settings, candidateIndex);
    if (!forceBrowser && mode === "none") {
      toast({ title: t("assistant.toastSttUnavailable"), description: t("assistant.sttBrowserUnsupported"), variant: "destructive" });
      return;
    }
    if (!forceBrowser && mode === "ai") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!ownsMediaOperation(operation.generation, operation.signal)) {
          stopMediaStreamTracks(stream);
          return;
        }
        const recorder = new MediaRecorder(stream);
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        mediaRecorderRef.current = recorder;
        setListening(true);
        if (voiceModeRef.current) setVoiceStatus("listening");
        // Manual mode: keep recording until the user explicitly presses "Done".
        if (!manualEndRef.current) monitorSilence(stream);
        recorder.ondataavailable = (event) => {
          if (!ownsMediaOperation(operation.generation, operation.signal)) return;
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          stopSilenceMonitor();
          stopMediaStreamTracks(stream);
          if (mediaStreamRef.current === stream) mediaStreamRef.current = null;
          if (!ownsMediaOperation(operation.generation, operation.signal)) return;
          setListening(false);
          mediaRecorderRef.current = null;
          if (voiceModeRef.current) setVoiceStatus("thinking");
          try {
            const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
            const transcript = (await transcribeAudio(blob, settings, operation.signal, candidateIndex)).trim();
            if (!ownsMediaOperation(operation.generation, operation.signal)) return;
            if (transcript) {
              if (voiceModeRef.current) void handleVoiceTranscript(transcript, operation.generation, operation.signal);
              else if (autoSend) void sendPrompt(transcript, { signal: operation.signal });
              else appendDraftText(transcript);
            } else if (voiceModeRef.current) {
              setLastVoiceTranscript(t("assistant.noSpeechHeard"));
              setVoiceStatus("idle");
            }
          } catch (err) {
            if (!ownsMediaOperation(operation.generation, operation.signal)) return;
            if (err instanceof BrowserSpeechFallbackRequired) {
              await startSpeechToText(true, err.nextCandidateIndex);
              return;
            }
            if (voiceModeRef.current) setVoiceStatus("idle");
            toast({ title: t("assistant.toastSttFailed"), description: String(err), variant: "destructive" });
          }
        };
        recorder.start();
      } catch (err) {
        if (!ownsMediaOperation(operation.generation, operation.signal)) return;
        stopSilenceMonitor();
        setListening(false);
        toast({ title: t("assistant.toastMicUnavailable"), description: String(err), variant: "destructive" });
      }
      return;
    }

    const browserFallbackIndex = forceBrowser ? candidateIndex : candidateIndex + 1;
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (sttMode(settings, browserFallbackIndex) === "ai") {
        await startSpeechToText(false, browserFallbackIndex);
        return;
      }
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
    let recognitionFailed = false;
    setListening(true);
    if (voiceModeRef.current) setVoiceStatus("listening");
    recognition.onresult = (event: any) => {
      if (!ownsMediaOperation(operation.generation, operation.signal)) return;
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
          void handleVoiceTranscript(transcript, operation.generation, operation.signal);
        }
        else if (autoSend && !manualEndRef.current) void sendPrompt(transcript, { signal: operation.signal });
        else if (!voiceModeRef.current) appendDraftText(transcript);
      }
    };
    recognition.onerror = () => {
      if (!ownsMediaOperation(operation.generation, operation.signal)) return;
      recognitionFailed = true;
      speechRecognitionRef.current = null;
      speechRecognitionTranscriptRef.current = "";
      setListening(false);
      if (voiceModeRef.current) setVoiceStatus("idle");
      if (sttMode(settings, browserFallbackIndex) === "ai") void startSpeechToText(false, browserFallbackIndex);
      else toast({ title: t("assistant.toastSttFailed"), description: t("assistant.sttBrowserUnsupported"), variant: "destructive" });
    };
    recognition.onend = () => {
      if (!ownsMediaOperation(operation.generation, operation.signal)) return;
      if (recognitionFailed) return;
      speechRecognitionRef.current = null;
      setListening(false);
      const transcript = speechRecognitionTranscriptRef.current.trim();
      if (voiceModeRef.current && transcript && !speechRecognitionSentRef.current) {
        speechRecognitionSentRef.current = true;
        void handleVoiceTranscript(transcript, operation.generation, operation.signal);
        return;
      }
      if (voiceModeRef.current) {
        setLastVoiceTranscript(t("assistant.noSpeechHeard"));
        setVoiceStatus("not-heard");
        notHeardTimerRef.current = window.setTimeout(() => {
          notHeardTimerRef.current = null;
          if (ownsMediaOperation(operation.generation, operation.signal) && voiceModeRef.current) setVoiceStatus("idle");
        }, 1800);
      }
    };
    if (ownsMediaOperation(operation.generation, operation.signal)) {
      try {
        recognition.start();
      } catch (error) {
        speechRecognitionRef.current = null;
        setListening(false);
        if (sttMode(settings, browserFallbackIndex) === "ai") await startSpeechToText(false, browserFallbackIndex);
        else toast({ title: t("assistant.toastSttFailed"), description: String(error), variant: "destructive" });
      }
    }
  }

  function stopReading() {
    speechControllerRef.current?.stop();
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
  async function readText(text: string, opts?: { startIndex?: number; segments?: string[]; operation?: MediaOperation }): Promise<SpeechController | null> {
    const operation = opts?.operation ?? (voiceModeRef.current ? currentMediaOperation() : beginMediaOperation());
    if (!ownsMediaOperation(operation.generation, operation.signal)) return null;
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
        signal: operation.signal,
        onSegment: (index) => {
          if (!ownsMediaOperation(operation.generation, operation.signal)) return;
          liveStrofeIndexRef.current = index;
          setLiveStrofeIndex(index);
        },
        onError: (error) => {
          if (!ownsMediaOperation(operation.generation, operation.signal)) return;
          toast({ title: t("assistant.toastTtsFailed"), description: String(error), variant: "destructive" });
        },
      });
      if (!ownsMediaOperation(operation.generation, operation.signal)) {
        controller.stop();
        return null;
      }
      setLiveController(controller);
      const clearController = () => {
        if (mountedRef.current && speechControllerRef.current === controller) {
          speechControllerRef.current = null;
          setSpeechController(null);
          setLivePaused(false);
        }
      };
      void controller.done.then(clearController, clearController);
      return controller;
    } catch (err) {
      if (!ownsMediaOperation(operation.generation, operation.signal)) return null;
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

  async function copyAssistantMessage(text: string, mode: "markdown" | "formatted" = "markdown") {
    try {
      if (mode === "formatted" && "ClipboardItem" in window && navigator.clipboard.write) {
        const html = renderAssistantMarkdownHtml(text);
        const plain = assistantMarkdownToRichPlainText(text);
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plain], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(mode === "markdown" ? text : assistantMarkdownToRichPlainText(text));
      }
      toast({ title: mode === "markdown" ? t("assistant.copiedMarkdown") : t("assistant.copiedFormatted") });
    } catch (err) {
      toast({ title: t("assistant.copyFailed"), description: String(err), variant: "destructive" });
    }
  }

  function downloadBlob(fileName: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  function sessionFileBaseName(session: NonNullable<typeof currentSession>) {
    return (session.title || session.contextTitle || "chat")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "chat";
  }

  async function summarizeLatestAssistantReplyText(text: string): Promise<string | null> {
    try {
      return await completeTextRouted(settings, [
        {
          role: "system",
          content: `Summarize the assistant reply below as a concise writer note in markdown. Keep only the useful takeaways and next actions. No frontmatter, no wrapper commentary. Respond in ${settings.ui.language === "it" ? "Italian" : "English"}.`,
        },
        { role: "user", content: text },
      ], "chat-resume", { label: "assistant:reply-summary" });
    } catch (err) {
      toast({ title: t("assistant.toastChatSummaryFailed"), description: String(err), variant: "destructive" });
      return null;
    }
  }

  async function deleteCurrentSavedChat() {
    if (!user || !accessToken || !currentSession) return;
    const expectedIdentity = accountIdentity(user);
    const signal = cloudAccountAbortRef.current.signal;
    cancelSessionOperations();
    const fileId = currentSession.fileId;
    if (fileId) await deleteAssistantSession(user.provider, accessToken, fileId, signal);
    if (signal.aborted || !isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
    const state = useAssistantStore.getState();
    state.setSessions(state.sessions.filter((session) => (session.fileId ?? session.id) !== (fileId ?? currentSession.id)));
    setCurrentSession(null);
  }

  async function saveCurrentChatAsNote(options: { mode: "full" | "reply-summary"; deleteAfter?: boolean }) {
    if (!currentSession?.messages.length || !bookId) return;
    if (!branchReady || branchEnsuring) {
      toast({ title: "Copilot branch is not ready", description: branchError ?? `Waiting for branch ${branch}.`, variant: "destructive" });
      return;
    }
    const book = settings.books.find((entry) => entry.id === bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) {
      toast({ title: t("assistant.toastNoBookToken"), variant: "destructive" });
      return;
    }
    const booksState = useBooksStore.getState();
    const routeContext = await loadWriterContext(location.pathname, settings, settings.books, booksState.structures, booksState.workingBranches, branch);
    if (!routeContext.noteTargetPath) {
      toast({ title: t("assistant.toastNoNoteTarget"), variant: "destructive" });
      return;
    }
    const latestReply = [...currentSession.messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
    let noteBody = "";
    if (options.mode === "full") {
      noteBody = [`**Chat:** ${currentSession.title}`, "", buildAssistantSessionMarkdown(currentSession)].join("\n");
    } else {
      if (!latestReply?.text.trim()) {
        toast({ title: t("assistant.noLastReply"), variant: "destructive" });
        return;
      }
      const summary = await summarizeLatestAssistantReplyText(latestReply.text);
      if (!summary) return;
      noteBody = [`**Chat:** ${currentSession.title}`, "", summary.trim()].join("\n");
    }
    setBusy(true);
    try {
      await appendAssistantNote({
        token,
        owner: book.owner,
        repo: book.repo,
        branch: routeContext.branch ?? branch,
        path: routeContext.noteTargetPath,
        noteBody,
      });
      await refreshBookAfterMutation({ book, token, branch: routeContext.branch ?? branch });
      if (options.deleteAfter) await deleteCurrentSavedChat();
      toast({ title: t("assistant.toastChatNoteSaved") });
    } catch (err) {
      toast({ title: t("assistant.toastChatNoteSaveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrentChat(options: { format: "markdown" | "pdf"; destination: "download" | "drive" }) {
    if (!currentSession) return;
    const baseName = sessionFileBaseName(currentSession);
    setBusy(true);
    try {
      const markdown = buildAssistantSessionMarkdown(currentSession);
      const artifact = options.format === "markdown"
        ? { fileName: `${baseName}.md`, mimeType: "text/markdown", blob: new Blob([markdown], { type: "text/markdown;charset=utf-8" }) }
        : { fileName: `${baseName}.pdf`, mimeType: "application/pdf", blob: await buildAssistantSessionPdfBlob(currentSession) };

      if (options.destination === "download") {
        downloadBlob(artifact.fileName, artifact.blob);
      } else {
        if (!bookId) throw new Error(t("assistant.toastChatDriveBookRequired"));
        const book = settings.books.find((entry) => entry.id === bookId);
        if (!book || !user || !accessToken) throw new Error(t("assistant.toastChatDriveUnavailable"));
        const exportSettings = resolveBookExportSettings(book);
        if (user.provider === "google" && !exportSettings.googleDriveFolderId) throw new Error(t("assistant.toastChatDriveTargetMissing"));
        if (user.provider === "microsoft" && !exportSettings.microsoftDriveFolderPath) throw new Error(t("assistant.toastChatDriveTargetMissing"));
        await uploadDriveFile(user.provider, accessToken, {
          googleFolderId: exportSettings.googleDriveFolderId,
          microsoftFolderPath: exportSettings.microsoftDriveFolderPath,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          blob: artifact.blob,
        });
      }
      toast({ title: options.destination === "download" ? t("assistant.toastChatExported") : t("assistant.toastChatSavedToDrive") });
    } catch (err) {
      toast({ title: t("assistant.toastChatExportFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleVoiceTranscript(transcript: string, generation: number, signal: AbortSignal) {
    if (!ownsMediaOperation(generation, signal)) return;
    setLastVoiceTranscript(transcript);
    setVoiceStatus("thinking");
    startWaitingTone();
    const reply = await sendPrompt(transcript, { spokenMode: true, signal });
    if (!ownsMediaOperation(generation, signal)) return;
    stopWaitingTone();
    if (!voiceModeRef.current) return;
    if (localAudioHandledRef.current) {
      await localAudioDoneRef.current?.catch(() => undefined);
      if (!ownsMediaOperation(generation, signal)) return;
      localAudioHandledRef.current = false;
      localAudioDoneRef.current = null;
      if (voiceModeRef.current) setVoiceStatus("idle");
      return;
    }
    if (reply?.text && !localAudioHandledRef.current) {
      setVoiceStatus("speaking");
      const controller = await readText(reply.text);
      await controller?.done.catch(() => undefined);
      if (!ownsMediaOperation(generation, signal)) return;
    }
    localAudioHandledRef.current = false;
    if (voiceModeRef.current) setVoiceStatus("idle");
  }

  function toggleVoiceMode() {
    setVoiceMode((enabled) => {
      const next = !enabled;
      voiceModeRef.current = next;
      if (!next) {
        cancelMediaOperations();
        setVoiceStatus("idle");
      } else {
        beginMediaOperation();
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
    cancelMediaOperations();
  }

  function closeAssistant() {
    cancelMediaOperations({ disableVoice: true });
    cancelSessionOperations();
    setOpen(false);
  }

  function openAssistantChat() {
    cancelMediaOperations({ disableVoice: true });
    setOpen(true);
  }

  function openAssistantVoice() {
    cancelMediaOperations();
    voiceModeRef.current = true;
    setVoiceMode(true);
    beginMediaOperation();
    setOpen(true);
  }

  async function sendPrompt(prompt: string, options?: { spokenMode?: boolean; signal?: AbortSignal; attachmentTarget?: AttachmentImportTarget }): Promise<AssistantMessage | null> {
    const trimmed = prompt.trim();
    if (!trimmed || useAssistantStore.getState().busy) return null;
    if (bookId && (!branchReady || branchEnsuring)) {
      toast({ title: "Copilot branch is not ready", description: branchError ?? `Waiting for branch ${branch} to finish loading.`, variant: "destructive" });
      return null;
    }
    const session = ensureSession();
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (options?.signal?.aborted) controller.abort();
    else options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (controller.signal.aborted) return null;
    activePromptRef.current = { requestId, sessionId: session.id, controller };
    const ownsRequest = () => isAssistantRequestOwned(
      activePromptRef.current,
      requestId,
      session.id,
      useAssistantStore.getState().currentSession?.id,
      controller.signal.aborted,
    );
    const mediaOperation = options?.spokenMode && options.signal
      ? { generation: mediaGenerationRef.current, signal: options.signal }
      : undefined;
    setBusy(true);
    localAudioHandledRef.current = false;
    let streamedMessageId: string | null = null;
    const updateStreamedReply = (text: string) => {
      if (!ownsRequest()) return;
      if (!text && !streamedMessageId) return;
      if (!streamedMessageId) {
        streamedMessageId = crypto.randomUUID();
        const streamedMessage: AssistantMessage = { id: streamedMessageId, role: "assistant", text, branch };
        useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, updatedAt: new Date().toISOString(), messages: [...current.messages, streamedMessage] }));
      } else {
        useAssistantStore.getState().updateSessionMessage(session.id, streamedMessageId, { text });
      }
    };
    try {
      const booksState = useBooksStore.getState();
      const routeContext = await loadWriterContext(location.pathname, settings, settings.books, booksState.structures, booksState.workingBranches, branch);
      if (!ownsRequest()) return null;
      const book = routeContext.book;
      const token = book ? resolveBookToken(book, settings) : "";
      const userMessage = { id: crypto.randomUUID(), role: "user" as const, text: trimmed };
      useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, userMessage] }));
      setDraft("");
      const strofaReply = await tryHandleStrofaCommand(trimmed, mediaOperation);
      if (!ownsRequest()) return null;
      if (strofaReply) {
        const ownedReply = { ...strofaReply, branch: routeContext.branch };
        useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, ownedReply] }));
        setOpen(true);
        return ownedReply;
      }
      const localReply = await tryHandleLocalVoiceTool(trimmed, { context: routeContext, book, token, spokenMode: options?.spokenMode, operation: mediaOperation });
      if (!ownsRequest()) return null;
      if (localReply) {
        const ownedReply = { ...localReply, branch: routeContext.branch, action: localReply.action ? { ...localReply.action, branch: routeContext.branch } : undefined };
        useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, ownedReply] }));
        setOpen(true);
        return ownedReply;
      }
      const latestSession = useAssistantStore.getState().currentSession;
      if (!latestSession || latestSession.id !== session.id) return null;
      const reply = await runPromptWithMutationRefresh(() => runAssistantPrompt({
        prompt: trimmed,
        context: routeContext,
        settings,
        book,
        branch,
        token,
        history: latestSession.messages,
        compactSummary: latestSession.compactSummary,
        compactedMessageCount: latestSession.compactedMessageCount,
        attachments: latestSession.attachments,
        attachmentTarget: options?.attachmentTarget,
        spokenMode: options?.spokenMode,
        signal: controller.signal,
        onText: updateStreamedReply,
      }), async () => {
        if (book) await refreshBookAfterMutation({ book, token, branch: routeContext.branch ?? branch });
      });
      if (!ownsRequest()) return null;
      const ownedReply = { ...reply, branch: routeContext.branch, action: reply.action ? { ...reply.action, branch: reply.action.branch ?? routeContext.branch } : undefined };
      const finalReply = streamedMessageId ? { ...ownedReply, id: streamedMessageId } : ownedReply;
      if (streamedMessageId) {
        useAssistantStore.getState().updateSessionMessage(session.id, streamedMessageId, { text: ownedReply.text, action: ownedReply.action, branch: ownedReply.branch, mutation: ownedReply.mutation });
      } else {
        useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, contextTitle: routeContext.title, updatedAt: new Date().toISOString(), messages: [...current.messages, ownedReply] }));
      }
      setOpen(true);
      if (reply.action?.kind === "navigate" && isAssistantActionEnabled(reply.action)) {
        await executeNavigationAction(reply.action);
      } else if (reply.action?.kind === "read-aloud" && book && token && isAssistantActionEnabled(reply.action)) {
        const readBranch = routeContext.structure?.loadedBranch ?? branch;
        await speakReadAloud(reply.action, book, token, readBranch, mediaOperation);
      }
      return finalReply;
    } catch (err) {
      if (!ownsRequest()) return null;
      const errorMessage = { id: streamedMessageId ?? crypto.randomUUID(), role: "assistant" as const, text: err instanceof Error ? err.message : t("assistant.requestFailed"), branch };
      if (streamedMessageId) useAssistantStore.getState().updateSessionMessage(session.id, streamedMessageId, { text: errorMessage.text, branch });
      else useAssistantStore.getState().updateSession(session.id, (current) => ({ ...current, updatedAt: new Date().toISOString(), messages: [...current.messages, errorMessage] }));
      return errorMessage;
    } finally {
      options?.signal?.removeEventListener("abort", abortFromCaller);
      if (activePromptRef.current?.requestId === requestId) {
        activePromptRef.current = null;
        setBusy(false);
      }
    }
  }

  async function tryHandleLocalVoiceTool(
    prompt: string,
    input: {
      context: Awaited<ReturnType<typeof loadWriterContext>>;
      book: Awaited<ReturnType<typeof loadWriterContext>>["book"];
      token: string;
      spokenMode?: boolean;
      operation?: MediaOperation;
    },
  ): Promise<AssistantMessage | null> {
    if (!input.book || !input.token || !input.context.structure) return null;

    // No-LLM navigation: "apri il reader", "vai al capitolo 3", "open research".
    const navAction = resolveNavigateAction(prompt, input.context, input.book.id);
    if (navAction && isAssistantActionEnabled(navAction)) {
      navigate(navAction.to);
      const reply = makeAssistantReply(t("assistant.navigatingTo", { target: navAction.label ?? navAction.to }));
      reply.action = navAction;
      return reply;
    }

    // No-LLM read-aloud: "leggi questo paragrafo", "read chapter 3".
    const readAction = resolveReadAloudAction(prompt, input.context, input.book.id);
    if (readAction && isAssistantActionEnabled(readAction)) {
      const spoke = await speakReadAloud(readAction, input.book, input.token, input.context.structure.loadedBranch, input.operation);
      if (!spoke) return makeAssistantReply(t("assistant.readTargetEmpty"));
      const reply = makeAssistantReply(t("assistant.readingTarget", { title: readAction.title }));
      reply.action = readAction;
      return reply;
    }

    return null;
  }

  /** Load the read-aloud target paths and speak them via TTS. Returns false when there is nothing to read. */
  async function speakReadAloud(
    action: ReadAloudAction,
    book: NonNullable<Awaited<ReturnType<typeof loadWriterContext>>["book"]>,
    token: string,
    readBranch: string,
    requestedOperation?: MediaOperation,
  ): Promise<boolean> {
    const operation = requestedOperation ?? (voiceModeRef.current ? currentMediaOperation() : beginMediaOperation());
    if (!ownsMediaOperation(operation.generation, operation.signal)) return false;
    const raws = await Promise.all(action.paths.map((path) => loadFileContent(token, book.owner, book.repo, path, readBranch)));
    if (!ownsMediaOperation(operation.generation, operation.signal)) return false;
    const text = raws
      .map((raw) => (action.includeFrontmatter ? raw.trim() : stripFrontmatterForSpeech(raw)))
      .filter(Boolean)
      .join("\n\n");
    if (!text.trim()) return false;
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText(text, { operation });
    if (!controller) return false;
    if (!ownsMediaOperation(operation.generation, operation.signal)) {
      controller.stop();
      return false;
    }
    localAudioDoneRef.current = controller.done;
    return true;
  }

  /** Re-run a read-aloud action attached to a rendered message (manual "play" button). */
  async function replayReadAloud(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "read-aloud") return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    const readBranch = structures[action.bookId]?.loadedBranch ?? branch;
    localAudioHandledRef.current = false;
    const spoke = await speakReadAloud(action, book, token, readBranch);
    if (!spoke) toast({ title: t("assistant.readTargetEmpty") });
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
  async function tryHandleStrofaCommand(prompt: string, operation?: MediaOperation): Promise<AssistantMessage | null> {
    if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    const lower = prompt.toLowerCase().trim();

    // 1) Confirmation of a pending rewrite proposal.
    if (pendingRewriteRef.current) {
      const yes = /\b(s[iì]|sì|ok|va bene|conferma|sostituisci|yes|sure|replace|confirm)\b/.test(lower);
      const no = /\b(no|annulla|lascia|cancel|keep|stop)\b/.test(lower);
      if (yes) return applyPendingRewrite(operation);
      if (no) {
        pendingRewriteRef.current = null;
        return makeAssistantReply(t("assistant.rewriteCancelled"));
      }
      // Ambiguous → ask the cheap "simple-tasks" model with a forced tool to decide.
      const decision = await classifyConfirmationRouted(settings, prompt);
      if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
      if (decision === "yes") return applyPendingRewrite(operation);
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
      return proposeRewrite(window, { synonymWord: synonymMatch?.[1]?.trim(), instruction: prompt }, operation);
    }

    // 3) Repeat / read back recent strofe.
    const wantsRepeat = /\b(ripeti|rileggi|rip[eé]tere|ridimmi|dimmi|cosa hai detto|che hai detto|repeat|read again|say again|what did you say)\b/.test(lower);
    if (wantsRepeat && window) {
      const text = strofeSlice(window);
      if (!text) return makeAssistantReply(t("assistant.strofaEmpty"));
      localAudioHandledRef.current = true;
      setVoiceStatus("speaking");
      const controller = await readText(text, { operation });
      if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
      localAudioDoneRef.current = controller?.done ?? Promise.resolve();
      return makeAssistantReply(text);
    }

    return null;
  }

  /** Ask the LLM to rewrite the selected strofe; speak the proposal and await confirmation. */
  async function proposeRewrite(
    window: { from: number; to: number },
    opts: { synonymWord?: string; instruction: string },
    operation?: MediaOperation,
  ): Promise<AssistantMessage | null> {
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
      rewritten = (await completeTextRouted(settings, [
        { role: "system", content: `You are a prose editor. ${task} Reply with ONLY the rewritten passage in ${langName}, no quotes, no preamble.` },
        { role: "user", content: original },
      ], "default", { label: "live-voice:rewrite", signal: operation?.signal })).trim();
      if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    } catch (err) {
      if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
      stopWaitingTone();
      if (/No AI integration configured/i.test(err instanceof Error ? err.message : String(err))) return makeAssistantReply(t("assistant.rewriteNoModel"));
      return makeAssistantReply(t("assistant.rewriteFailed", { error: String(err) }));
    }
    if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    stopWaitingTone();
    if (!rewritten) return makeAssistantReply(t("assistant.rewriteFailed", { error: "empty" }));
    const newSegments = splitIntoStrofe(rewritten);
    pendingRewriteRef.current = { from: window.from, to: window.to, segments: newSegments };
    const spoken = `${t("assistant.rewriteProposal")} ${rewritten} ${t("assistant.rewriteConfirmAsk")}`;
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText(spoken, { operation });
    if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    localAudioDoneRef.current = controller?.done ?? Promise.resolve();
    return makeAssistantReply(spoken);
  }

  /** Replace the proposed strofe in memory and resume reading from there. */
  async function applyPendingRewrite(operation?: MediaOperation): Promise<AssistantMessage | null> {
    if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    const pending = pendingRewriteRef.current;
    pendingRewriteRef.current = null;
    if (!pending) return makeAssistantReply(t("assistant.rewriteCancelled"));
    const segments = [...liveStrofeRef.current];
    segments.splice(pending.from, pending.to - pending.from + 1, ...pending.segments);
    liveStrofeRef.current = segments;
    setLiveStrofeCount(segments.length);
    localAudioHandledRef.current = true;
    setVoiceStatus("speaking");
    const controller = await readText("", { segments, startIndex: pending.from, operation });
    if (operation && !ownsMediaOperation(operation.generation, operation.signal)) return null;
    localAudioDoneRef.current = controller?.done ?? Promise.resolve();
    return makeAssistantReply(t("assistant.rewriteApplied"));
  }

  function stripFrontmatterForSpeech(raw: string): string {
    return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  }

  function buildAttachmentImportPrompt(): string {
    return "Import the attached files into the selected target in the current book context.";
  }

  async function handleImportAttachments() {
    if (!(currentSession?.attachments.length ?? 0)) {
      toast({ title: t("assistant.toastNoAttachments"), description: t("assistant.attachFirst") });
      return;
    }
    await sendPrompt(buildAttachmentImportPrompt(), { attachmentTarget });
  }

  async function openSession(fileId: string) {
    if (!user || !accessToken) return;
    cancelSessionOperations();
    const runId = ++openSessionRunRef.current;
    const controller = new AbortController();
    openSessionAbortRef.current = controller;
    activeOpenSessionRunRef.current = runId;
    setBusy(true);
    try {
      const session = await loadAssistantSession(user.provider, accessToken, fileId, controller.signal);
      if (controller.signal.aborted || activeOpenSessionRunRef.current !== runId) return;
      setCurrentSession(session);
      setOpen(true);
    } catch (err) {
      if (activeOpenSessionRunRef.current === runId) {
        toast({ title: t("assistant.toastOpenChatFailed"), description: String(err), variant: "destructive" });
      }
    } finally {
      if (activeOpenSessionRunRef.current === runId) {
        activeOpenSessionRunRef.current = null;
        openSessionAbortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function deleteSavedSession(session: AssistantSessionMeta) {
    const fileId = session.fileId;
    if (!user || !accessToken || !fileId) return;
    if (!window.confirm(t("assistant.deleteChatConfirm", { title: session.title || t("assistant.untitledChat") }))) return;
    const expectedIdentity = accountIdentity(user);
    const signal = cloudAccountAbortRef.current.signal;
    try {
      await deleteAssistantSession(user.provider, accessToken, fileId, signal);
      if (signal.aborted || !isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
      const state = useAssistantStore.getState();
      state.setSessions(state.sessions.filter((entry) => entry.fileId !== fileId));
      if (useAssistantStore.getState().currentSession?.fileId === fileId) {
        cancelSessionOperations();
        setCurrentSession(null);
      }
      toast({ title: t("assistant.toastChatDeleted") });
    } catch (err) {
      if (!signal.aborted && isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) {
        toast({ title: t("assistant.toastDeleteChatFailed"), description: String(err), variant: "destructive" });
      }
    }
  }

  async function validatePersistedMutation(
    action: NonNullable<AssistantMessage["action"]>,
    book: (typeof settings.books)[number],
    token: string,
  ): Promise<boolean> {
    const toolId = assistantActionToolId(action);
    const toolEnabled = Boolean(toolId && isCopilotToolIdEnabled(useSettingsStore.getState().settings, toolId));
    const fail = (reason: string) => {
      const language = useSettingsStore.getState().settings.ui.language;
      const staleMessage = useAssistantStore.getState().currentSession?.messages.find((message) => message.action === action);
      if (staleMessage) {
        useAssistantStore.getState().updateMessage(staleMessage.id, {
          action: undefined,
          text: `${staleMessage.text}\n\n${language === "it" ? "Questa azione non è più valida. Rivedi il contesto e genera una nuova proposta." : "This action is no longer valid. Review the context and generate a new proposal."}`,
        });
      }
      toast({
        title: language === "it" ? "Azione del Copilota non più valida" : "Copilot action is no longer valid",
        description: language === "it"
          ? `La provenienza dell'azione non corrisponde più allo stato corrente (${reason}). Rivedi il contesto e genera una nuova proposta.`
          : `The action provenance no longer matches the current state (${reason}). Review the context and generate a new proposal.`,
        variant: "destructive",
      });
      return false;
    };
    if (!hasAssistantActionProvenance(action)) return fail("missing-provenance");

    const scopeFailure = validateAssistantAction({
      action,
      owner: book.owner,
      repo: book.repo,
      branch,
      expectedToolId: toolId,
      toolEnabled,
      sourceRevision: action.sourceRevision,
    });
    if (scopeFailure) return fail(scopeFailure);
    if (action.kind === "apply-file-updates" || action.kind === "undo-file-updates") return true;

    let currentRevision: string;
    const paths = Object.keys(action.sourceRevisions);
    if (paths.length) {
      const revisions: Record<string, string | null> = {};
      try {
        await Promise.all(paths.map(async (path) => {
          const current = await readFileWithSha(token, book.owner, book.repo, branch, path).catch((error) => {
            if (isGitHubFileNotFoundError(error)) return null;
            throw error;
          });
          const contentHash = current ? await sha256Text(current.content) : null;
          revisions[path] = currentRevisionToken(action.sourceRevisions[path], current?.sha ?? null, contentHash);
        }));
      } catch {
        return fail("source-unavailable");
      }
      currentRevision = sourceRevisionFromFiles(revisions);
    } else {
      const revisionBranch = action.kind === "switch-book-branch" && action.createIfMissing ? action.baseBranch ?? "main" : branch;
      const latestCommit = (await listBranchCommits(token, book.owner, book.repo, revisionBranch).catch(() => []))[0]?.sha;
      if (!latestCommit) return fail("source-unavailable");
      currentRevision = latestCommit;
    }
    const revisionFailure = validateAssistantAction({
      action,
      owner: book.owner,
      repo: book.repo,
      branch,
      expectedToolId: toolId,
      toolEnabled,
      sourceRevision: currentRevision,
    });
    return revisionFailure ? fail(revisionFailure) : true;
  }

  async function executeNavigationAction(action: NonNullable<AssistantMessage["action"]>) {
    if (action.kind !== "navigate") return;
    const toolId = assistantActionToolId(action);
    const tool = toolId ? copilotToolRegistry.get(toolId) : undefined;
    if (tool?.mutatesData) {
      const book = hasAssistantActionProvenance(action)
        ? settings.books.find((entry) => entry.owner.toLowerCase() === action.owner.toLowerCase() && entry.repo.toLowerCase() === action.repo.toLowerCase())
        : undefined;
      const token = book ? resolveBookToken(book, settings) : "";
      if (!book || !token || !await validatePersistedMutation(action, book, token)) return;
    }
    navigate(action.to);
  }

  async function applyRewrite(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "apply-paragraph-rewrite") return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    if (!await validatePersistedMutation(action, book, token)) return;
    setBusy(true);
    try {
      await applyParagraphRewrite({ action, book, branch, token });
      await refreshBookAfterMutation({ book, token, branch });
      useAssistantStore.getState().updateMessage(message.id, { mutation: { changedPaths: [action.paragraphPath], refresh: "book-structure-and-context" } });
      toast({ title: t("assistant.toastParagraphUpdated") });
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
    if (!requireAssistantActionEnabled(action)) return;
    const updates = pendingFileUpdates(action.updates, selectedPaths);
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token || updates.length === 0) return;
    if (!await validatePersistedMutation(action, book, token)) return;
    setBusy(true);
    try {
      const currentFiles = await Promise.all(updates.map((update) => optionalRepositoryRead(() => readFileWithSha(token, book.owner, book.repo, branch, update.path))));
      const results: Record<string, { previousContent: string | null; appliedHash: string }> = {};
      const mutations = await Promise.all(updates.map(async (update, index) => {
        const current = currentFiles[index];
        const currentHash = current ? await sha256Text(current.content) : null;
        if (!fileRevisionMatches(action.sourceRevisions?.[update.path], current?.sha ?? null, currentHash)) throw new RepositoryConflictError(`Source changed before applying ${update.path}.`, update.path);
        results[update.path] = { previousContent: current?.content ?? null, appliedHash: await sha256Text(update.content) };
        return { path: update.path, content: update.content, expectedCurrentHash: currentHash };
      }));
      const expectedRemoteHeadSha = await resolveRepositoryHeadForMutation({ token, book, branch });
      await commitAndPushTextFileMutation({ token, book, branch, expectedRemoteHeadSha, mutations, message: `Apply ${updates.length} Copilot file update${updates.length === 1 ? "" : "s"}` });
      await refreshBookAfterMutation({ book, token, branch });
      const nextUpdates = markFileUpdatesApplied(action.updates, results);
      const nextRevisions = { ...action.sourceRevisions };
      for (const update of updates) nextRevisions[update.path] = results[update.path].appliedHash;
      const allApplied = nextUpdates.every((update) => update.status === "applied");
      useAssistantStore.getState().updateMessage(message.id, {
        text: `${message.text}\n\n${t("assistant.appliedFileChanges", { count: updates.length })}`,
        mutation: { changedPaths: updates.map((update) => update.path).sort(), refresh: "book-structure-and-context" },
        action: {
          kind: allApplied ? "undo-file-updates" : "apply-file-updates",
          bookId: action.bookId,
          updates: nextUpdates,
          toolId: action.toolId,
          owner: action.owner,
          repo: action.repo,
          branch: action.branch,
          sourceRevision: sourceRevisionFromFiles(nextRevisions),
          sourceRevisions: nextRevisions,
          generatedAt: new Date().toISOString(),
        },
      });
      toast({ title: t("assistant.toastFileUpdatesApplied") });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const conflictPath = err instanceof RepositoryConflictError ? err.path : undefined;
      const failedPaths = conflictPath ? [conflictPath] : updates.map((update) => update.path);
      const nextUpdates = markFileUpdatesFailed(action.updates, failedPaths, error);
      const counts = fileUpdateCounts(nextUpdates);
      useAssistantStore.getState().updateMessage(message.id, { action: { ...action, updates: nextUpdates }, text: `${message.text}\n\nCompleted: ${counts.applied}; pending: ${counts.pending}; failed: ${counts.failed}.` });
      toast({ title: t("assistant.toastFileUpdatesFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function applyBranchSwitch(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "switch-book-branch") return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    if (!await validatePersistedMutation(action, book, token)) return;
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

  async function confirmDeleteAction(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "confirm-delete") return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    if (!await validatePersistedMutation(action, book, token)) return;
    setBusy(true);
    try {
      if (action.target === "paragraph") {
        const structure = structures[action.bookId];
        const chapter = structure?.chapters.find((entry) => entry.slug === action.chapterSlug);
        if (!chapter) throw new Error("Chapter not found for paragraph deletion.");
        const remaining = chapter.paragraphs.filter((paragraph) => paragraph.path !== action.path);
        await reorderParagraphsInChapter(token, book.owner, book.repo, branch, chapter.path, chapter.paragraphs, remaining, `Delete paragraph: ${action.title}`);
      } else {
        const existing = await optionalRepositoryRead(() => readFileWithSha(token, book.owner, book.repo, branch, action.path));
        if (existing) await deleteFile(token, book.owner, book.repo, branch, action.path, existing.sha, `Delete ${action.target}: ${action.title}`);
      }
      useAssistantStore.getState().updateMessage(message.id, { action: undefined, text: `${message.text}\n\n${t("assistant.deleteApplied")}`, mutation: { changedPaths: [action.path], refresh: "book-structure-and-context" } });
      toast({ title: t("assistant.toastDeleted", { title: action.title }) });
      await refreshBookAfterMutation({ book, token, branch });
    } catch (err) {
      toast({ title: t("assistant.toastDeleteFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreateFromResearch(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || message.action.kind !== "confirm-create-from-research") return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token || !await validatePersistedMutation(action, book, token)) return;
    setBusy(true);
    try {
      const document = buildCanonEntityDocument({ kind: action.entityKind, label: action.label, body: action.body, extraFrontmatter: action.extraFrontmatter });
      if (document.path !== action.destinationPath) throw new Error("The generated entity destination changed before confirmation.");
      const expectedRemoteHeadSha = await resolveRepositoryHeadForMutation({ token, book, branch });
      await commitAndPushTextFileMutation({ token, book, branch, expectedRemoteHeadSha, mutations: [{ path: document.path, content: document.content, expectedCurrentHash: null }], message: `Add ${action.entityKind} ${action.label} from ${action.researchPath}` });
      useAssistantStore.getState().updateMessage(message.id, { action: undefined, text: `${message.text}\n\n${t("assistant.createFromResearchApplied")}`, mutation: { changedPaths: [document.path], refresh: "book-structure-and-context" } });
      await refreshBookAfterMutation({ book, token, branch });
      toast({ title: t("assistant.toastCreatedFromResearch", { title: action.label }) });
    } catch (err) {
      toast({ title: t("assistant.toastCreateFromResearchFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function undoFileUpdates(messageIndex: number) {
    const message = currentSession?.messages[messageIndex];
    if (!message?.action || (message.action.kind !== "undo-file-updates" && message.action.kind !== "apply-file-updates")) return;
    const action = message.action;
    if (!requireAssistantActionEnabled(action)) return;
    const book = settings.books.find((entry) => entry.id === action.bookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    if (!await validatePersistedMutation(action, book, token)) return;
    setBusy(true);
    try {
      const applied = action.updates.filter((update) => update.status === "applied" || update.appliedHash);
      if (!applied.length) throw new Error("No applied file updates are available to undo.");
      const currentFiles = await Promise.all(applied.map((update) => readFileWithSha(token, book.owner, book.repo, branch, update.path)));
      const mutations = await Promise.all(applied.map(async (update, index) => {
        const current = currentFiles[index];
        if (!update.appliedHash || !current || await sha256Text(current.content) !== update.appliedHash) throw new Error(`Source changed before undoing ${update.path}.`);
        return { path: update.path, content: update.previousContent ?? null, expectedCurrentHash: update.appliedHash };
      }));
      const expectedRemoteHeadSha = await resolveRepositoryHeadForMutation({ token, book, branch });
      await commitAndPushTextFileMutation({ token, book, branch, expectedRemoteHeadSha, mutations, message: `Undo ${applied.length} Copilot file update${applied.length === 1 ? "" : "s"}` });
      await refreshBookAfterMutation({ book, token, branch });
      const nextUpdates = markFileUpdatesUndone(action.updates, applied.map((update) => update.path));
      const nextRevisions = { ...action.sourceRevisions };
      await Promise.all(applied.map(async (update) => { nextRevisions[update.path] = update.previousContent == null ? null : await sha256Text(update.previousContent); }));
      useAssistantStore.getState().updateMessage(message.id, { action: { ...action, kind: "apply-file-updates", updates: nextUpdates, sourceRevision: sourceRevisionFromFiles(nextRevisions), sourceRevisions: nextRevisions, generatedAt: new Date().toISOString() }, text: `${message.text}\n\n${t("assistant.undoApplied")}`, mutation: { changedPaths: applied.map((update) => update.path).sort(), refresh: "book-structure-and-context" } });
      toast({ title: t("assistant.toastUndoApplied") });
    } catch (err) {
      toast({ title: t("assistant.toastUndoFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function loadBranchDiff() {
    if (!requireCopilotToolEnabled("show-branch-diff")) return;
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
    if (!requireCopilotToolEnabled("show-branch-diff")) return;
    if (!bookId) return;
    const book = settings.books.find((entry) => entry.id === bookId);
    const structure = structures[bookId];
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !structure || !token) return;
    setBusy(true);
    try {
      await revertFileToRef(token, book.owner, book.repo, branch, file.filename, structure.defaultBranch);
      await refreshBookAfterMutation({ book, token, branch });
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
          const existing = await optionalRepositoryRead(() => readFileWithSha(token, book.owner, book.repo, branch, update.path));
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
    const hasChatMessages = Boolean(currentSession?.messages.length);

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

    actions.push({ id: "note", labelKey: "assistant.actions.saveNote", icon: FileText, run: ask("Create a writer note from the current context and save it."), disabled: !hasChatMessages });
    if (bookId) actions.push({ id: "diff", labelKey: "assistant.actions.syncDiff", icon: GitBranch, run: () => void loadBranchDiff(), disabled: loadingDiff });
    return actions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, bookId, loadingDiff, currentSession?.messages.length]);

  function isAssistantActionEnabled(action: NonNullable<AssistantMessage["action"]>): boolean {
    const currentSettings = useSettingsStore.getState().settings;
    return policyTargetEnabled(assistantActionToolId(action), (toolId) => isCopilotToolIdEnabled(currentSettings, toolId));
  }

  function requireCopilotToolEnabled(toolId: string | null): boolean {
    if (toolId && isCopilotToolIdEnabled(useSettingsStore.getState().settings, toolId)) return true;
    const language = useSettingsStore.getState().settings.ui.language;
    toast({
      title: language === "it" ? "Tool del Copilota disabilitato" : "Copilot tool disabled",
      description: language === "it"
        ? "Puoi riattivarlo in Impostazioni > Tools for Copilot."
        : "You can enable it again under Settings > Tools for Copilot.",
      variant: "destructive",
    });
    return false;
  }

  function requireAssistantActionEnabled(action: NonNullable<AssistantMessage["action"]>): boolean {
    return requireCopilotToolEnabled(assistantActionToolId(action));
  }

  const syncPanel = (
    <div className="flex h-full min-h-0 flex-col bg-card" onDragOver={handleDragOver} onDrop={handleDrop}>
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
            {message.role === "user" ? (
              <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm whitespace-pre-wrap">{message.text}</div>
            ) : (
              <div className="rounded-2xl rounded-bl-sm border bg-background px-4 py-3 shadow-sm">
                <div className="doc-prose max-w-none text-sm leading-7" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(message.text) }} />
              </div>
            )}
            {message.role === "assistant" && message.text.trim() && (
              <div className="mt-1 flex items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
                      <Copy className="h-3.5 w-3.5" />{t("assistant.copyMessage")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => void copyAssistantMessage(message.text, "markdown")}>{t("assistant.copyMarkdown")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void copyAssistantMessage(message.text, "formatted")}>{t("assistant.copyFormatted")}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => void readText(message.text)}>
                  <Volume2 className="h-3.5 w-3.5" />{t("assistant.listenMessage")}
                </Button>
              </div>
            )}
            {message.action?.kind === "switch-book-branch" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{t("assistant.branchActionReady")}</Badge>
                <Button size="sm" onClick={() => void applyBranchSwitch(index)} disabled={busy || !isAssistantActionEnabled(message.action)}><GitBranch className="mr-1 h-4 w-4" />{t("assistant.applyBranch")}</Button>
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
                        <summary className="cursor-pointer font-mono">{update.path} · {update.status ?? "pending"}</summary>
                        {update.reason && <p className="mt-2 text-muted-foreground">{update.reason}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => void toggleDiff(message.id, update)} disabled={loadingDiffPath === diffKey}>
                            {loadingDiffPath === diffKey ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                            {showDiff ? t("assistant.hideDiff") : t("assistant.showDiff")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void applySelectedFileUpdates(index, [update.path])} disabled={busy || update.status === "applied" || !isAssistantActionEnabled(message.action!)}>{t("assistant.applyThisFile")}</Button>
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
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void applySelectedFileUpdates(index)} disabled={busy || !message.action.updates.some((update) => update.status !== "applied") || !isAssistantActionEnabled(message.action)}>{t("assistant.applyAllFiles")}</Button>
                  {message.action.updates.some((update) => update.status === "applied") && <Button size="sm" variant="outline" onClick={() => void undoFileUpdates(index)} disabled={busy}>{t("assistant.undoChanges")}</Button>}
                </div>
              </div>
            )}
            {message.action?.kind === "undo-file-updates" && <div className="mt-2 flex items-center gap-2"><Badge variant="secondary">{t("assistant.changesApplied")}</Badge><Button size="sm" variant="outline" onClick={() => void undoFileUpdates(index)} disabled={busy || !isAssistantActionEnabled(message.action)}>{t("assistant.undoChanges")}</Button></div>}
            {message.action?.kind === "apply-paragraph-rewrite" && <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="secondary">{t("assistant.rewriteReady")}</Badge><Button size="sm" onClick={() => void applyRewrite(index)} disabled={busy || !isAssistantActionEnabled(message.action)}>{t("assistant.applyToParagraph")}</Button><Button asChild size="sm" variant="outline"><Link to={`/app/books/${message.action.bookId}/chapters/${message.action.chapterSlug}`}>{t("assistant.openChapter")}</Link></Button></div>}
            {message.action?.kind === "navigate" && <div className="mt-2 flex items-center gap-2"><Button size="sm" variant="outline" disabled={!isAssistantActionEnabled(message.action)} onClick={() => void executeNavigationAction(message.action!)}><BookOpen className="mr-1.5 h-3.5 w-3.5" />{message.action.label ?? t("assistant.openLocation")}</Button></div>}
            {message.action?.kind === "read-aloud" && <div className="mt-2 flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void replayReadAloud(index)} disabled={!isAssistantActionEnabled(message.action)}><Play className="mr-1.5 h-3.5 w-3.5" />{t("assistant.playAloud")}</Button></div>}
            {message.action?.kind === "confirm-delete" && <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="destructive">{t("assistant.destructive")}</Badge><Button size="sm" variant="destructive" onClick={() => void confirmDeleteAction(index)} disabled={busy || !isAssistantActionEnabled(message.action)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t("assistant.confirmDelete")}</Button><Button size="sm" variant="outline" onClick={() => useAssistantStore.getState().updateMessage(message.id, { action: undefined })} disabled={busy}>{t("assistant.cancel")}</Button></div>}
            {message.action?.kind === "confirm-create-from-research" && <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => void confirmCreateFromResearch(index)} disabled={busy || !isAssistantActionEnabled(message.action)}><Sparkles className="mr-1.5 h-3.5 w-3.5" />{t("assistant.confirmCreate")}</Button><Button size="sm" variant="outline" onClick={() => useAssistantStore.getState().updateMessage(message.id, { action: undefined })} disabled={busy}>{t("assistant.cancel")}</Button></div>}
          </div>
        </div>
      ))}
      {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("assistant.thinking")}</div>}
      <div ref={messagesEndRef} />
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
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => void deleteSavedSession(session)} aria-label={t("assistant.deleteChat", { title: session.title || t("assistant.untitledChat") })} title={t("assistant.deleteChat", { title: session.title || t("assistant.untitledChat") })}>
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
          <Button variant="ghost" size="icon" className="h-8 w-8" title={t("assistant.close")} onClick={closeAssistant}><X className="h-4 w-4" /></Button>
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
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
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
                    const enabled = isCopilotToolIdEnabled(settings, quickActionToolId(action.id) ?? "");
                    return (
                      <DropdownMenuItem key={action.id} disabled={action.disabled || !enabled} onSelect={() => {
                        if (requireCopilotToolEnabled(quickActionToolId(action.id))) action.run();
                      }}>
                        <Icon className="mr-2 h-4 w-4" />{t(action.labelKey)}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1" title={t("assistant.newChat")} onClick={newChat}>
                <MessageSquarePlus className="h-4 w-4" /><span className="hidden sm:inline">{t("assistant.newChat")}</span>
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1" onClick={speechController ? stopReading : () => void readLastAssistantReply()}>
                {speechController ? <Square className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                <span className="hidden sm:inline">{speechController ? t("assistant.stopReading") : t("assistant.read")}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1" disabled={!currentSession?.messages.length || busy}>
                    <FileText className="h-4 w-4" />{t("assistant.chatActions")}<ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs">{currentSession?.title ?? t("assistant.title")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void saveCurrentChatAsNote({ mode: "full" })}>{t("assistant.saveFullChatToNote")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void saveCurrentChatAsNote({ mode: "full", deleteAfter: true })}>{t("assistant.saveFullChatToNoteAndDelete")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void saveCurrentChatAsNote({ mode: "reply-summary" })}>{t("assistant.saveReplySummaryToNote")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void saveCurrentChatAsNote({ mode: "reply-summary", deleteAfter: true })}>{t("assistant.saveReplySummaryToNoteAndDelete")}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void exportCurrentChat({ format: "markdown", destination: "download" })}><Download className="mr-2 h-4 w-4" />{t("assistant.downloadChatMarkdown")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportCurrentChat({ format: "pdf", destination: "download" })}><Download className="mr-2 h-4 w-4" />{t("assistant.downloadChatPdf")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportCurrentChat({ format: "markdown", destination: "drive" })}><FileText className="mr-2 h-4 w-4" />{t("assistant.saveChatMarkdownToDrive")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportCurrentChat({ format: "pdf", destination: "drive" })}><FileText className="mr-2 h-4 w-4" />{t("assistant.saveChatPdfToDrive")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="ml-auto h-8 max-w-full shrink-0 text-xs text-muted-foreground">{t("assistant.contextInspector")}</Button>
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
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendPrompt(draft);
                    }
                  }}
                  placeholder={t("assistant.placeholder")}
                  className="min-h-[76px] resize-none"
                />
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
          <Button variant="ghost" size="sm" onClick={closeAssistant}>{t("assistant.close")}</Button>
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
          <button type="button" className="flex items-center gap-2 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" onClick={openAssistantChat}>
            <Bot className="h-4 w-4" />{t("assistant.floatingButton")}
          </button>
          <span className="w-px self-stretch bg-primary-foreground/20" />
          <button type="button" className="flex items-center justify-center bg-primary px-3 py-2.5 text-primary-foreground transition hover:bg-primary/90" title={t("assistant.liveVoice")} onClick={openAssistantVoice}>
            <Ghost className="h-5 w-5" />
          </button>
        </div>
      )}
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent hideCloseButton className="left-1/2 top-1/2 h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 p-0 sm:w-[920px]">{syncPanel}</DialogContent></Dialog>
      <Dialog open={open} onOpenChange={(next) => { if (!next) closeAssistant(); else setOpen(true); }}><DialogContent hideCloseButton bare onPointerDownOutside={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => event.preventDefault()} className={voiceMode || fullScreen || isMobile ? "left-1/2 top-1/2 h-[96dvh] max-h-[96dvh] w-[98vw] max-w-none -translate-x-1/2 -translate-y-1/2 overflow-hidden" : "bottom-6 right-6 h-[80dvh] max-h-[calc(100dvh-3rem)] w-[420px] max-w-[calc(100vw-3rem)] overflow-hidden"}>{voiceMode ? liveVoicePanel : panel}</DialogContent></Dialog>
    </>
  );
}
