import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, CircleArrowUp, Copy, ExternalLink, Fingerprint, KeyRound, Link2, Loader2, PlugZap, RefreshCw, Send, Server, TriangleAlert, Unplug, X } from "lucide-react";
import {
  DEFAULT_ADMIN_PORT,
  DEFAULT_SERVER_PORT,
  NarrariumServerClient,
  ServerRequestError,
  pairWithServer,
  pickAiRuntimeConfig,
  type ServerAiStatus,
  type ServerSession,
  type ServerUpdateInfo,
  type ServerUpdateResult,
} from "narrarium-engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { ServerIdentityError, shortFingerprint, verifiedServerInfo } from "@/autopilot/serverIdentity";
import { useAutopilotStore, type ServerConnectionStatus } from "@/autopilot/store";
import { formatDateTime } from "@/autopilot/format";
import type { AppSettings, PersonalServerSettings } from "@/types/settings";
import { cn } from "@/lib/utils";

const START_COMMAND = "npx narrarium-server";
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const LOCAL_ADMIN_URL = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`;
const UPDATE_WAIT_MS = 10 * 60_000;

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

function isLoopback(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function devicePlatform(): string {
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = agent.userAgentData?.platform || navigator.platform || "";
  if (/android/i.test(navigator.userAgent)) return "Android";
  if (/iphone|ipad/i.test(navigator.userAgent)) return "iOS";
  if (/mac/i.test(platform)) return "macOS";
  if (/win/i.test(platform)) return "Windows";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "web";
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Settings → Personal server: pair with the npx server, send the AI router, keep it up to date. */
export function PersonalServerSettingsBody({ settings, patchSettings, onSave }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void; onSave?: () => Promise<void> }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const server = useAutopilotStore((state) => state.server);
  const connection: PersonalServerSettings = settings.personalServer ?? { url: "", token: "" };
  const configured = Boolean(connection.url.trim() && connection.token.trim());
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiStatus, setAiStatus] = useState<ServerAiStatus | null>(null);
  const [session, setSession] = useState<ServerSession | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [deviceName, setDeviceName] = useState(() => t("personalServer.pair.deviceDefault", { platform: devicePlatform() }));
  const [pairing, setPairing] = useState<{ stage: "checking" | "sending" | "waiting"; fingerprint?: string } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [updates, setUpdates] = useState<ServerUpdateInfo | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const pairAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const url = connection.url.trim() || DEFAULT_URL;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pairAbort.current?.abort();
    };
  }, []);

  const update = (patch: Partial<PersonalServerSettings>) => {
    const next = { ...connection, ...patch };
    patchSettings({ personalServer: next.url.trim() || next.token.trim() ? next : undefined });
  };

  const describe = (error: unknown): string => {
    if (error instanceof ServerIdentityError) return t(`personalServer.identity.${error.reason}`);
    if (error instanceof ServerRequestError) {
      if (error.code === "pairing_invalid") return t("personalServer.pair.invalid");
      if (error.code === "pairing_expired") return t("personalServer.pair.expired");
      if (error.code === "running") return t("personalServer.updates.running");
      if (error.code === "maintenance") return t("personalServer.updates.maintenance");
    }
    return error instanceof Error ? error.message : String(error);
  };

  async function loadUpdates(quiet: boolean) {
    setCheckingUpdates(true);
    try {
      const info = await clientFor(connection).updates();
      if (alive.current) setUpdates(info);
    } catch (error) {
      if (!quiet) toast({ title: t("personalServer.failed"), description: describe(error), variant: "destructive" });
    } finally {
      if (alive.current) setCheckingUpdates(false);
    }
  }

  useEffect(() => {
    if (!configured || server.status !== "online") return;
    let cancelled = false;
    const client = clientFor(connection);
    client.aiStatus().then((status) => { if (!cancelled) setAiStatus(status); }).catch(() => undefined);
    client.session().then((value) => { if (!cancelled) setSession(value); }).catch(() => undefined);
    void loadUpdates(true);
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

  async function reconnect() {
    (await loadAutopilotRuntime()).reconnectServer();
  }

  /** Pair with the code shown in the admin panel; the owner approves, the token arrives once. */
  async function pair() {
    const controller = new AbortController();
    pairAbort.current?.abort();
    pairAbort.current = controller;
    const label = deviceName.trim().slice(0, 80) || "Narrarium";
    setPairing({ stage: "checking" });
    try {
      const { info, fingerprint } = await verifiedServerInfo(new NarrariumServerClient({ baseUrl: url, token: "" }));
      setPairing({ stage: "sending", fingerprint });
      const token = await pairWithServer({ baseUrl: url, code: pairCode, label, signal: controller.signal, onWaitingApproval: () => setPairing({ stage: "waiting", fingerprint }) });
      // The server must still be the one whose identity was checked before the code was sent.
      await verifiedServerInfo(new NarrariumServerClient({ baseUrl: url, token: "" }), fingerprint);
      patchSettings({ personalServer: { url, token, serverId: info.serverId, fingerprint, clientLabel: label } });
      setPairCode("");
      toast({ title: t("personalServer.pair.done", { label: info.label }) });
      await onSave?.();
      await reconnect();
    } catch (error) {
      if (!controller.signal.aborted) toast({ title: t("personalServer.pair.failed"), description: describe(error), variant: "destructive" });
    } finally {
      if (pairAbort.current === controller) pairAbort.current = null;
      if (alive.current) setPairing(null);
    }
  }

  function cancelPairing() {
    pairAbort.current?.abort();
    pairAbort.current = null;
    setPairing(null);
  }

  /** Check the server (pinning its identity the first time) and the token. */
  async function test() {
    setTesting(true);
    try {
      const client = clientFor(connection);
      const { info, fingerprint } = await verifiedServerInfo(client, connection.fingerprint);
      const [value, status] = await Promise.all([client.session(), client.aiStatus()]);
      setSession(value);
      setAiStatus(status);
      if (!connection.fingerprint) update({ serverId: info.serverId, fingerprint, clientLabel: value.clientLabel });
      toast({ title: t("personalServer.connected", { label: info.label, server: info.serverVersion, engine: info.engineVersion }) });
      await reconnect();
      void loadUpdates(true);
    } catch (error) {
      toast({ title: t("personalServer.failed"), description: describe(error), variant: "destructive" });
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
      toast({ title: t("personalServer.failed"), description: describe(error), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  async function disconnect() {
    if (connection.token && !window.confirm(t("personalServer.disconnectConfirm"))) return;
    // Revoke the token on the server first, but only on the server this device paired with.
    if (configured) {
      const client = clientFor(connection);
      await verifiedServerInfo(client, connection.fingerprint).then(() => client.forgetSession()).catch(() => undefined);
    }
    patchSettings({ personalServer: undefined });
    setAiStatus(null);
    setSession(null);
    setUpdates(null);
    await onSave?.();
    void loadAutopilotRuntime().then((runtime) => runtime.reconnectServer()).catch(() => undefined);
  }

  /** Wait for the server to come back on the new version, or for the supervisor to report a failure. */
  async function waitForVersion(client: NarrariumServerClient, target: string, previousRequestId: string | undefined): Promise<"done" | "timeout" | "cancelled" | ServerUpdateResult> {
    const deadline = Date.now() + UPDATE_WAIT_MS;
    let wentDown = false;
    let lastCheck = Date.now();
    while (Date.now() < deadline) {
      await sleep(3000);
      if (!alive.current) return "cancelled";
      try {
        const info = await client.info();
        if (info.serverVersion === target) return "done";
        // Back on the old version after a restart, or still up after a while: ask what happened.
        if (wentDown || Date.now() - lastCheck > 20_000) {
          lastCheck = Date.now();
          wentDown = false;
          const last = (await client.updates()).lastUpdate;
          if (last && last.state === "failed" && last.version === target && last.requestId !== previousRequestId) return last;
        }
      } catch {
        wentDown = true;
      }
    }
    return "timeout";
  }

  async function runUpdate() {
    const target = updates?.latestVersion;
    if (!updates || !target || !updates.canRequest || !window.confirm(t("personalServer.updates.confirm", { version: target }))) return;
    const client = clientFor(connection);
    setUpdating(target);
    try {
      await client.requestUpdate(target, updates.installedVersion);
      toast({ title: t("personalServer.updates.requested", { version: target }) });
      const outcome = await waitForVersion(client, target, updates.lastUpdate?.requestId);
      if (outcome === "cancelled") return;
      if (outcome === "done") toast({ title: t("personalServer.updates.done", { version: target }) });
      else if (outcome === "timeout") toast({ title: t("personalServer.updates.failedTitle"), description: t("personalServer.updates.timeout", { version: target }), variant: "destructive" });
      else toast({ title: t("personalServer.updates.failedTitle"), description: t(`personalServer.updates.failedReason.${outcome.outcome}`), variant: "destructive" });
      await reconnect();
      await loadUpdates(true);
    } catch (error) {
      toast({ title: t("personalServer.updates.failedTitle"), description: describe(error), variant: "destructive" });
    } finally {
      if (alive.current) setUpdating(null);
    }
  }

  const updateText = (info: ServerUpdateInfo): string => {
    const version = info.latestVersion ?? "";
    if (info.pending) return t("personalServer.updates.pending", { version: info.pending.version });
    if (info.canRequest) return t("personalServer.updates.reason.available", { version });
    if (info.reason) return t(`personalServer.updates.reason.${info.reason}`, { version });
    return info.message;
  };

  const online = configured && server.status === "online";

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
        <p className="text-xs text-muted-foreground">{t("personalServer.adminHint", { url: LOCAL_ADMIN_URL })}</p>
        {isLoopback(url) && (
          <a className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline" href={LOCAL_ADMIN_URL} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />{t("personalServer.openAdmin")}
          </a>
        )}
        <p className="text-xs text-muted-foreground">{t("personalServer.network")}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="personal-server-url">{t("personalServer.url")}</Label>
        <Input id="personal-server-url" value={connection.url} placeholder={DEFAULT_URL} autoComplete="off" spellCheck={false} disabled={Boolean(pairing)} onChange={(event) => update({ url: event.target.value })} />
      </div>

      {!connection.token.trim() && (
        <div className="space-y-3 rounded-xl border p-4" data-testid="personal-server-pairing">
          <p className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-primary" />{t("personalServer.pair.title")}</p>
          <p className="text-sm text-muted-foreground">{t("personalServer.pair.body")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="personal-server-pair-code">{t("personalServer.pair.code")}</Label>
              <Input id="personal-server-pair-code" value={pairCode} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456 789" maxLength={11} disabled={Boolean(pairing)} onChange={(event) => setPairCode(event.target.value.replace(/[^\d ]/g, ""))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="personal-server-device">{t("personalServer.pair.device")}</Label>
              <Input id="personal-server-device" value={deviceName} maxLength={80} disabled={Boolean(pairing)} onChange={(event) => setDeviceName(event.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={Boolean(pairing) || pairCode.replace(/\D/g, "").length !== 9} onClick={() => void pair()}>
              {pairing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}{t("personalServer.pair.start")}
            </Button>
            {pairing && <Button variant="ghost" onClick={cancelPairing}><X className="h-4 w-4" />{t("personalServer.pair.cancel")}</Button>}
          </div>
          {pairing && (
            <p className="text-sm text-muted-foreground" role="status">
              {pairing.stage === "waiting" && pairing.fingerprint
                ? t("personalServer.pair.waiting", { label: deviceName.trim() || "Narrarium", fingerprint: shortFingerprint(pairing.fingerprint) })
                : t(pairing.stage === "checking" ? "personalServer.pair.checking" : "personalServer.pair.sending")}
            </p>
          )}
          <button type="button" className="text-xs font-medium text-primary underline-offset-4 hover:underline" onClick={() => setShowManual((value) => !value)} aria-expanded={showManual}>
            {t("personalServer.pair.manual")}
          </button>
        </div>
      )}

      {(connection.token.trim() || showManual) && (
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
      )}
      <p className="text-xs text-muted-foreground">{t("personalServer.saveHint")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!configured || testing} onClick={() => void test()}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}{t("personalServer.test")}
        </Button>
        <Button variant="outline" disabled={!configured || sending || settings.aiIntegrations.length === 0} onClick={() => void sendAi()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t("personalServer.sendAi")}
        </Button>
        {settings.personalServer && <Button variant="ghost" onClick={() => void disconnect()}><Unplug className="h-4 w-4" />{t("personalServer.disconnect")}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t("personalServer.sendAiHint")}</p>

      <div className="space-y-2 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t("personalServer.statusLabel")}</span>
          <Badge className={cn(STATUS_STYLE[server.status])}>{t(`personalServer.status.${server.status}`)}</Badge>
          {server.info && <span className="text-xs text-muted-foreground">{server.info.label} · {server.info.serverVersion}</span>}
        </div>
        {server.message && server.status !== "online" && <p className="text-xs text-muted-foreground">{server.message}</p>}
        {configured && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Fingerprint className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{t("personalServer.identity.label")}:</span>
            {connection.fingerprint ? t("personalServer.identity.pinned", { fingerprint: shortFingerprint(connection.fingerprint) }) : t("personalServer.identity.notPinned")}
          </p>
        )}
        {online && session && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{t("personalServer.permissions.label")}:</span>
            {session.scopes.map((scope) => <Badge key={scope} variant="outline" className={cn("font-normal", scope === "update" && "border-amber-500/50 text-amber-700 dark:text-amber-300")}>{t(`personalServer.permissions.${scope}`)}</Badge>)}
          </div>
        )}
        {server.info && <p className="text-xs text-muted-foreground">{server.info.git ? t("personalServer.git.yes") : t("personalServer.git.no")}</p>}
        {aiStatus && (
          <p className="text-xs text-muted-foreground">
            {aiStatus.configured ? t("personalServer.aiOnServer", { count: aiStatus.integrations.length, time: formatDateTime(aiStatus.updatedAt ?? undefined) }) : t("personalServer.aiMissing")}
          </p>
        )}
        {aiStatus?.pendingApproval?.length ? (
          <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200" role="note">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t("personalServer.aiPending", { list: aiStatus.pendingApproval.join(", ") })}
          </p>
        ) : null}
      </div>

      {online && (
        <div className="space-y-2 rounded-xl border p-4" data-testid="personal-server-updates">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold"><CircleArrowUp className="h-4 w-4 text-primary" />{t("personalServer.updates.title")}</p>
            <Button variant="ghost" size="sm" disabled={checkingUpdates || Boolean(updating)} onClick={() => void loadUpdates(false)}>
              {checkingUpdates ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{t("personalServer.updates.check")}
            </Button>
          </div>
          {updates && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("personalServer.updates.installed", { version: updates.installedVersion })}
                {updates.latestVersion ? ` · ${t("personalServer.updates.latest", { version: updates.latestVersion })}` : ""}
              </p>
              <p className="text-sm">{updating ? t("personalServer.updates.progress", { version: updating }) : updateText(updates)}</p>
              {updates.lastUpdate && (
                <p className="text-xs text-muted-foreground">
                  {t("personalServer.updates.last", { from: updates.lastUpdate.fromVersion, to: updates.lastUpdate.version, outcome: t(`personalServer.updates.outcome.${updates.lastUpdate.outcome}`), time: formatDateTime(updates.lastUpdate.at) })}
                </p>
              )}
              {(updates.canRequest || updating) && updates.latestVersion && (
                <Button disabled={Boolean(updating)} onClick={() => void runUpdate()}>
                  {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleArrowUp className="h-4 w-4" />}{t("personalServer.updates.update", { version: updates.latestVersion })}
                </Button>
              )}
            </>
          )}
        </div>
      )}

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
