import { useEffect, useState } from "react";
import { GitBranch, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { createBranchFromBase, getDefaultBranch, listBranches } from "@/github/githubClient";
import { useBooksStore } from "@/store/booksStore";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveBookToken, type BookEntry } from "@/types/settings";
import { useGitHubRemoteAvailability } from "@/github/remoteAvailability";
import { listLocalRepositoriesByBook } from "@/repository/localRepository";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import "@/i18n/localFirst";
import { AUTO_BRANCH } from "@/bookSettings/draft";
import { workingBranchState } from "@/bookSettings/branchState";

interface Props {
  book: BookEntry;
  activeBranch: string;
  onActiveBranch: (branch: string) => void;
}

/**
 * The working branch of the book. A book on this device has a local working branch, only here; the card says so. Once the book is on GitHub the branch is a
 * GitHub branch («published as …»): the book reads and writes it there, and the card lists the repository's branches, and makes a new one from the default.
 * The branches with a working copy on this device are always offered: they open without GitHub. Listing GitHub's and making one need GitHub, and without it
 * (no credential, one GitHub refused, offline) the card says why instead of doing nothing.
 */
export function WorkingBranchCard({ book, activeBranch, onActiveBranch }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const settings = useSettingsStore((state) => state.settings);
  const { structures, workingBranches } = useBooksStore();
  const structure = structures[book.id];
  const remote = useGitHubRemoteAvailability(book, resolveBookToken(book, settings));
  const [branches, setBranches] = useState<string[]>([]);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState(structure?.defaultBranch ?? "main");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const autoBranch = workingBranches[book.id] ?? structure?.defaultBranch ?? "main";
  const state = workingBranchState({ storageMode: book.storageMode, activeBranch: activeBranch === AUTO_BRANCH ? undefined : activeBranch }, autoBranch);

  useEffect(() => {
    if (bookStorageMode(book) !== "github") return undefined;
    let cancelled = false;
    const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    void listLocalRepositoriesByBook(book.id, currentRepositoryScopeIdentity())
      .then((rows) => { if (!cancelled) setLocalBranches(rows.filter((row) => row.cloneComplete === true && same(row.owner, book.owner) && same(row.repo, book.repo)).map((row) => row.branch)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [book]);
  const choices = [...new Set([...localBranches, ...branches])].sort();

  async function loadRemoteBranches() {
    const token = resolveBookToken(book, settings);
    if (remote !== "ready") return;
    setLoading(true);
    await Promise.all([listBranches(token, book.owner, book.repo), getDefaultBranch(token, book.owner, book.repo)])
      .then(([items, defaultBranch]) => { setBranches(items.map((entry) => entry.name)); setBaseBranch(defaultBranch); })
      .catch((error) => { toast({ title: t("bookSettings.loadBranchesFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" }); })
      .finally(() => setLoading(false));
  }

  async function createBranch() {
    if (!newBranchName.trim() || remote !== "ready") return;
    const token = resolveBookToken(book, settings);
    setCreating(true);
    try {
      const next = newBranchName.trim();
      await createBranchFromBase(token, book.owner, book.repo, baseBranch, next);
      setBranches((previous) => [...previous, next].sort());
      onActiveBranch(next);
      setNewBranchName("");
      toast({ title: t("bookSettings.branchCreated", { branch: next }) });
    } catch (error) {
      toast({ title: t("bookSettings.branchCreateFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
    } finally { setCreating(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" />{t("bookSettings.branchWorkspace")}</CardTitle>
        <CardDescription>{t(bookStorageMode(book) === "github" ? "bookSettings.branchDescription" : "localFirst.branchesLocal")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="working-branch-state">
          {state.kind === "device"
            ? <><strong>{t("bookSettings.tabs.localBranch")}</strong> — {t("bookSettings.tabs.onlyOnDevice")}</>
            : <><strong>{state.branch}</strong> — {t("bookSettings.tabs.publishedAs", { branch: state.branch })}</>}
        </p>
        {state.kind === "device" && <p className="text-xs text-muted-foreground">{t("bookSettings.tabs.branchOnConnect")}</p>}
        {bookStorageMode(book) === "github" && (
          <>
            {remote === "offline" && <p className="text-xs text-muted-foreground">{t("localFirst.branchesOffline")}</p>}
            {remote === "no-credential" && <p className="text-xs text-muted-foreground">{t("localFirst.githubNeededNoCredential")} <Link to="/app/settings/github" className="underline underline-offset-2">{t("localFirst.connectGitHub")}</Link></p>}
            <div className="grid gap-2">
              <Label htmlFor="book-active-branch">{t("bookSettings.activeBranch")}</Label>
              <Select value={activeBranch} onValueChange={onActiveBranch} disabled={loading}>
                <SelectTrigger id="book-active-branch" className="w-full max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_BRANCH}>{t("bookSettings.autoDevBranch", { branch: autoBranch })}</SelectItem>
                  {choices.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("bookSettings.defaultBranch")} {baseBranch}</p>
              <Button type="button" variant="outline" className="w-fit" onClick={() => void loadRemoteBranches()} disabled={loading || remote !== "ready"}>{loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <GitBranch className="mr-1 h-4 w-4" />}{t("bookSettings.loadRemoteBranches")}</Button>
            </div>

            <div className="grid gap-2 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">{t("bookSettings.createBranchHint", { base: baseBranch })}</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input aria-label={t("bookSettings.createBranch")} placeholder="feature/new-arc" value={newBranchName} onChange={(event) => setNewBranchName(event.target.value)} />
                <Button onClick={() => void createBranch()} disabled={creating || !newBranchName.trim() || remote !== "ready"}>
                  {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                  {t("bookSettings.createBranch")}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
