import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Copy, Loader2, PlugZap, Send, Server, Unplug } from "lucide-react";
import { NarrariumServerClient, pickAiRuntimeConfig, type ServerAiStatus } from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore, type ServerConnectionStatus } from "@/autopilot/store";
import { formatDateTime } from "@/autopilot/format";
import type { AppSettings, PersonalServerSettings } from "@/types/settings";
import { cn } from "@/lib/utils";

const START_COMMAND = "npx narrarium-server";

const STATUS_STYLE: Record<ServerConnectionStatus, string> = {
  disabled: "border-transparent bg-muted text-muted-foreground",
  connecting: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  online: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  offline: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  error: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

function clientFor(connection: PersonalServerSettings): NarrariumServerClient {
  return new NarrariumServerClient({ baseUrl: connection.url, token: connection.token });
}

/** Settings → Personal server: connect the npx server, send the AI router, see its books. */
export function PersonalServerSettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const server = useAutopilotStore((state) => state.server);
  const connection = settings.personalServer ?? { url: "", token: "" };
  const configured = Boolean(connection.url.trim() && connection.token.trim());
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiStatus, setAiStatus] = useState<ServerAiStatus | null>(null);

  const update = (patch: Partial<PersonalServerSettings>) => {
    const next = { ...connection, ...patch };
    patchSettings({ personalServer: next.url.trim() || next.token.trim() ? next : undefined });
  };

  useEffect(() => {
    if (!configured || server.status !== "online") return;
    let cancelled = false;
    clientFor(connection).aiStatus().then((status) => { if (!cancelled) setAiStatus(status); }).catch(() => undefined);
    return () => { cancelled = true; };
    // Reload when the connection comes online or changes.
  }, [configured, server.status, connection.url, connection.token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(START_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      toast({ title: t("personalServer.copied") });
    } catch {
      toast({ title: t("secretInput.copyFailed"), variant: "destructive" });
    }
  }

  async function test() {
    setTesting(true);
    try {
      const client = clientFor(connection);
      const [info, status] = await Promise.all([client.info(), client.aiStatus()]);
      setAiStatus(status);
      toast({ title: t("personalServer.connected", { label: info.label, server: info.serverVersion, engine: info.engineVersion }) });
      (await loadAutopilotRuntime()).reconnectServer();
    } catch (error) {
      toast({ title: t("personalServer.failed"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  }

  async function sendAi() {
    setSending(true);
    try {
      setAiStatus(await clientFor(connection).putAiConfig(pickAiRuntimeConfig(settings)));
      toast({ title: t("personalServer.aiSent") });
    } catch (error) {
      toast({ title: t("personalServer.failed"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  function disconnect() {
    patchSettings({ personalServer: undefined });
    setAiStatus(null);
    void loadAutopilotRuntime().then((runtime) => runtime.reconnectServer()).catch(() => undefined);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-xl border bg-muted/30 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold"><Server className="h-4 w-4 text-primary" />{t("personalServer.howTitle")}</p>
        <p className="text-sm text-muted-foreground">{t("personalServer.howBody")}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-background px-3 py-2 font-mono text-sm">{START_COMMAND}</code>
          <Button variant="outline" size="icon" onClick={() => void copyCommand()} title={t("personalServer.copyCommand")} aria-label={t("personalServer.copyCommand")}>
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("personalServer.network")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="personal-server-url">{t("personalServer.url")}</Label>
          <Input id="personal-server-url" value={connection.url} placeholder="http://127.0.0.1:24242" autoComplete="off" spellCheck={false} onChange={(event) => update({ url: event.target.value })} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="personal-server-token">{t("personalServer.token")}</Label>
          <SecretInput
            id="personal-server-token"
            value={connection.token}
            placeholder="nrs_…"
            onChange={(event) => update({ token: event.target.value })}
            onCopyResult={(ok) => toast(ok ? { title: t("secretInput.copiedToast") } : { title: t("secretInput.copyFailed"), variant: "destructive" })}
          />
          <p className="text-xs text-muted-foreground">{t("personalServer.tokenHint")}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("personalServer.saveHint")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!configured || testing} onClick={() => void test()}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}{t("personalServer.test")}
        </Button>
        <Button variant="outline" disabled={!configured || sending || settings.aiIntegrations.length === 0} onClick={() => void sendAi()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t("personalServer.sendAi")}
        </Button>
        {settings.personalServer && <Button variant="ghost" onClick={disconnect}><Unplug className="h-4 w-4" />{t("personalServer.disconnect")}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t("personalServer.sendAiHint")}</p>

      <div className="space-y-2 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t("personalServer.statusLabel")}</span>
          <Badge className={cn(STATUS_STYLE[server.status])}>{t(`personalServer.status.${server.status}`)}</Badge>
          {server.info && <span className="text-xs text-muted-foreground">{server.info.label} · {server.info.serverVersion}</span>}
        </div>
        {server.message && server.status !== "online" && <p className="text-xs text-muted-foreground">{server.message}</p>}
        {server.info && <p className="text-xs text-muted-foreground">{server.info.git ? t("personalServer.git.yes") : t("personalServer.git.no")}</p>}
        {aiStatus && (
          <p className="text-xs text-muted-foreground">
            {aiStatus.configured ? t("personalServer.aiOnServer", { count: aiStatus.integrations.length, time: formatDateTime(aiStatus.updatedAt ?? undefined) }) : t("personalServer.aiMissing")}
          </p>
        )}
      </div>

      {server.status === "online" && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">{t("personalServer.books")}</p>
          {server.books.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("personalServer.noBooks")}</p>
          ) : (
            <ul className="space-y-1.5">
              {server.books.map((book) => (
                <li key={book.bookId} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{book.title}</span>
                  <span className="text-xs text-muted-foreground">{book.storage.kind === "github" ? `${book.storage.owner}/${book.storage.repo}@${book.storage.branch}` : "local"}</span>
                  <Badge variant="outline">{book.autopilot ? t(`autopilot.status.${book.autopilot.status}`) : t("autopilot.notStarted")}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
