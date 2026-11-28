import { forwardRef, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Hourglass, Laptop, Loader2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GitHubServerTokenNotice } from "@/components/book/GitHubServerTokenNotice";
import { isHandoverCancellable, type HandoverPlan } from "@/autopilot/handover";
import { handoverText } from "@/autopilot/handoverText";
import type { WhereBlocker, WhereMode } from "@/autopilot/whereModel";
import type { BookEntry } from "@/types/settings";
import { cn } from "@/lib/utils";

/** What the author did not give the server that a run needs: it is said where the consent is, and the box it is about points at it. `github-connection`: the server's own connection was chosen and the server is not connected. */
export type ConsentProblem = "ai" | "github" | "github-connection" | null;

/**
 * How a GitHub book signs in to GitHub on the server, as the card knows it. `connected`: the server's own GitHub connection is connected, so it can be chosen (`chosen`: it is, which is the
 * default then, since the owner connected it explicitly). `hint`: it is not connected and could be (not started, or lost): the card says where to connect it.
 */
export interface GithubVia {
  connected: boolean;
  chosen: boolean;
  login?: string;
  hint: "connect" | "lost" | null;
}

/** A sentence, next to what it explains, that says why something is not open now; the control it is about points at it. */
export function Why({ id, children, role = "note", className }: { id: string; children: ReactNode; role?: "note" | "alert" | "status"; className?: string }) {
  return <p id={id} role={role} className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}

/** Where a plan to pass the book to the other side is, in words, with the way to take it back while it only waits for the step to end. It takes the focus when it appears. */
export const PlanLine = forwardRef<HTMLDivElement, { plan: HandoverPlan; busy: boolean; onCancel: () => void }>(function PlanLine({ plan, busy, onCancel }, ref) {
  const { t } = useTranslation();
  const waiting = plan.phase === "armed";
  return (
    <div ref={ref} role="status" tabIndex={-1} data-where-plan={plan.phase} className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {waiting ? <Hourglass className="h-4 w-4 shrink-0" aria-hidden /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
      <span className="min-w-[min(14rem,100%)] flex-1">{handoverText(t, plan)}</span>
      {isHandoverCancellable(plan) && <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left" disabled={busy} onClick={onCancel}>{t(`autopilot.quick.handover.cancel.${plan.to}`)}</Button>}
    </div>
  );
});

/** What a blocker says, in words and, when there is one, with its action: the settings of the server for a server that is not there or not verified, the box to tick for the token. */
export function BlockedWhy({ id, blocker, onAllowGithub }: { id: string; blocker: WhereBlocker; onAllowGithub?: () => void }) {
  const { t } = useTranslation();
  return (
    <Why id={id}>
      {blocker === "busy" ? t("autopilot.quick.where.busy")
        : blocker === "github-consent" ? (
          <>
            {t("autopilot.where.githubConsentMissing")}{" "}
            <Button type="button" size="sm" variant="outline" className="ml-1 h-7" onClick={onAllowGithub}>{t("autopilot.where.githubConsentAllow")}</Button>
          </>
        )
        : <>{t(blocker === "no-server" ? "autopilot.where.noServer" : "autopilot.where.serverUnverified")} <Link className="underline" to="/app/settings/server">{t("personalServer.title")}</Link></>}
    </Why>
  );
}

const MODE_WORDS: Record<"server" | "browser", Record<Exclude<WhereMode, "move">, string>> = {
  server: { "after-step": "autopilot.quick.where.toServerAfterStep", now: "autopilot.quick.where.toServerNow", step: "autopilot.quick.where.stepOnServer" },
  browser: { "after-step": "autopilot.quick.where.toBrowserAfterStep", now: "autopilot.quick.where.toBrowserNow", step: "autopilot.quick.where.stepInBrowser" },
};

interface PassProps {
  book: BookEntry;
  mode: WhereMode;
  blocker: WhereBlocker | null;
  plan: HandoverPlan | null;
  /** The card's own action is on its way. */
  acting: boolean;
  /** The autopilot is running (here or there): the book is passed by a plan, after the step by default. */
  running: boolean;
  onPass: (mode: WhereMode) => void;
  onCancel: () => void;
  onAllowGithub: () => void;
  primaryRef: Ref<HTMLButtonElement>;
  planRef: Ref<HTMLDivElement>;
}

function PassButtons({ book, mode, blocker, acting, running, onPass, primaryRef, side, label, icon }: PassProps & { side: "server" | "browser"; label: string; icon: ReactNode }) {
  const { t } = useTranslation();
  const blockedId = `where-move-blocked-${book.id}`;
  const hintId = `where-move-now-${book.id}`;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Button ref={primaryRef} size="sm" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left" disabled={blocker !== null || acting} aria-describedby={blocker ? blockedId : undefined} onClick={() => onPass(mode)}>
        {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : icon}{label}
      </Button>
      {running && mode === "after-step" && (
        <div className="space-y-1">
          <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left" disabled={blocker !== null || acting} aria-describedby={hintId} onClick={() => onPass("now")}>{t(MODE_WORDS[side].now)}</Button>
          <Why id={hintId} className="max-w-xs">{t(`autopilot.quick.where.${side === "server" ? "toServerNowHint" : "toBrowserNowHint"}`)}</Why>
        </div>
      )}
    </div>
  );
}

/** The way to the server: what to send with the book, the notice about the token, and the button that moves it (stopped) or plans it (running). */
export function ToServerPanel(props: PassProps & {
  github: boolean;
  server: "ready" | "disabled" | "unverified";
  consent: { ai: boolean; github: boolean };
  onConsent: (change: { ai?: boolean; github?: boolean }) => void;
  problem: ConsentProblem;
  githubVia: GithubVia;
  onVia: (via: "connection" | "token") => void;
}) {
  const { t } = useTranslation();
  const { book, mode, blocker, plan, running, github, server, consent, onConsent, problem, onCancel, planRef, githubVia, onVia } = props;
  const choosing = github && githubVia.connected;
  const blockedId = `where-move-blocked-${book.id}`;
  const problemId = `where-move-problem-${book.id}`;
  const ready = server === "ready";
  const label = mode === "move" ? t("autopilot.where.move") : t(MODE_WORDS.server[mode]);
  return (
    <div className="space-y-2">
      {running && !plan && <Why id={`where-move-lead-${book.id}`}>{t("autopilot.where.runningHere")}</Why>}
      {plan ? <PlanLine ref={planRef} plan={plan} busy={props.acting} onCancel={onCancel} /> : (
        <>
          {ready ? (
            <>
              {running && <p className="text-xs">{t("autopilot.where.finishLead")}</p>}
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consent.ai} aria-invalid={problem === "ai" || undefined} aria-describedby={problem === "ai" ? problemId : undefined} onChange={(event) => onConsent({ ai: event.target.checked })} />{t("autopilot.where.consentAi")}</label>
              {github && !choosing && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consent.github} aria-invalid={problem === "github" || undefined} aria-describedby={problem === "github" ? problemId : undefined} onChange={(event) => onConsent({ github: event.target.checked })} />{t("autopilot.where.consentGithub")}</label>}
              {choosing && (
                <fieldset className="space-y-1.5" data-where-github-access>
                  <legend className="text-xs font-medium">{t("autopilot.where.githubAccess")}</legend>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="radio" name={`where-github-${book.id}`} className="mt-0.5" checked={githubVia.chosen} aria-invalid={problem === "github-connection" || undefined} aria-describedby={problem === "github-connection" ? problemId : undefined} onChange={() => onVia("connection")} />
                    <span>
                      {t("autopilot.where.githubViaConnection")}
                      <span className="block text-muted-foreground">{githubVia.login ? t("autopilot.where.githubViaConnectionHelp", { login: githubVia.login }) : t("autopilot.where.githubViaConnectionHelpNoLogin")}</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="radio" name={`where-github-${book.id}`} className="mt-0.5" checked={!githubVia.chosen} onChange={() => onVia("token")} />
                    <span>{t("autopilot.where.consentGithub")}</span>
                  </label>
                </fieldset>
              )}
              {github && !githubVia.chosen && <GitHubServerTokenNotice book={book} />}
              {github && !choosing && githubVia.hint && (
                <p role="note" className="text-xs text-muted-foreground" data-where-github-hint={githubVia.hint}>
                  {t(githubVia.hint === "lost" ? "autopilot.where.githubLostHint" : "autopilot.where.githubConnectHint")}{" "}
                  <Link className="underline" to="/app/settings/server">{t("personalServer.title")}</Link>.
                </p>
              )}
            </>
          ) : null}
          {blocker && <BlockedWhy id={blockedId} blocker={blocker} onAllowGithub={() => onConsent({ github: true })} />}
          {problem && <Why id={problemId} role="alert" className="text-amber-800 dark:text-amber-300">{t(`autopilot.where.needConsent.${problem}`)}</Why>}
          <PassButtons {...props} side="server" label={label} icon={<Server className="h-3.5 w-3.5" aria-hidden />} />
        </>
      )}
    </div>
  );
}

/** The way back to this browser: the move of a stopped book, or the plan that brings a running one back after its step. */
export function ToBrowserPanel(props: PassProps) {
  const { t } = useTranslation();
  const { book, mode, blocker, plan, running, onCancel, planRef } = props;
  const label = mode === "move" ? t("autopilot.where.moveBack") : t(MODE_WORDS.browser[mode]);
  return (
    <div className="space-y-2">
      {running && !plan && <Why id={`where-move-lead-${book.id}`}>{t("autopilot.where.runningThere")}</Why>}
      {plan ? <PlanLine ref={planRef} plan={plan} busy={props.acting} onCancel={onCancel} /> : (
        <>
          {blocker && <BlockedWhy id={`where-move-blocked-${book.id}`} blocker={blocker} />}
          <PassButtons {...props} side="browser" label={label} icon={<Laptop className="h-3.5 w-3.5" aria-hidden />} />
        </>
      )}
    </div>
  );
}
