import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, GitBranch, KeyRound, Loader2, Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { resolveBookToken, type BookEntry } from "@/types/settings";
import { createBranchFromBase, getDefaultBranch, listBranches } from "@/github/githubClient";

type TokenMode = "default" | "custom" | string;

function initialMode(book: BookEntry): TokenMode {
  if (book.bookToken) return "custom";
  if (book.tokenIndex != null) return String(book.tokenIndex);
  return "default";
}

export function BookSettingsPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus } = useSettings();
  const { clearBook, structures, workingBranches } = useBooksStore();

  const book = settings.books.find((entry) => entry.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;

  const [name, setName] = useState(book?.name ?? "");
  const [mode, setMode] = useState<TokenMode>(book ? initialMode(book) : "default");
  const [customToken, setCustomToken] = useState(book?.bookToken ?? "");
  const [customTokenLabel, setCustomTokenLabel] = useState(book?.bookTokenLabel ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [activeBranch, setActiveBranch] = useState(book?.activeBranch ?? "__auto__");
  const [newBranchName, setNewBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState(structure?.defaultBranch ?? "main");
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);

  useEffect(() => {
    if (!book) return;
    const token = resolveBookToken(book, settings);
    if (!token) return;
    setLoadingBranches(true);
    Promise.all([
      listBranches(token, book.owner, book.repo),
      getDefaultBranch(token, book.owner, book.repo),
    ])
      .then(([items, defaultBranch]) => {
        setBranches(items.map((entry) => entry.name));
        setBaseBranch(defaultBranch);
      })
      .catch((err) => {
        toast({ title: "Failed to load branches", description: String(err), variant: "destructive" });
      })
      .finally(() => setLoadingBranches(false));
  }, [book, settings, toast]);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Book not found. <Link to="/app/books" className="underline">Back to books</Link>
        </AlertDescription>
      </Alert>
    );
  }

  const currentBook = book;
  const isSaving = syncStatus === "saving";
  const currentToken = resolveBookToken(currentBook, settings);
  const currentAutoBranch = workingBranches[currentBook.id] ?? (structure?.defaultBranch ?? "main");

  async function handleSave() {
    const usingCustom = mode === "custom";
    const updated: BookEntry = {
      ...currentBook,
      name: name.trim() || currentBook.repo,
      tokenIndex: mode === "default" || usingCustom ? null : Number(mode),
      bookToken: usingCustom ? customToken.trim() || undefined : undefined,
      bookTokenLabel: usingCustom ? customTokenLabel.trim() || `${currentBook.repo} PAT` : undefined,
      activeBranch: activeBranch === "__auto__" ? undefined : activeBranch,
    };

    patchSettings({ books: settings.books.map((entry) => (entry.id === currentBook.id ? updated : entry)) });
    await save();
    clearBook(currentBook.id);
    toast({ title: "Book settings saved" });
    navigate(`/app/books/${currentBook.id}`);
  }

  async function handleCreateBranch() {
    if (!newBranchName.trim()) return;
    const token = resolveBookToken(currentBook, settings);
    if (!token) {
      toast({ title: "Missing token", description: "Configure a GitHub token first.", variant: "destructive" });
      return;
    }
    setCreatingBranch(true);
    try {
      const nextBranch = newBranchName.trim();
      await createBranchFromBase(token, currentBook.owner, currentBook.repo, baseBranch, nextBranch);
      setBranches((prev) => [...prev, nextBranch].sort());
      setActiveBranch(nextBranch);
      setNewBranchName("");
      toast({ title: `Branch ${nextBranch} created` });
    } catch (err) {
      toast({ title: "Branch create failed", description: String(err), variant: "destructive" });
    } finally {
      setCreatingBranch(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/app/books/${currentBook.id}`}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {currentBook.name}
        </Link>
      </Button>

      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Book settings</h1>
        <p className="text-muted-foreground">{currentBook.owner}/{currentBook.repo}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Display name shown in your library.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="book-name">Name</Label>
            <Input id="book-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" />Branch workspace</CardTitle>
          <CardDescription>
            Choose which branch this book reads and writes. Auto keeps using the personal dev branch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Active branch</Label>
            <Select value={activeBranch} onValueChange={setActiveBranch} disabled={loadingBranches}>
              <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">Auto dev branch ({currentAutoBranch})</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Default branch: {baseBranch}</p>
          </div>

          <div className="grid gap-2 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">Create a new branch from {baseBranch} and switch this book to it.</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input placeholder="feature/new-arc" value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} />
              <Button onClick={() => void handleCreateBranch()} disabled={creatingBranch || !newBranchName.trim()}>
                {creatingBranch ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                Create branch
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />GitHub access for this book</CardTitle>
          <CardDescription>
            Choose which token this book uses. A dedicated PAT lets you scope access to just this repository, even when a default token exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Token</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default token{settings.defaultGitHubToken ? ` (…${settings.defaultGitHubToken.slice(-4)})` : " (not set)"}</SelectItem>
                {settings.extraGitHubTokens.map((token, i) => <SelectItem key={i} value={String(i)}>{token.label} (…{token.token.slice(-4)})</SelectItem>)}
                <SelectItem value="custom">Dedicated PAT for this book…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "custom" && (
            <div className="grid gap-2 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">This PAT is stored on the book entry in your Drive settings and overrides the default token for all reads and writes to this book.</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <Input placeholder="Label (optional)" value={customTokenLabel} onChange={(e) => setCustomTokenLabel(e.target.value)} />
                <Input type="password" placeholder="github_pat_…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} autoComplete="off" />
              </div>
              <p className="text-[11px] text-muted-foreground">Create one at <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline">github.com/settings/tokens</a> with Contents read &amp; write and Metadata read on this repository.</p>
            </div>
          )}

          {!currentToken && mode !== "custom" && (
            <Alert variant="destructive"><AlertDescription>No token is configured for this selection. The book will not load until a token is available.</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={isSaving}>
          {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          {t("settings.save")}
        </Button>
      </div>
    </div>
  );
}
