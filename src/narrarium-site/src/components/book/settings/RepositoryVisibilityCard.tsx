import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import "@/i18n/repoVisibility";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";
import { readerRecordsOf } from "@/readerAccess/model";
import { readKeptItems } from "@/repoVisibility/contents";
import { confirmationMatches, type KeptItem, type VisibilityFailure } from "@/repoVisibility/model";
import { useRepositoryVisibility } from "@/repoVisibility/useRepositoryVisibility";

function failureText(t: (key: string, options?: Record<string, unknown>) => string, failure: VisibilityFailure, tokenKind: string): string {
  const key = failure.kind;
  if (key === "permission") return `${t("repoVisibility.failure.permission", { status: failure.status ?? "" })} ${t(tokenKind === "app" ? "repoVisibility.failure.permissionApp" : "repoVisibility.failure.permissionToken")}`;
  if (key === "policy") return failure.message ? t("repoVisibility.failure.policy", { message: failure.message }) : t("repoVisibility.failure.policyNoMessage");
  if (key === "other") return t("repoVisibility.failure.other", { status: failure.status ?? "" });
  return t(`repoVisibility.failure.${key}`);
}

/**
 * Whether the GitHub repository of the book is public or private, read from the repository, and the action that changes it. It is an online action on GitHub:
 * offline it is explained, never queued. Making it public asks for the name of the repository and lists what the repository holds; making it private says what
 * happens to Pages and Actions, and the state of Pages is read again after the change.
 */
export function RepositoryVisibilityCard({ book, branch }: { book: BookEntry; branch: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const visibility = useRepositoryVisibility(book);
  const settings = useSettingsStore((state) => state.settings);
  const [dialog, setDialog] = useState<"public" | "private" | null>(null);
  const [typed, setTyped] = useState("");
  const [kept, setKept] = useState<KeptItem[] | null | undefined>(undefined);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const { info, availability } = visibility;
  const readerPasswords = readerRecordsOf(settings, book.owner, book.repo).length > 0;
  const blocked = availability?.state === "no-admin-right" || availability?.state === "app-permission-missing" || info?.archived === true;
  const repoUrl = info?.htmlUrl ?? `https://github.com/${encodeURIComponent(book.owner)}/${encodeURIComponent(book.repo)}`;

  const open = (to: "public" | "private") => {
    setTyped("");
    setDialog(to);
    if (to === "public") { setKept(undefined); void readKeptItems(book, branch).then(setKept, () => setKept(null)); }
  };
  const confirm = async () => {
    const to = dialog;
    setDialog(null);
    if (to) await visibility.change(to === "private");
  };

  return (
    <Card aria-labelledby={titleId} data-testid="repository-visibility-card">
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2">{info?.private === false ? <Eye aria-hidden="true" className="h-4 w-4" /> : <EyeOff aria-hidden="true" className="h-4 w-4" />}{t("repoVisibility.title")}</CardTitle>
        <CardDescription>{t("repoVisibility.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div role="status" aria-live="polite" className="space-y-1">
          {visibility.loading && !info && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("repoVisibility.checking")}</p>}
          {info && <p className="font-medium" data-testid="repository-visibility-state" data-visibility={info.visibility}>{t(`repoVisibility.state.${info.visibility === "public" ? "public" : info.visibility === "internal" ? "internal" : "private"}`)}</p>}
          {!visibility.hasToken && <p className="text-muted-foreground">{t("repoVisibility.noToken")}</p>}
          {visibility.hasToken && offline && <p className="text-muted-foreground">{t("repoVisibility.offline")}</p>}
          {visibility.readFailure && !info && <p className="text-destructive">{t("repoVisibility.readFailed")} {failureText(t, visibility.readFailure, visibility.tokenKind)}</p>}
        </div>

        {info?.archived && <p className="text-amber-800 dark:text-amber-300">{t("repoVisibility.archived")}</p>}
        {availability && availability.state !== "ok" && (
          <p className={blocked ? "text-amber-800 dark:text-amber-300" : "text-xs text-muted-foreground"} data-testid="repository-visibility-availability" data-state={availability.state}>
            {t(`repoVisibility.availability.${availability.state}`)}
            {availability.state === "app-permission-missing" && visibility.appSettingsUrl && (
              <> <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={visibility.appSettingsUrl} target="_blank" rel="noopener noreferrer">{t("repoVisibility.openApp")}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("repoVisibility.opensNewTab")}</span></a></>
            )}
          </p>
        )}

        {visibility.changeFailure && (
          <div role="alert" className="space-y-1 rounded-md border border-destructive/50 p-3 text-destructive" data-testid="repository-visibility-failure">
            <p className="flex items-start gap-2 font-medium"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("repoVisibility.failure.title")}</p>
            <p>{failureText(t, visibility.changeFailure, visibility.tokenKind)}</p>
          </div>
        )}
        {visibility.result && (
          <div role="status" className="space-y-1 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="repository-visibility-result">
            <p className="flex items-start gap-2 font-medium"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`repoVisibility.done.${visibility.result.now}`)}</p>
            {visibility.result.now === "private" && (
              <p>{visibility.result.pages === null ? t("repoVisibility.done.pagesUnknown") : visibility.result.pages.status === "enabled" ? t("repoVisibility.done.pagesOn", { url: visibility.result.pages.url }) : t("repoVisibility.done.pagesOff")}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {info && (
            <Button type="button" variant={info.private ? "outline" : "default"} disabled={!visibility.hasToken || offline || blocked || visibility.changing} onClick={() => open(info.private ? "public" : "private")}>
              {visibility.changing ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{visibility.changing ? t("repoVisibility.changing") : info.private ? t("repoVisibility.makePublic") : t("repoVisibility.makePrivate")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={!visibility.hasToken || offline || visibility.loading} onClick={() => void visibility.refresh()}>
            {visibility.loading ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="mr-1 h-4 w-4" />}{t("repoVisibility.recheck")}
          </Button>
        </div>
      </CardContent>

      <Dialog open={dialog === "public"} onOpenChange={(next) => { if (!next) setDialog(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("repoVisibility.publicDialog.title", { repo: book.repo })}</DialogTitle>
            <DialogDescription>{t("repoVisibility.publicDialog.intro")}</DialogDescription>
          </DialogHeader>
          <ul className="ml-4 list-disc space-y-1 text-sm">
            <li>{t("repoVisibility.publicDialog.list.history")}</li>
            <li>{t("repoVisibility.publicDialog.list.drafts")}</li>
            <li className="font-medium">{t("repoVisibility.publicDialog.list.undo")}</li>
          </ul>
          <section aria-label={t("repoVisibility.publicDialog.keptTitle")} className="space-y-1 rounded-md border p-2 text-sm" data-testid="repository-visibility-kept">
            <h4 className="font-medium">{t("repoVisibility.publicDialog.keptTitle")}</h4>
            {kept === undefined && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("repoVisibility.checking")}</p>}
            {kept === null && <p>{t("repoVisibility.publicDialog.keptUnknown")}</p>}
            {kept && kept.length > 0 && <ul className="ml-4 list-disc break-all font-mono text-xs">{kept.map((item) => <li key={item.path}>{item.kind === "file" ? t("repoVisibility.publicDialog.keptFile", { path: item.path }) : t("repoVisibility.publicDialog.keptFolder", { path: item.path, count: item.count })}</li>)}</ul>}
          </section>
          {readerPasswords && (
            <p className="rounded-md border border-amber-600/50 p-2 text-sm" data-testid="repository-visibility-reader-note">
              {t("repoVisibility.publicDialog.readerNote")}{" "}
              <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={repoUrl} target="_blank" rel="noopener noreferrer">{t("repoVisibility.publicDialog.openRepository")}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only"> {t("repoVisibility.opensNewTab")}</span></a>
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${titleId}-confirm`}>{t("repoVisibility.publicDialog.typeLabel", { repo: book.repo })}</Label>
            <Input id={`${titleId}-confirm`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>{t("repoVisibility.cancel")}</Button>
            <Button type="button" variant="destructive" disabled={!confirmationMatches(typed, book.repo)} onClick={() => void confirm()}>{t("repoVisibility.publicDialog.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "private"} onOpenChange={(next) => { if (!next) setDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("repoVisibility.privateDialog.title", { repo: book.repo })}</DialogTitle>
            <DialogDescription>{t("repoVisibility.privateDialog.intro")}</DialogDescription>
          </DialogHeader>
          <ul className="ml-4 list-disc space-y-1 text-sm">
            <li>{t("repoVisibility.privateDialog.pages")}</li>
            <li>{t("repoVisibility.privateDialog.actions")}</li>
            <li>{t("repoVisibility.privateDialog.copies")}</li>
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>{t("repoVisibility.cancel")}</Button>
            <Button type="button" onClick={() => void confirm()}>{t("repoVisibility.privateDialog.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
