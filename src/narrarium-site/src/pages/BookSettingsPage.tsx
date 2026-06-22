import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, KeyRound, Loader2, Save } from "lucide-react";
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

type TokenMode = "default" | "custom" | string; // string = extra token index

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
  const { clearBook } = useBooksStore();

  const book = settings.books.find((b) => b.id === bookId);

  const [name, setName] = useState(book?.name ?? "");
  const [mode, setMode] = useState<TokenMode>(book ? initialMode(book) : "default");
  const [customToken, setCustomToken] = useState(book?.bookToken ?? "");
  const [customTokenLabel, setCustomTokenLabel] = useState(book?.bookTokenLabel ?? "");

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Book not found. <Link to="/app/books" className="underline">Back to books</Link>
        </AlertDescription>
      </Alert>
    );
  }

  const isSaving = syncStatus === "saving";
  const currentToken = resolveBookToken(book, settings);

  async function handleSave() {
    if (!book) return;
    const usingCustom = mode === "custom";
    const updated: BookEntry = {
      ...book,
      name: name.trim() || book.repo,
      tokenIndex: mode === "default" || usingCustom ? null : Number(mode),
      bookToken: usingCustom ? customToken.trim() || undefined : undefined,
      bookTokenLabel: usingCustom
        ? customTokenLabel.trim() || `${book.repo} PAT`
        : undefined,
    };

    patchSettings({
      books: settings.books.map((b) => (b.id === book.id ? updated : b)),
    });
    await save();

    // Force the structure to reload with the new token next time it's opened.
    clearBook(book.id);

    toast({ title: "Book settings saved" });
    navigate(`/app/books/${book.id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/app/books/${book.id}`}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {book.name}
        </Link>
      </Button>

      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Book settings</h1>
        <p className="text-muted-foreground">
          {book.owner}/{book.repo}
        </p>
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
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            GitHub access for this book
          </CardTitle>
          <CardDescription>
            Choose which token this book uses. A dedicated PAT lets you scope
            access to just this repository, even when a default token exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Token</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  Default token
                  {settings.defaultGitHubToken
                    ? ` (…${settings.defaultGitHubToken.slice(-4)})`
                    : " (not set)"}
                </SelectItem>
                {settings.extraGitHubTokens.map((token, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {token.label} (…{token.token.slice(-4)})
                  </SelectItem>
                ))}
                <SelectItem value="custom">Dedicated PAT for this book…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "custom" && (
            <div className="grid gap-2 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">
                This PAT is stored on the book entry in your Drive settings and
                overrides the default token for all reads and writes to this book.
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <Input
                  placeholder="Label (optional)"
                  value={customTokenLabel}
                  onChange={(e) => setCustomTokenLabel(e.target.value)}
                />
                <Input
                  type="password"
                  placeholder="github_pat_…"
                  value={customToken}
                  onChange={(e) => setCustomToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Create one at{" "}
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  github.com/settings/tokens
                </a>{" "}
                with Contents read &amp; write and Metadata read on this repository.
              </p>
            </div>
          )}

          {!currentToken && mode !== "custom" && (
            <Alert variant="destructive">
              <AlertDescription>
                No token is configured for this selection. The book will not load
                until a token is available.
              </AlertDescription>
            </Alert>
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
