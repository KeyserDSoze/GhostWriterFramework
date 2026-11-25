import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { GitBranch, Loader2, Plus, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useListCombobox } from "@/components/ui/use-list-combobox";
import { AutoSyncStatus, relativeTime } from "@/components/branches/AutoSyncStatus";
import { outcomeIsVisible, type BranchOutcomeKind } from "@/branches/autoSyncPolicy";
import { branchNameFromInput, branchNameProblem, suggestBranchName } from "@/branches/branchNames";
import { createBranch, setBookAutoSyncMode, switchBranch } from "@/branches/branchActions";
import { bookAutoSyncMode, bookBranchMemory } from "@/branches/memory";
import { cachedRemoteBranches, listRemoteBranches } from "@/branches/remoteBranches";
import { useBranchSyncStore } from "@/branches/syncStore";
import { requestBranchSync } from "@/branches/useBranchAutoSync";
import type { GitHubRemoteAvailability } from "@/github/remoteAvailability";
import { getLocalRepositoryStatusSnapshot, listLocalRepositoriesByBook } from "@/repository/localRepository";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "@/lib/utils";
import type { BookEntry, KnownBranchRecord } from "@/types/settings";
import "@/i18n/branches";

export interface BranchSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: BookEntry;
  /** The branch open now. */
  branch: string;
  /** It was made on this device and is not on GitHub yet. */
  pending: boolean;
  remote: GitHubRemoteAvailability;
  token: string;
  /** The Sync of the book (with its conflict dialog), for a branch GitHub and this device both changed. */
  onSyncNow: () => void;
}

interface CopyState { pending: boolean; dirty: number; ahead: number }

interface BranchRow {
  key: string;
  name: string;
  current: boolean;
  known?: KnownBranchRecord;
  copy?: CopyState;
  onGitHub: boolean;
  outcome?: BranchOutcomeKind;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** The copies of the book's branches on this device, with what each has not published; and GitHub's branches, as last listed, then asked again. */
function useBranchFacts(book: BookEntry, open: boolean, remote: GitHubRemoteAvailability, token: string) {
  const identity = currentRepositoryScopeIdentity();
  const [copies, setCopies] = useState<Map<string, CopyState>>(new Map());
  const [remoteHeads, setRemoteHeads] = useState<Map<string, string>>(() => cachedRemoteBranches(identity, book.owner, book.repo)?.heads ?? new Map());
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void (async () => {
      const rows = (await listLocalRepositoriesByBook(book.id, identity).catch(() => [])).filter((row) => row.cloneComplete === true && same(row.owner, book.owner) && same(row.repo, book.repo));
      const next = new Map<string, CopyState>();
      for (const row of rows) {
        const snapshot = await getLocalRepositoryStatusSnapshot(book.owner, book.repo, row.branch, identity).catch(() => null);
        next.set(row.branch, { pending: Boolean(row.pendingBranch), dirty: snapshot?.status.dirty ?? 0, ahead: snapshot?.status.ahead ?? 0 });
      }
      if (!cancelled) setCopies(next);
    })();
    // The list shows what this device knows at once; GitHub is asked again (conditionally: an unchanged list costs nothing) only when it can be.
    if (remote === "ready") {
      void listRemoteBranches({ token, owner: book.owner, repo: book.repo, accountIdentity: identity })
        .then((listing) => { if (!cancelled) setRemoteHeads(listing.heads); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [open, book.id, book.owner, book.repo, identity, remote, token]);
  return { copies, remoteHeads };
}

/**
 * The branches of the book, from the top bar: the current one and what concerns it, the automatic sync of the book (off said and switched in one place), every
 * branch the person worked on and the others GitHub has, found by typing (a combobox: the arrows move through the list, Enter opens the branch), and a new
 * branch in one action, with a suggested name, made on this device from the current one and published now or with the next sync.
 */
export function BranchSwitcherDialog({ open, onOpenChange, book, branch, pending, remote, token, onSyncNow }: BranchSwitcherDialogProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const locale = i18n.resolvedLanguage || i18n.language;
  const settings = useSettingsStore((state) => state.settings);
  const memory = bookBranchMemory(settings, book);
  const mode = bookAutoSyncMode(settings, book);
  const outcomes = useBranchSyncStore((state) => state.books[book.id]?.branches);
  const { copies, remoteHeads } = useBranchFacts(book, open, remote, token);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const base = useId();

  const rows = useMemo<BranchRow[]>(() => {
    const known = [...(memory?.knownBranches ?? [])].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
    const names = [branch, ...known.map((entry) => entry.name), ...[...copies.keys()].sort(), ...[...remoteHeads.keys()].sort()];
    const unique = [...new Set(names)];
    const needle = query.trim().toLowerCase();
    return unique
      .map((name) => ({ key: name, name, current: name === branch, known: known.find((entry) => entry.name === name), copy: copies.get(name) ?? (name === branch ? { pending, dirty: 0, ahead: 0 } : undefined), onGitHub: remoteHeads.has(name), outcome: outcomes?.[name]?.outcome }))
      .filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.known?.label?.toLowerCase().includes(needle));
  }, [branch, copies, memory, outcomes, pending, query, remoteHeads]);
  const taken = useMemo(() => new Set([branch, ...(memory?.knownBranches ?? []).map((entry) => entry.name), ...copies.keys(), ...remoteHeads.keys()]), [branch, copies, memory, remoteHeads]);

  const [newName, setNewName] = useState("");
  const [publishNow, setPublishNow] = useState(false);
  useEffect(() => {
    if (open) { setQuery(""); setNewName(suggestBranchName(taken)); setPublishNow(false); }
    // The suggestion is made when the dialog opens: it does not change under the person while they type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const normalized = branchNameFromInput(newName);
  const problem = taken.has(normalized) ? "taken" : branchNameProblem(normalized);

  const reachable = (row: BranchRow) => Boolean(row.copy) || remote === "ready";
  const choose = async (row: BranchRow) => {
    if (row.current) { onOpenChange(false); return; }
    if (!reachable(row) || busy) return;
    setBusy(row.name);
    try {
      await switchBranch(book.id, row.name);
      onOpenChange(false);
      toast({ title: t("branches.switcher.switched", { branch: row.name }), description: t("branches.switcher.switchedDescription", { previous: branch }) });
    } catch (error) {
      toast({ title: t("branches.switcher.switchFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
    } finally { setBusy(null); }
  };
  const combobox = useListCombobox({ rows, query, alwaysOpen: true, selectedKey: branch, onChoose: (row) => { void choose(row); } });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || busy) return;
    const name = normalized;
    setBusy("create");
    try {
      const result = await createBranch({ bookId: book.id, from: branch, name, publishNow: publishNow && remote === "ready", token });
      onOpenChange(false);
      if (result.publishError || result.published?.outcome === "name-taken") {
        const reason = result.published?.outcome === "name-taken" ? t("branches.outcome.nameTaken", { branch: name }) : repositoryErrorDescription(result.publishError, t);
        toast({ title: t("branches.switcher.created", { branch: name }), description: t("branches.switcher.publishFailed", { reason }), variant: "destructive" });
      } else {
        toast({ title: t("branches.switcher.created", { branch: name }), description: t(result.published ? "branches.switcher.createdPublished" : mode === "off" ? "branches.switcher.createdOff" : "branches.switcher.createdLater") });
      }
    } catch (error) {
      toast({ title: t("branches.switcher.createFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const describe = (row: BranchRow): string => {
    const parts: string[] = [];
    if (row.current) parts.push(t("branches.switcher.state.current"));
    if (row.outcome && outcomeIsVisible(row.outcome)) parts.push(t(`branches.switcher.state.${row.outcome}`));
    if (row.copy?.pending) parts.push(t("branches.switcher.state.pending"));
    else if (row.copy) {
      parts.push(t(row.onGitHub ? "branches.switcher.state.github" : "branches.switcher.state.here"));
      if (row.copy.dirty) parts.push(t("branches.switcher.state.changes", { count: row.copy.dirty }));
      if (row.copy.ahead) parts.push(t("branches.switcher.state.commits", { count: row.copy.ahead }));
    } else if (row.onGitHub) parts.push(t(remote === "ready" ? "branches.switcher.state.onlyGitHub" : "branches.switcher.state.needsGitHub"));
    if (row.known && !row.current) parts.push(t("branches.switcher.state.lastUsed", { when: relativeTime(Date.parse(row.known.lastUsedAt), Date.now(), locale) }));
    return parts.join(" · ");
  };

  const currentRow = rows.find((row) => row.current) ?? { key: branch, name: branch, current: true, copy: { pending, dirty: 0, ahead: 0 }, onGitHub: remoteHeads.has(branch), outcome: outcomes?.[branch]?.outcome };
  const currentLabel = memory?.knownBranches.find((entry) => entry.name === branch)?.label;
  const [said, setSaid] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSaid(rows.length ? t("branches.switcher.count", { count: rows.length }) : t("branches.switcher.none")), query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [rows.length, query, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto p-4 sm:p-6"
        data-testid="branch-switcher"
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" aria-hidden="true" />{t("branches.switcher.title")}</DialogTitle>
          <DialogDescription>{t("branches.switcher.description", { book: book.name })}</DialogDescription>
        </DialogHeader>

        <section aria-labelledby={`${base}-current`} className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          <h3 id={`${base}-current`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("branches.switcher.current")}</h3>
          <p className="font-semibold [overflow-wrap:anywhere]">{branch}{currentLabel ? <span className="ml-1 font-normal text-muted-foreground">{t("branches.switcher.label", { label: currentLabel })}</span> : null}</p>
          <p className="text-xs text-muted-foreground" data-testid="current-branch-state">{describe(currentRow) || t("branches.switcher.state.inSync")}</p>
          {mode === "off" && <p className="text-xs font-medium" data-testid="auto-sync-off">{t("branches.autoSync.mode.off")}</p>}
          {currentRow.outcome === "diverged" && (
            <Button type="button" size="sm" className="mt-1" onClick={() => { onOpenChange(false); onSyncNow(); }}><RefreshCcw className="mr-1 h-4 w-4" aria-hidden="true" />{t("branches.switcher.syncNow")}</Button>
          )}
        </section>

        {(remote === "no-credential" || remote === "offline") && (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t(`branches.switcher.noGitHub.${remote}`)}{" "}
            {remote === "no-credential" && <Link to="/app/settings/github" className="underline underline-offset-2" onClick={() => onOpenChange(false)}>{t("branches.switcher.connect")}</Link>}
          </p>
        )}

        <div className="grid gap-2">
          <Label htmlFor={`${base}-find`}>{t("branches.switcher.find")}</Label>
          <input
            ref={inputRef}
            id={`${base}-find`}
            type="text"
            {...combobox.inputProps}
            value={query}
            placeholder={t("branches.switcher.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
            className="flex h-10 w-full rounded-md border border-field bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [@media(pointer:coarse)]:h-11"
          />
          <ul id={combobox.listId} role="listbox" aria-label={t("branches.switcher.listLabel")} className="max-h-64 overflow-y-auto rounded-md border border-layer bg-popover p-1 text-popover-foreground">
            {rows.map((row, index) => (
              <li
                key={row.key}
                {...combobox.optionProps(index)}
                aria-disabled={!reachable(row) || undefined}
                aria-current={row.current || undefined}
                data-branch={row.name}
                className={cn("min-h-11 cursor-pointer rounded-sm px-3 py-2", index === combobox.active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60", !reachable(row) && "cursor-not-allowed opacity-60")}
              >
                <span className="flex items-center gap-2 text-sm">
                  <span className={cn("[overflow-wrap:anywhere]", row.current ? "font-semibold" : "font-medium")}>{row.name}</span>
                  {row.known?.label && <span className="text-muted-foreground">{t("branches.switcher.label", { label: row.known.label })}</span>}
                  {busy === row.name && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
                  {row.outcome && outcomeIsVisible(row.outcome) && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{describe(row)}</span>
              </li>
            ))}
            {!rows.length && <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">{t("branches.switcher.none")}</li>}
          </ul>
          <div role="status" aria-live="polite" className="sr-only">{said}</div>
        </div>

        <form onSubmit={(event) => void create(event)} className="grid gap-2 rounded-md border border-dashed p-3" aria-labelledby={`${base}-new`}>
          <h3 id={`${base}-new`} className="text-sm font-medium">{t("branches.switcher.create.title")}</h3>
          <Label htmlFor={`${base}-name`} className="text-xs text-muted-foreground">{t("branches.switcher.create.name")}</Label>
          <Input
            id={`${base}-name`}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            aria-invalid={Boolean(problem) || undefined}
            aria-describedby={`${base}-name-hint ${base}-name-result`}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={`${base}-name-hint`} className="text-xs text-muted-foreground">{t("branches.switcher.create.hint", { branch })} {t(publishNow && remote === "ready" ? "branches.switcher.create.publishNow" : mode === "off" ? "branches.switcher.create.publishOff" : "branches.switcher.create.publishLater")}</p>
          <p id={`${base}-name-result`} className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
            {problem ? t(`branches.switcher.create.problems.${problem}`) : normalized !== newName.trim() ? t("branches.switcher.create.willBe", { name: normalized }) : ""}
          </p>
          <label className="flex min-h-6 items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={publishNow && remote === "ready"} disabled={remote !== "ready"} onChange={(event) => setPublishNow(event.target.checked)} />
            {t("branches.switcher.create.publishNow")}
          </label>
          <Button type="submit" className="w-fit" disabled={Boolean(problem) || Boolean(busy)}>
            {busy === "create" ? <Loader2 className="mr-1 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Plus className="mr-1 h-4 w-4" aria-hidden="true" />}
            {busy === "create" ? t("branches.switcher.create.creating") : t("branches.switcher.create.submit")}
          </Button>
        </form>
        <section aria-labelledby={`${base}-sync`} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label id={`${base}-sync`} htmlFor={`${base}-sync-switch`} className="text-sm font-medium">{t("branches.switcher.autoSync.title")}</Label>
            <Switch id={`${base}-sync-switch`} checked={mode !== "off"} onCheckedChange={(on) => { void setBookAutoSyncMode(book.id, on ? "on" : "off"); }} aria-describedby={`${base}-sync-status`} />
          </div>
          <div id={`${base}-sync-status`} className="space-y-1 text-xs text-muted-foreground">
            <AutoSyncStatus bookId={book.id} mode={mode} className="space-y-1" />
            <p>{t("branches.switcher.autoSync.hint")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="button" variant="outline" size="sm" disabled={remote !== "ready"} onClick={() => requestBranchSync(book.id, "manual", branch)}><RefreshCcw className="mr-1 h-4 w-4" aria-hidden="true" />{t("branches.switcher.autoSync.syncAll")}</Button>
            <Link to={`/app/books/${book.id}/settings#github`} className="text-xs underline underline-offset-2" onClick={() => onOpenChange(false)}>{t("branches.switcher.autoSync.more")}</Link>
          </div>
        </section>

      </DialogContent>
    </Dialog>
  );
}
