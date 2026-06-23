import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useAuthStore } from "@/store/authStore";
import { createEmptyAssistantSession, useAssistantStore, type AssistantSessionMeta } from "@/assistant/store";
import { deleteAssistantSession, listAssistantSessions, loadAssistantSession } from "@/assistant/chatCloud";

export function AssistantChatsPage() {
  const { t } = useTranslation();
  const { user, accessToken } = useAuthStore();
  const { toast } = useToast();
  const { setOpen, setCurrentSession } = useAssistantStore();
  const [sessions, setSessions] = useState<AssistantSessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filteredSessions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sessions;
    return sessions.filter((session) =>
      [session.title, session.contextTitle].filter(Boolean).some((value) => value!.toLowerCase().includes(term)),
    );
  }, [sessions, query]);

  async function loadSessions() {
    if (!user || !accessToken) return;
    setLoading(true);
    try {
      setSessions(await listAssistantSessions(user.provider, accessToken));
    } catch (err) {
      toast({ title: "Failed to load chats", description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSessions();
  }, [user, accessToken]);

  async function openSession(fileId: string) {
    if (!user || !accessToken) return;
    setLoading(true);
    try {
      setCurrentSession(await loadAssistantSession(user.provider, accessToken, fileId));
      setOpen(true);
    } catch (err) {
      toast({ title: "Failed to open chat", description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function deleteSession(session: AssistantSessionMeta) {
    if (!user || !accessToken || !session.fileId) return;
    setDeleting(session.fileId);
    try {
      await deleteAssistantSession(user.provider, accessToken, session.fileId);
      setSessions((current) => current.filter((entry) => entry.fileId !== session.fileId));
    } catch (err) {
      toast({ title: "Failed to delete chat", description: String(err), variant: "destructive" });
    } finally {
      setDeleting(null);
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
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Chat</h1>
          <p className="text-muted-foreground">Gestisci le chat salvate nel tuo Drive.</p>
        </div>
        <Button onClick={newChat}>
          <Bot className="mr-2 h-4 w-4" />
          {t("assistant.new")}
        </Button>
      </div>

      {sessions.length > 0 && (
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("chats.searchPlaceholder")} className="pl-9" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Caricamento chat…</div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nessuna chat salvata</CardTitle>
            <CardDescription>Apri il Copilot e inizia una nuova conversazione.</CardDescription>
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
                  <Button size="sm" onClick={() => session.fileId && void openSession(session.fileId)} disabled={!session.fileId}>Apri</Button>
                  <Button size="sm" variant="outline" onClick={() => void deleteSession(session)} disabled={!session.fileId || deleting === session.fileId}>
                    {deleting === session.fileId ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                    Elimina
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
