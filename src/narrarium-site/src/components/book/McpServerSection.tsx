import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Cable, Check, Copy, Loader2, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { ServerRequestError, serverSupportsMcp, serverSupportsMcpOAuth, type NarrariumServerClient, type ServerMcpClient, type ServerMcpClientScope, type ServerMcpStatus } from "narrarium-engine";
import "@/i18n/mcp";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { formatDateTime } from "@/autopilot/format";
import { ServerAddressError } from "@/autopilot/serverAddress";
import { useServerConnection } from "@/autopilot/serverConnection";
import { ServerIdentityError, verifiedServer } from "@/autopilot/serverIdentity";
import { cn } from "@/lib/utils";
import type { BookEntry, PersonalServerSettings } from "@/types/settings";

type Translate = ReturnType<typeof useTranslation>["t"];

const SERVER_SETTINGS = "/app/settings/server";
/** The address names narrarium-server accepts (it checks them again): lowercase letters and digits joined by single hyphens, at most 80 characters. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 80;
/** What an app may do, in the order it is said. A permission this app does not know is left out. */
const SCOPES: readonly ServerMcpClientScope[] = ["read", "write", "run"];
const LINK = "rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function describe(error: unknown, t: Translate): string {
  if (error instanceof ServerIdentityError) return t("mcp.errors.identity");
  if (error instanceof ServerAddressError) return t("mcp.errors.unreachable");
  if (error instanceof ServerRequestError) {
    if (error.code === "unreachable") return t("mcp.errors.unreachable");
    if (error.code === "scope") return t("mcp.errors.scope");
    if (error.code === "book_not_found") return t("mcp.errors.bookMissing");
    if (error.code === "maintenance") return t("mcp.errors.maintenance");
    if (error.code === "not_found") return t("mcp.errors.unsupported");
  }
  return error instanceof Error ? error.message : String(error);
}

/** How Claude Code, Cursor and VS Code reach the book: its address, and a token that the author creates for the assistant (never this device's). */
function snippets(slug: string, url: string, placeholder: string): Array<{ client: string; code: string }> {
  const Authorization = `Bearer ${placeholder}`;
  return [
    { client: "Claude Code", code: `claude mcp add --transport http ${slug} ${url} --header "Authorization: ${Authorization}"` },
    { client: "Cursor · .cursor/mcp.json", code: JSON.stringify({ mcpServers: { [slug]: { url, headers: { Authorization } } } }, null, 2) },
    { client: "VS Code · .vscode/mcp.json", code: JSON.stringify({ servers: { [slug]: { type: "http", url, headers: { Authorization } } } }, null, 2) },
  ];
}

/** One line in place of the settings, with the way to the settings of the personal server when that is where it can be fixed. */
function Line({ children, link = false }: { children: ReactNode; link?: boolean }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      <span>{children}</span>
      {link && <>{" "}<Link to={SERVER_SETTINGS} className={LINK}>{t("mcp.serverSettings")}</Link></>}
    </p>
  );
}

/**
 * The MCP server of a book, in the settings page of the book: its own address on the personal server (`/mcp/<slug>`), where an assistant reads and edits
 * the book. Only for a book on the personal server, and from a server that has it; everything goes through the server that the runtime verified and follows.
 */
export function McpServerSection({ book }: { book: BookEntry }) {
  const { t } = useTranslation();
  const server = useServerConnection();
  const followed = server.status === "online" ? server.connection : null;
  const onServer = book.autopilotHost === "server" || server.books.some((entry) => entry.bookId === book.id);
  let content: ReactNode;
  if (followed && onServer) {
    content = serverSupportsMcp(server.info)
      ? <McpServerSettings key={`${book.id}:${followed.url}:${followed.fingerprint ?? ""}`} book={book} connection={followed} oauth={serverSupportsMcpOAuth(server.info)} />
      : <Line link>{t("mcp.olderServer")}</Line>;
  } else if (onServer && (server.status === "connecting" || server.status === "reconnecting")) {
    content = <Line>{t("mcp.waiting")}</Line>;
  } else if (onServer && (server.status === "offline" || server.status === "error")) {
    content = <Line link>{t("mcp.unreachable")}</Line>;
  } else {
    content = <Line link>{t("mcp.notOnServer")}</Line>;
  }
  return (
    <Card id="mcp-server">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cable className="h-4 w-4" aria-hidden />{t("mcp.title")}</CardTitle>
        {onServer && <CardDescription>{t("mcp.description")}</CardDescription>}
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}

type Loaded = { state: "loading" } | { state: "failed"; reason: string } | { state: "ready"; status: ServerMcpStatus };

function McpServerSettings({ book, connection, oauth }: { book: BookEntry; connection: PersonalServerSettings; oauth: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [apps, setApps] = useState<ServerMcpClient[] | null>(null);
  const [appsProblem, setAppsProblem] = useState<string | null>(null);
  const [readingApps, setReadingApps] = useState(false);
  const [busy, setBusy] = useState<"switch" | "slug" | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [slugError, setSlugError] = useState<{ message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const slugField = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  /** Only the latest reading of the apps counts: a switch or a new address made meanwhile outdates the ones still on their way. */
  const appsReading = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** The server the runtime verified and follows: never an address being typed in the settings. */
  const client = async (signal?: AbortSignal): Promise<NarrariumServerClient> => (await verifiedServer({ connection, signal })).client;

  async function readApps(signal?: AbortSignal) {
    const reading = ++appsReading.current;
    const current = () => !signal?.aborted && alive.current && reading === appsReading.current;
    setReadingApps(true);
    try {
      const list = await (await client(signal)).listMcpClients(book.id);
      if (!current()) return;
      setApps(list);
      setAppsProblem(null);
    } catch (error) {
      if (current()) setAppsProblem(describe(error, t));
    } finally {
      if (current()) setReadingApps(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoaded({ state: "loading" });
    setApps(null);
    setAppsProblem(null);
    void (async () => {
      try {
        const status = await (await client(signal)).mcpStatus(book.id);
        if (signal.aborted) return;
        setLoaded({ state: "ready", status });
        setSlug(status.slug);
        if (oauth && status.enabled) await readApps(signal);
      } catch (error) {
        if (!signal.aborted) setLoaded({ state: "failed", reason: describe(error, t) });
      }
    })();
    return () => controller.abort();
  }, [book.id, connection, oauth, attempt]);

  // A refused address name moves the focus back to its field, which then says why.
  useEffect(() => {
    if (slugError) slugField.current?.focus();
  }, [slugError]);

  if (loaded.state === "loading") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("mcp.loading")}</p>;
  }
  if (loaded.state === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-destructive">{loaded.reason}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}><RefreshCw className="h-4 w-4" aria-hidden />{t("mcp.retry")}</Button>
      </div>
    );
  }

  const status = loaded.status;
  /** How many apps are connected when the server can say it: the list read here, or the count of the status (none from a server without OAuth apps). */
  const connected = apps ? apps.length : status.connections;
  const ask = (question: string) => (connected ? `${question} ${t("mcp.confirm.connected", { count: connected })}` : question);

  function applied(next: ServerMcpStatus) {
    setLoaded({ state: "ready", status: next });
    setSlug(next.slug);
    setSlugError(null);
    // What was read of the apps belongs to the state before: it is read again, or dropped while the server is off.
    appsReading.current += 1;
    setApps(null);
    setAppsProblem(null);
    setReadingApps(false);
    if (oauth && next.enabled) void readApps();
  }

  async function toggle(enabled: boolean) {
    if (busy) return;
    if (!enabled && !window.confirm(ask(t("mcp.confirm.off")))) return;
    setBusy("switch");
    try {
      const next = await (await client()).updateMcp(book.id, { enabled });
      if (!alive.current) return;
      applied(next);
      toast({ title: t(next.enabled ? "mcp.toast.on" : "mcp.toast.off") });
    } catch (error) {
      if (alive.current) toast({ title: t("mcp.toast.failed"), description: describe(error, t), variant: "destructive" });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function changeSlug(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = slug.trim();
    if (busy || !next || next === status.slug) return;
    if (next.length > SLUG_MAX || !SLUG.test(next)) {
      setSlugError({ message: t("mcp.slug.invalid") });
      return;
    }
    if (!window.confirm(ask(t("mcp.confirm.slug", { slug: next })))) return;
    setBusy("slug");
    try {
      const changed = await (await client()).updateMcp(book.id, { slug: next });
      if (!alive.current) return;
      applied(changed);
      toast({ title: t("mcp.toast.slug") });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ServerRequestError && error.code === "invalid_slug") setSlugError({ message: t("mcp.slug.invalid") });
      else if (error instanceof ServerRequestError && error.code === "slug_taken") setSlugError({ message: t("mcp.slug.taken") });
      else toast({ title: t("mcp.toast.failed"), description: describe(error, t), variant: "destructive" });
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function revoke(app: ServerMcpClient) {
    if (revoking || !window.confirm(t("mcp.confirm.revoke", { name: app.name }))) return;
    setRevoking(app.id);
    let gone = false;
    try {
      await (await client()).revokeMcpClient(book.id, app.id);
      gone = true;
      toast({ title: t("mcp.toast.revoked", { name: app.name }) });
    } catch (error) {
      // Revoked meanwhile (in the admin panel, or by switching off on another device): it is gone, as asked.
      gone = error instanceof ServerRequestError && error.code === "client_missing";
      if (gone) toast({ title: t("mcp.toast.revokedAlready", { name: app.name }) });
      else toast({ title: t("mcp.toast.revokeFailed"), description: describe(error, t), variant: "destructive" });
    } finally {
      if (alive.current) {
        setRevoking(null);
        if (gone) setApps((list) => list && list.filter((entry) => entry.id !== app.id));
      }
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      if (!alive.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (alive.current) setCopied(false);
      }, 1500);
      toast({ title: t("mcp.toast.copied") });
    } catch {
      toast({ title: t("mcp.toast.copyFailed"), variant: "destructive" });
    }
  }

  const ids = { switch: `${id}-switch`, state: `${id}-state`, slug: `${id}-slug`, hint: `${id}-slug-hint`, error: `${id}-slug-error`, token: `${id}-token`, oauth: `${id}-oauth`, apps: `${id}-apps` };
  const placeholder = t("mcp.connect.token.placeholder");
  const typed = slug.trim();
  /** "read the book, change the book and control the autopilot": the permissions of an app in words, the ones this app knows. */
  const words = (scopes: unknown): string => {
    const said = SCOPES.filter((scope) => Array.isArray(scopes) && scopes.includes(scope)).map((scope) => t(`mcp.apps.scope.${scope}`));
    return said.length < 2 ? said.join("") : t("mcp.apps.and", { list: said.slice(0, -1).join(", "), last: said[said.length - 1] });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={ids.switch}>{t("mcp.switch")}</Label>
          <p id={ids.state} className="text-sm text-muted-foreground">{t(status.enabled ? "mcp.on" : "mcp.off")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy === "switch" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          <Switch id={ids.switch} checked={status.enabled} disabled={busy !== null} aria-describedby={ids.state} onCheckedChange={(enabled) => void toggle(enabled)} />
        </div>
      </div>

      <p role="note" className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t("mcp.warning")}
      </p>

      {status.enabled && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("mcp.address.label")}</p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">{status.url}</code>
              <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={() => void copy(status.url)} aria-label={t("mcp.address.copy")} title={t("mcp.address.copy")}>
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
            {!status.public && (
              <div role="note" className="space-y-1 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <p className="flex items-start gap-1.5"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{t("mcp.address.notPublic")}</p>
                {status.message && <p lang="en">{status.message}</p>}
              </div>
            )}
          </div>

          <form className="space-y-2" noValidate onSubmit={(event) => void changeSlug(event)}>
            <Label htmlFor={ids.slug}>{t("mcp.slug.label")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={ids.slug}
                ref={slugField}
                value={slug}
                maxLength={SLUG_MAX}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono sm:flex-1"
                aria-invalid={slugError ? true : undefined}
                aria-describedby={slugError ? `${ids.hint} ${ids.error}` : ids.hint}
                onChange={(event) => {
                  setSlug(event.target.value);
                  setSlugError(null);
                }}
              />
              <Button type="submit" variant="outline" disabled={busy !== null || !typed || typed === status.slug}>
                {busy === "slug" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t("mcp.slug.change")}
              </Button>
            </div>
            <p id={ids.hint} className="text-xs text-muted-foreground">{t("mcp.slug.hint")}</p>
            {slugError && <p id={ids.error} className="text-xs text-destructive">{slugError.message}</p>}
          </form>

          <section aria-labelledby={ids.token} className="space-y-2">
            <h4 id={ids.token} className="text-sm font-semibold">{t("mcp.connect.token.title")}</h4>
            <p className="text-sm text-muted-foreground">{t("mcp.connect.token.body", { placeholder })}</p>
            <details className="rounded-lg border">
              <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">{t("mcp.connect.token.show")}</summary>
              <div className="space-y-3 border-t px-3 py-3">
                {snippets(status.slug, status.url, placeholder).map((snippet) => (
                  <figure key={snippet.client} className="space-y-1">
                    <figcaption className="text-xs font-medium text-muted-foreground">{snippet.client}</figcaption>
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs"><code>{snippet.code}</code></pre>
                  </figure>
                ))}
              </div>
            </details>
          </section>

          <section aria-labelledby={ids.oauth} className="space-y-2">
            <h4 id={ids.oauth} className="text-sm font-semibold">{t("mcp.connect.oauth.title")}</h4>
            <p className="text-sm text-muted-foreground">{t(oauth ? "mcp.connect.oauth.body" : "mcp.connect.oauth.older")}</p>
          </section>

          {oauth && (
            <section aria-labelledby={ids.apps} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 id={ids.apps} className="text-sm font-semibold">{t("mcp.apps.title")}</h4>
                <Button type="button" variant="ghost" size="sm" disabled={readingApps} onClick={() => void readApps()}>
                  <RefreshCw className={cn("h-4 w-4", readingApps && "animate-spin")} aria-hidden />{t("mcp.apps.refresh")}
                </Button>
              </div>
              {appsProblem ? (
                <p className="text-sm text-destructive">{t("mcp.apps.failed", { reason: appsProblem })}</p>
              ) : apps === null ? (
                <p className="text-sm text-muted-foreground">{t("mcp.apps.loading")}</p>
              ) : apps.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">{t("mcp.apps.none")}</p>
              ) : (
                <ul aria-labelledby={ids.apps} className="space-y-2">
                  {apps.map((app) => {
                    const allowed = words(app.scopes);
                    const created = formatDateTime(app.createdAt);
                    const used = formatDateTime(app.lastUsedAt);
                    return (
                      <li key={app.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <p className="break-words text-sm font-medium">{app.name}</p>
                          {allowed && <p className="text-sm">{t("mcp.apps.permissions", { list: allowed })}</p>}
                          {app.redirectHost && <p className="break-all text-xs text-muted-foreground">{t("mcp.apps.returnsTo", { host: app.redirectHost })}</p>}
                          {(created || used) && (
                            <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                              {created && <span>{t("mcp.apps.created", { date: created })}</span>}
                              {used && <span>{t("mcp.apps.lastUsed", { date: used })}</span>}
                            </p>
                          )}
                        </div>
                        <Button type="button" variant="outline" size="sm" className="shrink-0 self-start" aria-label={t("mcp.apps.revokeNamed", { name: app.name })} disabled={revoking !== null} onClick={() => void revoke(app)}>
                          {revoking === app.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Unplug className="h-4 w-4" aria-hidden />}{t("mcp.apps.revoke")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">{t("mcp.admin")}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
