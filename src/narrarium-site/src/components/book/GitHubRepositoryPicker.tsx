import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import "@/i18n/githubRepositoryPicker";
import "@/i18n/githubApp";
import "@/i18n/bookGithub";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { GITHUB_APP_SLUG } from "@/config/publicClients";
import { repositoryNameProblem } from "@/github/bookRepository";
import { installAppUrl } from "@/github/githubAppInstall";
import { useAppInstallations } from "@/github/useAppInstallations";
import { ListingError, inspectRepository, listingSources, repositoryNameIsFree } from "@/github/repositoryListing";
import { useRepositoryListing } from "@/github/useRepositoryListing";
import {
  addedRepositories,
  decisionReady,
  existingRepositoryOutcome,
  filterRepositories,
  resolvePickerMode,
  resolveRepositoryName,
  suggestRepositoryName,
  type ExistingOutcome,
  type ExistingState,
  type PickerContext,
  type PickerMode,
  type PickerRepository,
  type RepositoryDecision,
} from "@/github/repositoryPickerModel";
import { GitHubRepositoryPanel, ownerOf, type GitHubPreflightState, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { RepositoryCombobox } from "@/components/book/RepositoryCombobox";

const CHOICE = "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-ring";
const FIELD = "flex h-10 w-full rounded-md border border-field bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11";
/** When a query leaves fewer matches than this among the repositories read so far, the next page is read by itself (a few times), so that a search finds its repository in a big account. */
const SEARCH_WANTS = 8;
const SEARCH_AUTO_PAGES = 5;

export interface GitHubRepositoryPickerProps {
  /** `add`: a new book; `attach`: the book of this device. It changes only the words, and the book that is already in a repository (see `existingRepositoryOutcome`). */
  context: PickerContext;
  token: string;
  /** Whether the credential is the user token of the GitHub app (it reaches only the repositories the app is installed on). */
  app: boolean;
  /** The login of the connection, when it is known (the app's account, or the user of a token). */
  login?: string;
  /** Names the credential in the cache of the lists (`credentialCacheKey`). */
  cacheKey: string;
  /** The name proposed for a new repository (from the title of the book). */
  defaultName: string;
  choices: GitHubRepositoryChoices;
  onChoicesChange: (choices: GitHubRepositoryChoices) => void;
  preflight: GitHubPreflightState;
  /** The books that are on GitHub already, to mark their repositories in the list. */
  books: ReadonlyArray<{ owner: string; repo: string }>;
  disabled?: boolean;
  onDecision: (decision: RepositoryDecision) => void;
}

type Inspection = { status: "idle" } | { status: "checking" } | { status: "ready"; state: ExistingState } | { status: "failed"; why: string };
type NameCheck = { status: "idle" } | { status: "checking" } | { status: "free" } | { status: "taken"; suggestion: string };

function failureText(t: (key: string, options?: Record<string, unknown>) => string, error: ListingError, locale: string | undefined): string {
  const reset = error.resetAt ? new Date(error.resetAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : undefined;
  if (error.reason === "rate-limit") return t(reset ? "github.picker.error.rate-limit" : "github.picker.error.rate-limit-unknown", { reset });
  if (error.reason === "unknown") return t(error.status ? "github.picker.error.unknown" : "github.picker.error.unknown-nostatus", { status: error.status });
  return t(`github.picker.error.${error.reason}`);
}

/**
 * The choice of the repository, the same where a book is added and where a book of this device is connected: two modes (connect one that is there, picked
 * from a searchable list; create a new one with a name of one's own), and, for the repository that was picked, what is done with it. It reports what was
 * decided (`onDecision`); the page acts on it. Nothing is written here, and a repository that is not empty is replaced only when the person turns that on.
 */
export function GitHubRepositoryPicker(props: GitHubRepositoryPickerProps) {
  const { context, token, app, login, cacheKey, defaultName, choices, onChoicesChange, preflight, books, disabled, onDecision } = props;
  const { t, i18n } = useTranslation();
  const base = useId();
  const locale = i18n.resolvedLanguage || i18n.language;

  const [chosenMode, setChosenMode] = useState<PickerMode | null>(null);
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState<PickerRepository | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection>({ status: "idle" });
  const [nameCheck, setNameCheck] = useState<NameCheck>({ status: "idle" });
  const autoPages = useRef(0);

  const preflightLogin = preflight.status === "ready" ? preflight.preflight.login : undefined;
  const accountLogin = login ?? preflightLogin ?? "";

  const installs = useAppInstallations(token || undefined, app && Boolean(token));
  const installations = installs.status === "ready" ? installs.installations : installs.status === "loading" || installs.status === "error" ? installs.installations : null;
  const sources = useMemo(() => {
    if (!token) return null;
    if (app) return installations ? listingSources({ app: true, login: accountLogin, scope, installations: installations.map((entry) => ({ id: entry.id, account: entry.account, suspended: entry.suspended })) }) : null;
    return listingSources({ app: false, login: accountLogin, scope });
  }, [token, app, accountLogin, scope, installations]);
  const listing = useRepositoryListing({ token: token || undefined, cacheKey, sources });
  const listingProgress = listing.status === "ready" ? { status: "ready" as const, count: listing.items.length } : listing.status === "error" ? { status: "error" as const } : listing.status === "loading" ? { status: "loading" as const } : { status: "idle" as const };
  const mode = resolvePickerMode(chosenMode, listingProgress);

  // A new credential is a new list.
  useEffect(() => { setScope(""); setQuery(""); setRepository(null); setInspection({ status: "idle" }); setOverwrite(false); }, [cacheKey]);

  const scopes = useMemo(() => {
    const owners = app ? (installations ?? []).filter((entry) => !entry.suspended).map((entry) => entry.account) : [accountLogin, ...(preflight.status === "ready" ? preflight.preflight.organizations : [])].filter(Boolean);
    return [...new Set(owners)];
  }, [app, installations, accountLogin, preflight]);

  const filtered = useMemo(() => filterRepositories(listing.items, query), [listing.items, query]);
  const added = useMemo(() => addedRepositories(books), [books]);

  // A query that finds little among what was read reads the next page, a few times, a moment after the typing stops: a search finds its repository in a big account without reading it all.
  useEffect(() => { autoPages.current = 0; }, [query, scope, cacheKey]);
  useEffect(() => {
    if (mode !== "existing" || !query.trim() || listing.status !== "ready" || !listing.hasMore || listing.loadingMore || listing.error) return;
    if (filtered.length >= SEARCH_WANTS || autoPages.current >= SEARCH_AUTO_PAGES) return;
    const timer = setTimeout(() => { autoPages.current += 1; listing.loadMore(); }, 450);
    return () => clearTimeout(timer);
  }, [mode, query, listing.status, listing.hasMore, listing.loadingMore, listing.error, listing.items.length, filtered.length, listing]);

  // What the repository that was picked holds.
  const inspected = useRef(new Map<number, ExistingState>());
  useEffect(() => {
    if (!repository || !token) { setInspection({ status: "idle" }); return; }
    const known = inspected.current.get(repository.id);
    if (known) { setInspection({ status: "ready", state: known }); return; }
    const controller = new AbortController();
    setInspection({ status: "checking" });
    void inspectRepository(token, { owner: repository.owner, repo: repository.name, defaultBranch: repository.defaultBranch }, controller.signal).then(
      (state) => { inspected.current.set(repository.id, state); setInspection({ status: "ready", state }); },
      (error: unknown) => { if (!controller.signal.aborted) setInspection({ status: "failed", why: error instanceof ListingError ? failureText(t, error, locale) : "" }); },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository, token]);

  const name = resolveRepositoryName(typedName, defaultName);
  const nameProblem = name ? repositoryNameProblem(name) : null;
  const owner = ownerOf(choices) ?? (accountLogin || undefined);

  // Whether the name of a new repository is free, a moment after the typing stops; a name that is taken gets the next free one as a suggestion.
  useEffect(() => {
    setNameCheck({ status: "idle" });
    if (mode !== "create" || !token || !owner || !name || nameProblem) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setNameCheck({ status: "checking" });
      try {
        if (await repositoryNameIsFree(token, owner, name, controller.signal)) { setNameCheck({ status: "free" }); return; }
        const tried: string[] = [name];
        let suggestion = suggestRepositoryName(name, tried);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await repositoryNameIsFree(token, owner, suggestion, controller.signal)) break;
          tried.push(suggestion);
          suggestion = suggestRepositoryName(name, tried);
        }
        setNameCheck({ status: "taken", suggestion });
      } catch {
        if (!controller.signal.aborted) setNameCheck({ status: "idle" });
      }
    }, 600);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, token, owner, name, nameProblem]);

  const outcome: ExistingOutcome | null = repository && inspection.status === "ready"
    ? existingRepositoryOutcome({ state: inspection.state, overwrite, canPush: repository.canPush, archived: repository.archived })
    : null;
  const nameTaken = nameCheck.status === "taken";
  const decision: RepositoryDecision = mode === "create"
    ? { mode, name, owner: ownerOf(choices), repository: null, outcome: null, overwrite: false, ready: decisionReady({ mode, nameProblem, name, nameTaken, repository: null, outcome: null }) }
    : { mode, name: repository?.name ?? "", owner: repository?.owner, repository, outcome, overwrite, ready: decisionReady({ mode, nameProblem: null, name: repository?.name ?? "", nameTaken: false, repository, outcome }) };
  const signature = JSON.stringify([decision.mode, decision.name, decision.owner, decision.repository?.id, decision.outcome?.kind, decision.overwrite, decision.ready]);
  const reported = useRef("");
  useEffect(() => {
    if (reported.current === signature) return;
    reported.current = signature;
    onDecision(decision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const installLink = GITHUB_APP_SLUG ? (installations && installations.length === 1 ? installations[0].settingsUrl : installAppUrl()) : null;
  const picked = repository ? repository.fullName : "";
  const outcomeText = outcome && repository
    ? outcome.kind === "cannot-write" ? t("github.picker.outcome.cannotWrite", { repo: picked })
      : t(`github.picker.outcome.${context}.${outcome.kind === "connect-book" ? "connectBook" : outcome.kind === "publish-empty" ? "publishEmpty" : outcome.kind === "needs-overwrite" ? "needsOverwrite" : "publishOverwrite"}`, { repo: picked, branch: repository.defaultBranch })
    : "";

  const hintId = `${base}-hint`;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{t("github.picker.mode.legend")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["existing", "create"] as const).map((value) => (
            <label key={value} className={cn(CHOICE, mode === value ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
              <input type="radio" name={`${base}-mode`} value={value} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={mode === value} aria-labelledby={`${base}-${value}-name`} aria-describedby={`${base}-${value}-hint`} onChange={() => setChosenMode(value)} />
              <span className="min-w-0 space-y-1">
                <span id={`${base}-${value}-name`} className="block text-sm font-medium">{t(`github.picker.mode.${value}`)}</span>
                <span id={`${base}-${value}-hint`} className="block text-xs text-muted-foreground">{t(`github.picker.mode.${value}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === "existing" && (
        <div className="space-y-3">
          {scopes.length > 1 && (
            <div className="grid gap-2 sm:max-w-md">
              <Label htmlFor={`${base}-scope`}>{t("github.picker.list.scope")}</Label>
              <select id={`${base}-scope`} className={FIELD} value={scope} disabled={disabled} onChange={(event) => { setScope(event.target.value); setRepository(null); setQuery(""); }}>
                <option value="">{t("github.picker.list.scopeAll")}</option>
                {scopes.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </div>
          )}

          <RepositoryCombobox
            label={t("github.picker.list.label")}
            items={filtered}
            loaded={listing.items.length}
            added={added}
            selectedId={repository?.id ?? null}
            query={query}
            onQueryChange={(next) => { setQuery(next); if (repository && next !== repository.fullName) setRepository(null); }}
            onSelect={(next) => { setRepository(next); setOverwrite(false); }}
            status={listing.status}
            hasMore={listing.hasMore}
            loadingMore={listing.loadingMore}
            onLoadMore={listing.loadMore}
            disabled={disabled || !token}
            describedBy={hintId}
          />
          <p id={hintId} className="text-xs text-muted-foreground">{t("github.picker.list.hint")}</p>
          {!token && <p className="text-sm text-muted-foreground" role="status">{t("bookSettings.connectGithub.noToken")}</p>}

          {listing.status === "loading" && (
            <div aria-hidden="true" className="space-y-2">
              {[0, 1, 2].map((row) => <Skeleton key={row} className="h-11 w-full" />)}
            </div>
          )}

          {listing.error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="space-y-2">
                {listing.status === "error" && <p className="font-medium">{t("github.picker.error.title")}</p>}
                <p>{failureText(t, listing.error, locale)}</p>
                <Button type="button" variant="outline" className="h-auto min-h-9 [@media(pointer:coarse)]:min-h-11" onClick={listing.status === "error" ? listing.reload : listing.loadMore}>{t("github.picker.list.retry")}</Button>
              </AlertDescription>
            </Alert>
          )}

          {listing.status === "ready" && !listing.error && listing.items.length === 0 && !app && <p className="text-sm text-muted-foreground">{t("github.picker.list.emptyAll")}</p>}
          {listing.status === "ready" && listing.items.length > 0 && query.trim() && !repository && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground" role="status">{t("github.picker.list.empty", { query: query.trim() })}{listing.hasMore ? ` ${t("github.picker.list.emptyMore")}` : ""}</p>
          )}

          {app && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">{t("github.picker.app.title")}</p>
              <p>{installs.status === "ready" && installs.installations.length === 0 ? t("github.picker.app.none") : t("github.picker.app.only")}</p>
              {installs.status === "error" && <p role="status">{t("github.picker.app.installError")}</p>}
              {installations?.filter((entry) => entry.suspended).map((entry) => <p key={entry.id}>{t("github.picker.app.suspended", { account: entry.account })}</p>)}
              {installs.status === "ready" && installs.installations.length > 0 && <p>{t("github.picker.app.missing")}</p>}
              <div className="flex flex-wrap gap-2">
                {installLink && (
                  <Button asChild variant="outline" className="h-auto min-h-9 whitespace-normal text-left [@media(pointer:coarse)]:min-h-11">
                    <a href={installLink} target="_blank" rel="noopener noreferrer">{installs.status === "ready" && installs.installations.length === 0 ? t("accountSync.github.install.choose") : t("accountSync.github.install.manage")}<span className="sr-only"> {t("accountSync.github.install.opensNewTab")}</span><ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
                  </Button>
                )}
                <Button type="button" variant="outline" className="h-auto min-h-9 [@media(pointer:coarse)]:min-h-11" onClick={() => { installs.reload(); listing.reload(); }}>{t("github.picker.list.reload")}</Button>
              </div>
            </div>
          )}

          {repository && (
            <div className="space-y-3 rounded-lg border p-3 text-sm [overflow-wrap:anywhere]" aria-live="polite">
              {inspection.status === "checking" && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("github.picker.inspect.checking", { repo: picked })}</p>}
              {inspection.status === "failed" && <p>{t("github.picker.inspect.failed", { repo: picked, why: inspection.why || "?" })}</p>}
              {outcomeText && <p>{outcomeText}</p>}
              {outcome?.kind === "connect-book" && outcome.readOnly && <p>{t("github.picker.outcome.readOnlyBook", { repo: picked })}</p>}
              {(outcome?.kind === "needs-overwrite" || outcome?.kind === "publish-overwrite") && (
                <div className="flex items-start gap-3 rounded-md border border-destructive/40 p-3">
                  <Switch id={`${base}-overwrite`} checked={overwrite} disabled={disabled} onCheckedChange={setOverwrite} />
                  <div>
                    <Label htmlFor={`${base}-overwrite`}>{context === "attach" ? t("bookSettings.connectGithub.overwrite") : t("github.picker.overwrite.add")}</Label>
                    <p className="text-xs text-muted-foreground">{context === "attach" ? t("bookSettings.connectGithub.overwriteHint") : t("github.picker.overwrite.addHint")}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "create" && (
        <div className="space-y-4">
          <div className="grid min-w-0 gap-2 sm:max-w-md">
            <Label htmlFor={`${base}-name`}>{t("github.picker.create.nameLabel")}</Label>
            <Input
              id={`${base}-name`}
              className="[@media(pointer:coarse)]:h-11"
              value={typedName ?? defaultName}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameProblem || nameTaken ? true : undefined}
              aria-describedby={`${base}-name-hint`}
              onChange={(event) => setTypedName(event.target.value)}
            />
            <div id={`${base}-name-hint`} className="min-w-0 space-y-1 text-xs [overflow-wrap:anywhere]">
              <p className={nameProblem ? "text-destructive" : "text-muted-foreground"}>{nameProblem ? t(`github.createBook.panel.nameProblem.${nameProblem}`) : typedName === null ? t("github.picker.create.hintDerived") : t("github.picker.create.hintTyped")}</p>
              <p role="status" aria-live="polite" className="text-muted-foreground">{nameCheck.status === "checking" ? t("github.picker.create.checking") : ""}</p>
              {nameCheck.status === "taken" && (
                <div className="flex flex-wrap items-center gap-2 text-destructive" role="alert">
                  <span>{t("github.picker.create.taken", { name, owner: owner ?? "" })} {t("github.picker.create.suggestIntro", { name: nameCheck.suggestion })}</span>
                  <Button type="button" variant="outline" className="h-auto min-h-9 whitespace-normal text-left text-foreground [overflow-wrap:anywhere] [@media(pointer:coarse)]:min-h-11" disabled={disabled} onClick={() => setTypedName(nameCheck.suggestion)}>{t("github.picker.create.suggest", { name: nameCheck.suggestion })}</Button>
                </div>
              )}
            </div>
          </div>
          <GitHubRepositoryPanel choices={choices} onChange={onChoicesChange} preflight={preflight} disabled={disabled} hasToken={Boolean(token)} app={app} />
        </div>
      )}
    </div>
  );
}
