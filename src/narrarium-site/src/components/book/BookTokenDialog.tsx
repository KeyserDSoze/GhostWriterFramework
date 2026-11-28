import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import "@/i18n/githubApp";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useSettings } from "@/drive/useSettings";
import { verifyTokenReadsRepository } from "@/github/githubConnectionRead";
import { bookWithOwnToken } from "@/github/githubAccessModel";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

export interface SavedBookToken {
  token: string;
  label: string;
}

/**
 * The book's own GitHub token, asked for where the author needs it (the notice about the app's token, the line of a book in Account & Sync), without leaving the page: how to make it
 * and what it needs, a field, and one button that checks it with GitHub (it reads the repository and must be able to save to it) and saves it for this book. GitHub is asked when
 * the button is pressed, never before. A book that the personal server runs is given the new token too, so that it does not go on with the app's token that lapses.
 */
export function BookTokenDialog({ book, onClose, onSaved }: { book: BookEntry; onClose: () => void; onSaved?: (saved: SavedBookToken) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { save } = useSettings();
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const repo = `${book.owner}/${book.repo}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value) { setProblem(t("accountSync.github.bookToken.errors.empty")); return; }
    setChecking(true);
    setProblem(null);
    try {
      const read = await verifyTokenReadsRepository(value, book.owner, book.repo);
      if (read.ok === false) {
        setProblem(read.reason === "unreachable" ? t("accountSync.github.bookToken.errors.unreachable")
          : read.reason === "read-only" ? t("accountSync.github.bookToken.errors.readOnly", { repo })
          : read.status === 401 ? t("accountSync.github.bookToken.errors.invalid")
          : t("accountSync.github.bookToken.errors.noAccess", { repo }));
        return;
      }
      const label = `${book.repo} PAT`;
      const store = useSettingsStore.getState();
      const previous = store.settings.books;
      store.patchSettings({ books: previous.map((entry) => (entry.id === book.id ? bookWithOwnToken(entry, value, label) : entry)) });
      try { await save(); }
      catch {
        useSettingsStore.getState().patchSettings({ books: previous });
        setProblem(t("accountSync.github.bookToken.errors.saveFailed"));
        return;
      }
      toast({ title: t("accountSync.github.bookToken.saved") });
      // The server that runs the book holds a copy of the token it had: it gets this one, or it goes on with the app's token that lapses.
      try { await (await loadAutopilotRuntime()).replaceServerGitHubToken(book.id); }
      catch (error) { toast({ title: t("accountSync.github.bookToken.errors.serverFailed"), description: error instanceof Error ? error.message : String(error), variant: "destructive" }); }
      onSaved?.({ token: value, label });
      onClose();
    } finally { setChecking(false); }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !checking) onClose(); }}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound aria-hidden="true" className="h-4 w-4" />{t("accountSync.github.bookToken.title")}</DialogTitle>
            <DialogDescription>{t("accountSync.github.bookToken.lead", { repo })}</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>
              {t("accountSync.github.bookToken.how", { repo })}{" "}
              <a className="inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2" href={NEW_TOKEN_URL} target="_blank" rel="noopener noreferrer">
                {t("accountSync.github.bookToken.create")}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("accountSync.github.install.opensNewTab")}</span>
              </a>
            </li>
            <li>{t("accountSync.github.bookToken.permission")}</li>
          </ol>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-token`}>{t("accountSync.github.bookToken.field")}</Label>
            <Input id={`${id}-token`} type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_…" value={token} disabled={checking} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ""}`} onChange={(event) => { setToken(event.target.value); setProblem(null); }} />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">{t("accountSync.github.bookToken.keep")}</p>
            <div role="alert" id={`${id}-problem`} className="text-xs text-destructive">{problem}</div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={checking} onClick={onClose}>{t("accountSync.github.bookToken.cancel")}</Button>
            <Button type="submit" disabled={checking}>
              {checking && <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />}{checking ? t("accountSync.github.bookToken.checking") : t("accountSync.github.bookToken.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
