import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Github, Loader2, TriangleAlert } from "lucide-react";
import "@/i18n/serverGitHub";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { useToast } from "@/components/ui/use-toast";
import { safeVerificationAddress } from "@/autopilot/serverGitHub";
import { serverGitHubProblemText } from "@/autopilot/serverGitHubText";
import { useAutopilotStore } from "@/autopilot/store";
import { useServerGitHub } from "@/autopilot/useServerGitHub";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<string, string> = {
  disconnected: "border-transparent bg-muted text-muted-foreground",
  pending: "border-transparent bg-sky-500/15 text-sky-800 dark:text-sky-300",
  connected: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  "needs-reconnect": "border-transparent bg-red-500/15 text-red-800 dark:text-red-300",
};

const LINK = "inline-flex min-h-6 items-center gap-1 font-medium text-primary underline underline-offset-4 hover:no-underline [@media(pointer:coarse)]:min-h-11";

/** The code the owner types on github.com, large and selectable, and read one character at a time by a screen reader. */
function UserCode({ code }: { code: string }) {
  return (
    <strong className="select-all rounded-md border bg-background px-3 py-1.5 font-mono text-2xl tracking-widest" data-testid="server-github-code">
      <span aria-hidden="true">{code}</span>
      <span className="sr-only">{code.split("").join(" ")}</span>
    </strong>
  );
}

/**
 * Settings → Personal server → «GitHub connection of the server»: the server connects to GitHub on its own (device authorization), keeps a sign-in of its own and renews it, so a GitHub book it
 * runs is not limited to the 8 hours of the token of this browser. The card is a lazy chunk: it asks the server for the status when it is on screen (never when the page mounts), polls
 * only while the server waits for the code to be typed, and never asks GitHub anything itself.
 */
export default function ServerGitHubCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const headingId = useId();
  const { offer, connection, busy, error, connect, disconnect } = useServerGitHub({ active: true });
  const books = useAutopilotStore((state) => state.server.books.filter((book) => book.githubAuth === "connection").length);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  // Nothing to say while the server is not online: the status above says why. An older server, or a build without the app, gets one calm line.
  if (offer === "unavailable") return null;
  const state = connection?.state;
  const address = safeVerificationAddress(connection?.pending?.verificationUri);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(connection?.pending?.userCode ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      toast({ title: t("serverGitHub.pending.copied") });
    } catch {
      toast({ title: t("serverGitHub.pending.copyFailed"), variant: "destructive" });
    }
  }

  async function confirmDisconnect() {
    setConfirming(false);
    if (await disconnect()) toast({ title: t("serverGitHub.done.disconnected") });
  }

  const header = (
    <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold"><Github className="h-4 w-4 text-primary" aria-hidden="true" />{t("serverGitHub.title")}</h3>
  );

  // A build without the app cannot start a connection, but one that exists (made from another site) is the server's, and is shown with its way out.
  const canStart = offer === "ready";
  if (offer === "old-server" || (offer === "no-site" && (state === undefined || state === "disconnected"))) {
    return (
      <section className="space-y-2 rounded-xl border p-4" aria-labelledby={headingId} data-testid="server-github-card" data-offer={offer}>
        {header}
        <p className="text-sm text-muted-foreground">{t(offer === "old-server" ? "serverGitHub.oldServer" : "serverGitHub.noSite")}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-labelledby={headingId} data-testid="server-github-card" data-state={state ?? "reading"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {header}
        {state && <Badge className={cn(STATE_STYLE[state])}>{t(`serverGitHub.state.${state}`)}</Badge>}
      </div>

      <div role="status" aria-live="polite" className="space-y-2">
        {state === undefined && !error && <p className="text-sm text-muted-foreground">{t("serverGitHub.reading")}</p>}
        {state === "pending" && <p className="text-sm">{t("serverGitHub.pending.waiting")}</p>}
        {state === "connected" && <p className="text-sm">{connection?.login ? t("serverGitHub.connectedAs", { login: connection.login }) : t("serverGitHub.connectedNoLogin")}</p>}
        {state === "needs-reconnect" && <p className="text-sm">{t("serverGitHub.lost")}</p>}
        {connection?.problem && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-100" data-testid="server-github-problem" data-problem={connection.problem.code}>
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{serverGitHubProblemText(t, connection.problem, state)}</span>
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive" data-testid="server-github-error">{t("serverGitHub.failed")}: {error}</p>}
      </div>

      {(state === "disconnected" || state === undefined) && (
        <>
          <p className="text-sm text-muted-foreground">{t("serverGitHub.intro")}</p>
          <p className="text-xs text-muted-foreground">{t("serverGitHub.tradeoff")}</p>
          {state === "disconnected" && canStart && (
            <Button disabled={busy !== null} onClick={() => void connect()}>
              {busy === "connecting" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Github className="h-4 w-4" aria-hidden="true" />}
              {busy === "connecting" ? t("serverGitHub.connecting") : t("serverGitHub.connect")}
            </Button>
          )}
        </>
      )}

      {state === "pending" && connection?.pending && (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="server-github-pending">
          <p className="text-sm font-medium">{t("serverGitHub.pending.title")}</p>
          <p className="text-sm text-muted-foreground">{t("serverGitHub.pending.steps")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t("serverGitHub.pending.code")}</span>
            <UserCode code={connection.pending.userCode} />
            <Button variant="outline" size="icon" onClick={() => void copyCode()} title={t("serverGitHub.pending.copy")} aria-label={t("serverGitHub.pending.copy")}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
          {address ? (
            <a className={LINK} href={address} target="_blank" rel="noopener noreferrer">
              {t("serverGitHub.pending.open")}{" "}<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">{t("serverGitHub.pending.opensNewTab")}</span>
            </a>
          ) : (
            <p className="text-sm">{t("serverGitHub.pending.address", { address: connection.pending.verificationUri })}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("serverGitHub.pending.expires")} <LocalTime value={connection.pending.expiresAt} />.</p>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>{t("serverGitHub.pending.cancel")}</Button>
        </div>
      )}

      {state === "connected" && connection && (
        <>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            {connection.connectedAt && <><dt className="text-muted-foreground">{t("serverGitHub.facts.connectedAt")}</dt><dd><LocalTime value={connection.connectedAt} /></dd></>}
            {connection.renewedAt && <><dt className="text-muted-foreground">{t("serverGitHub.facts.renewedAt")}</dt><dd><LocalTime value={connection.renewedAt} /></dd></>}
            {connection.accessTokenExpiresAt && <><dt className="text-muted-foreground">{t("serverGitHub.facts.tokenEnds")}</dt><dd><LocalTime value={connection.accessTokenExpiresAt} /></dd></>}
            {connection.refreshTokenExpiresAt && <><dt className="text-muted-foreground">{t("serverGitHub.facts.refreshEnds")}</dt><dd><LocalTime value={connection.refreshTokenExpiresAt} /></dd></>}
            {connection.broker && <><dt className="text-muted-foreground">{t("serverGitHub.facts.broker")}</dt><dd className="break-all">{connection.broker}</dd></>}
          </dl>
          {books > 0 && <p className="text-xs text-muted-foreground">{t("serverGitHub.booksUsing", { count: books })}</p>}
        </>
      )}

      {state === "needs-reconnect" && (
        <div className="flex flex-wrap items-center gap-2">
          {canStart && (
            <Button disabled={busy !== null} onClick={() => void connect()}>
              {busy === "connecting" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Github className="h-4 w-4" aria-hidden="true" />}
              {busy === "connecting" ? t("serverGitHub.connecting") : t("serverGitHub.connectAgain")}
            </Button>
          )}
          <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>{t("serverGitHub.forget")}</Button>
        </div>
      )}
      {state === "connected" && (
        <Button variant="outline" disabled={busy !== null} onClick={() => setConfirming(true)}>
          {busy === "disconnecting" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t("serverGitHub.disconnect")}
        </Button>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("serverGitHub.dialog.title")}</DialogTitle>
            <DialogDescription>{t("serverGitHub.dialog.body")}{books > 0 ? ` ${books === 1 ? t("serverGitHub.dialog.booksOne") : t("serverGitHub.dialog.booksOther", { count: books })}` : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>{t("serverGitHub.dialog.cancel")}</Button>
            <Button variant="destructive" onClick={() => void confirmDisconnect()}>{t("serverGitHub.dialog.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
