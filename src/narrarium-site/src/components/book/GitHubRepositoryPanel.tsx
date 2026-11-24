import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/githubCreateBook";
import "@/i18n/githubApp";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { BookRepositoryPreflight, BookRepositoryPreflightIssue } from "@/github/bookRepository";

/** The choices of the owner and the visibility of a repository, and of GitHub Pages: the same on the page that adds a book and in the card that connects one. */
export interface GitHubRepositoryChoices {
  /** The login of the organization, `""` for the user's own account, or `OTHER_OWNER` when its name is typed in `otherOwner`. */
  owner: string;
  otherOwner: string;
  visibility: "private" | "public";
  pages: boolean;
  /** Set once the user touches the Pages box: from then on the visibility no longer decides it. */
  pagesChosen: boolean;
}

export const OTHER_OWNER = "__other__";

export const defaultGitHubRepositoryChoices = (): GitHubRepositoryChoices => ({ owner: "", otherOwner: "", visibility: "private", pages: false, pagesChosen: false });

/** The login the repository is made for, or `undefined` for the account of the token. */
export function ownerOf(choices: GitHubRepositoryChoices): string | undefined {
  const value = choices.owner === OTHER_OWNER ? choices.otherOwner.trim() : choices.owner;
  return value || undefined;
}

export type GitHubPreflightState = { status: "idle" } | { status: "loading" } | { status: "ready"; preflight: BookRepositoryPreflight } | { status: "failed" };

/** What the token seems able to do, read once for each token (a read of the user and of the organizations: no permission to ask for). */
export function useGitHubPreflight(token: string | undefined): GitHubPreflightState {
  const [state, setState] = useState<GitHubPreflightState>({ status: "idle" });
  useEffect(() => {
    if (!token) { setState({ status: "idle" }); return; }
    let current = true;
    const controller = new AbortController();
    setState({ status: "loading" });
    void import("@/github/bookRepository")
      .then(({ preflightBookRepository }) => preflightBookRepository({ token, signal: controller.signal }))
      .then((preflight) => { if (current) setState({ status: "ready", preflight }); })
      .catch(() => { if (current) setState({ status: "failed" }); });
    return () => { current = false; controller.abort(); };
  }, [token]);
  return state;
}

const FIELD = "flex h-10 w-full rounded-md border border-field bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11";
const CHOICE = "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-ring";

const ISSUE_KEYS: Record<BookRepositoryPreflightIssue, string> = {
  "no-repo-scope": "noRepoScope",
  "public-only": "publicOnly",
  "no-workflow-scope": "noWorkflowScope",
  "fine-grained": "fineGrained",
  "unknown-token": "unknownToken",
  "app-token": "appToken",
};

export interface GitHubRepositoryPanelProps {
  choices: GitHubRepositoryChoices;
  onChange: (choices: GitHubRepositoryChoices) => void;
  preflight: GitHubPreflightState;
  disabled?: boolean;
  /** Shows the token notes only when there is a token to talk about. */
  hasToken: boolean;
  /** The credential is the GitHub app's: the note says what the app needs (installed on the repository, and its permissions), not what a token's scopes are. */
  app?: boolean;
}

export function GitHubRepositoryPanel({ choices, onChange, preflight, disabled, hasToken, app }: GitHubRepositoryPanelProps) {
  const { t } = useTranslation();
  const base = useId();
  const ready = preflight.status === "ready" ? preflight.preflight : null;
  const organizations = ready?.organizations ?? [];
  const known = choices.owner === "" || choices.owner === OTHER_OWNER || organizations.includes(choices.owner);
  const set = (patch: Partial<GitHubRepositoryChoices>) => onChange({ ...choices, ...patch });
  const setVisibility = (visibility: "private" | "public") => set({ visibility, ...(choices.pagesChosen ? {} : { pages: visibility === "public" }) });
  const issues = ready?.issues ?? [];
  const isApp = Boolean(app) || ready?.tokenKind === "app";

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:max-w-md">
        <Label htmlFor={`${base}-owner`}>{t("github.createBook.panel.owner.label")}</Label>
        <select id={`${base}-owner`} className={FIELD} value={known ? choices.owner : OTHER_OWNER} disabled={disabled} aria-describedby={`${base}-owner-hint`} onChange={(event) => set({ owner: event.target.value })}>
          <option value="">{ready ? t("github.createBook.panel.owner.user", { login: ready.login }) : t("github.createBook.panel.owner.account")}</option>
          {organizations.map((org) => <option key={org} value={org}>{t("github.createBook.panel.owner.organization", { org })}</option>)}
          <option value={OTHER_OWNER}>{t("github.createBook.panel.owner.other")}</option>
        </select>
        <p id={`${base}-owner-hint`} className="text-xs text-muted-foreground">{t("github.createBook.panel.owner.organizations")}</p>
        {choices.owner === OTHER_OWNER && (
          <div className="grid gap-2">
            <Label htmlFor={`${base}-other`}>{t("github.createBook.panel.owner.otherLabel")}</Label>
            <Input id={`${base}-other`} className="[@media(pointer:coarse)]:h-11" value={choices.otherOwner} disabled={disabled} autoComplete="off" spellCheck={false} aria-describedby={`${base}-other-hint`} onChange={(event) => set({ owner: OTHER_OWNER, otherOwner: event.target.value })} />
            <p id={`${base}-other-hint`} className="text-xs text-muted-foreground">{t("github.createBook.panel.owner.otherHint")}</p>
          </div>
        )}
      </div>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{t("github.createBook.panel.visibility.legend")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["private", "public"] as const).map((value) => (
            <label key={value} className={cn(CHOICE, choices.visibility === value ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
              <input type="radio" name={`${base}-visibility`} value={value} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={choices.visibility === value} aria-labelledby={`${base}-${value}-name`} aria-describedby={`${base}-${value}-hint`} onChange={() => setVisibility(value)} />
              <span className="min-w-0 space-y-1">
                <span id={`${base}-${value}-name`} className="block text-sm font-medium">{t(`github.createBook.panel.visibility.${value}`)}</span>
                <span id={`${base}-${value}-hint`} className="block text-xs text-muted-foreground">{t(`github.createBook.panel.visibility.${value}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className={cn(CHOICE, "sm:max-w-xl", choices.pages ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={choices.pages} disabled={disabled} aria-labelledby={`${base}-pages-name`} aria-describedby={`${base}-pages-hint`} onChange={(event) => set({ pages: event.target.checked, pagesChosen: true })} />
        <span className="min-w-0 space-y-1">
          <span id={`${base}-pages-name`} className="block text-sm font-medium">{t("github.createBook.panel.pages.label")}</span>
          <span id={`${base}-pages-hint`} className="block text-xs text-muted-foreground">{t(choices.visibility === "public" ? "github.createBook.panel.pages.hintPublic" : "github.createBook.panel.pages.hintPrivate")}</span>
        </span>
      </label>

      <section aria-labelledby={`${base}-checklist`} className="rounded-lg border bg-muted/20 p-3">
        <h3 id={`${base}-checklist`} className="text-sm font-medium">{t("github.createBook.panel.checklist.title")}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {(["book", "reader", "assistants", "workflow"] as const).map((item) => <li key={item}>{t(`github.createBook.panel.checklist.${item}`)}</li>)}
          {choices.pages && <li>{t("github.createBook.panel.checklist.pages")}</li>}
        </ul>
      </section>

      {hasToken && (
        <section aria-labelledby={`${base}-token`} className="rounded-lg border p-3">
          <h3 id={`${base}-token`} className="text-sm font-medium">{t(isApp ? "github.createBook.panel.token.titleApp" : "github.createBook.panel.token.title")}</h3>
          <div role="status" aria-live="polite" className="mt-1 space-y-1 text-xs text-muted-foreground">
            {preflight.status === "loading" && !isApp && <p>{t("github.createBook.panel.token.checking")}</p>}
            {preflight.status === "failed" && !isApp && <p>{t("github.createBook.panel.token.failed")}</p>}
            {isApp && <p>{t("github.createBook.app.token")}</p>}
            {!isApp && ready?.tokenKind === "classic" && <p>{t("github.createBook.panel.token.classic", { scopes: ready.scopes.length ? ready.scopes.join(", ") : t("github.createBook.panel.token.noScopes") })}</p>}
            {!isApp && issues.map((issue) => <p key={issue}>{t(`github.createBook.panel.token.${ISSUE_KEYS[issue]}`)}</p>)}
          </div>
        </section>
      )}
    </div>
  );
}
