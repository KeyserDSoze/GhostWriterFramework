import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Search, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { createEmptyAssistantSession, useAssistantStore, type AssistantSessionMeta } from "@/assistant/store";
import { refreshAssistantSessionIndex } from "@/assistant/sessionIndex";
import { migrateAssistantChatArchive, readAssistantChatArchiveFile } from "@/assistant/chatArchive";
import { deleteLocalChatSession, loadLocalChatSession, saveLocalChatSession } from "@/assistant/chatLocal";
import { localWorkspaceScope } from "@/account/deviceIdentity";

export function AssistantChatsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { setOpen, setCurrentSession, sessions, sessionsLoading: loading } = useAssistantStore();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const accountRequestsRef = useRef(new Set<AbortController>());
  const importInputRef = useRef<HTMLInputElement>(null);

  const filteredSessions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sessions;
    return sessions.filter((session) =>
      [session.title, session.contextTitle].filter(Boolean).some((value) => value!.toLowerCase().includes(term)),
    );
  }, [sessions, query]);

  useEffect(() => {
    for (const request of accountRequestsRef.current) request.abort();
    accountRequestsRef.current.clear();
    setQuery("");
    setDeleting(null);
    const expectedIdentity = localWorkspaceScope();
    void refreshAssistantSessionIndex(expectedIdentity)
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) toast({ title: t("assistant.toastLoadChatsFailed"), description: String(err), variant: "destructive" });
      });
  }, [toast, t]);

  async function openSession(fileId: string) {
    const controller = new AbortController();
    accountRequestsRef.current.add(controller);
    try {
      const loaded = await loadLocalChatSession(fileId);
      if (controller.signal.aborted) return;
      setCurrentSession(loaded);
      setOpen(true);
    } catch (err) {
      if (!controller.signal.aborted) toast({ title: t("assistant.toastOpenChatFailed"), description: String(err), variant: "destructive" });
    } finally {
      accountRequestsRef.current.delete(controller);
    }
  }

  async function deleteSession(session: AssistantSessionMeta) {
    if (!session.id) return;
    if (!window.confirm(t("assistant.deleteChatConfirm", { title: session.title || t("assistant.untitledChat") }))) return;
    setDeleting(session.id);
    const controller = new AbortController();
    accountRequestsRef.current.add(controller);
    const current = useAssistantStore.getState().currentSession;
    const deletingCurrent = current?.id === session.id || current?.fileId === session.fileId;
    try {
      if (deletingCurrent) useAssistantStore.getState().setCurrentSession(null);
      await deleteLocalChatSession(session.id);
      if (!controller.signal.aborted) {
        const state = useAssistantStore.getState();
        state.setSessions(state.sessions.filter((entry) => entry.id !== session.id));
      }
    } catch (err) {
      if (deletingCurrent && current) useAssistantStore.getState().setCurrentSession(current);
      if (!controller.signal.aborted) toast({ title: t("assistant.toastDeleteChatFailed"), description: String(err), variant: "destructive" });
    } finally {
      accountRequestsRef.current.delete(controller);
      if (!controller.signal.aborted) setDeleting(null);
    }
  }

  async function importArchive(file: File | undefined) {
    if (!file) return;
    const controller = new AbortController();
    accountRequestsRef.current.add(controller);
    const isCurrent = () => !controller.signal.aborted;
    try {
      const archive = await readAssistantChatArchiveFile(file);
      if (!isCurrent()) return;
      let knownIds = sessions.map((entry) => entry.id);
      let imported = await migrateAssistantChatArchive(archive, knownIds);
      for (let attempt = 0; ; attempt += 1) {
        if (!isCurrent()) return;
        try { await saveLocalChatSession(imported); break; }
        catch (error) {
          if (attempt >= 2 || !(error && typeof error === "object" && "code" in error && error.code === "ASSISTANT_SESSION_CONFLICT")) throw error;
          await refreshAssistantSessionIndex();
          if (!isCurrent()) return;
          knownIds = useAssistantStore.getState().sessions.map((entry) => entry.id);
          imported = await migrateAssistantChatArchive(archive, [...knownIds, imported.id]);
        }
      }
      if (!isCurrent()) return;
      const state = useAssistantStore.getState();
      await refreshAssistantSessionIndex();
      state.setCurrentSession(imported);
      state.setOpen(true);
      toast({ title: t("assistant.importChatComplete") });
    } catch (err) {
      if (isCurrent()) toast({ title: t("assistant.importChatFailed"), description: String(err), variant: "destructive" });
    } finally {
      accountRequestsRef.current.delete(controller);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  function newChat() {
    setCurrentSession(createEmptyAssistantSession("Narrarium"));
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("chats.title")}</h1>
          <p className="text-muted-foreground">{t("chats.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <input ref={importInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void importArchive(event.target.files?.[0])} />
          <Button variant="outline" onClick={() => importInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" />{t("assistant.importChatArchive")}</Button>
          <Button onClick={newChat}><Bot className="mr-2 h-4 w-4" />{t("assistant.new")}</Button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("chats.searchPlaceholder")} className="pl-9" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("chats.loading")}</div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("chats.empty")}</CardTitle>
            <CardDescription>{t("chats.emptyDescription")}</CardDescription>
          </CardHeader>
        </Card>
      ) : filteredSessions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("chats.noResults")}</CardTitle>
            <CardDescription>{t("chats.noResultsDescription")}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredSessions.map((session) => (
            <Card key={session.fileId ?? session.id}>
              <CardHeader>
                <CardTitle className="line-clamp-2 text-base">{session.title}</CardTitle>
                <CardDescription>{session.contextTitle}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">{new Date(session.updatedAt).toLocaleString()}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => session.fileId && void openSession(session.fileId)} disabled={!session.fileId}>{t("chats.open")}</Button>
                  <Button size="sm" variant="outline" onClick={() => void deleteSession(session)} disabled={!session.fileId || deleting === session.fileId}>
                    {deleting === session.fileId ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                    {t("chats.delete")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
