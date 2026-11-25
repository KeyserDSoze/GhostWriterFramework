import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { AutoSyncStatus, relativeTime } from "@/components/branches/AutoSyncStatus";
import { setBookAutoSyncMode, updateBranchMemory } from "@/branches/branchActions";
import { bookAutoSyncMode, bookBranchMemory, defaultAutoSyncMode } from "@/branches/memory";
import { forgetBranch, keepBranchInSync, labelBranch } from "@/branches/memoryEdits";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry, KnownBranchRecord } from "@/types/settings";
import "@/i18n/branches";

const DEFAULT = "default";

/**
 * The branches of a GitHub book in the account data (the last one worked on, on any device, and all those worked on) and its automatic sync, in the GitHub
 * tab. A label and forgetting change only this list, never a branch on GitHub or its copy here; the branch open on this device cannot be forgotten. These
 * apply at once, like the switcher of the top bar.
 */
export function BranchMemoryCard({ book }: { book: BookEntry }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const locale = i18n.resolvedLanguage || i18n.language;
  const settings = useSettingsStore((state) => state.settings);
  const loadedBranch = useBooksStore((state) => state.structures[book.id]?.loadedBranch);
  const workingBranch = useBooksStore((state) => state.workingBranches[book.id]);
  const memory = bookBranchMemory(settings, book);
  const mode = bookAutoSyncMode(settings, book);
  const openHere = book.activeBranch ?? workingBranch ?? loadedBranch;
  const [renaming, setRenaming] = useState<{ branch: string; label: string } | null>(null);
  const known = [...(memory?.knownBranches ?? [])].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  const when = (at: string) => relativeTime(Date.parse(at), Date.now(), locale);
  const run = (work: () => Promise<void>, done?: string) => { void work().then(() => { if (done) toast({ title: done }); }, () => undefined); };

  const keepValue = (entry: KnownBranchRecord) => (entry.sync === true ? "always" : entry.sync === false ? "never" : "auto");

  return (
    <Card data-testid="branch-memory-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" aria-hidden="true" />{t("branches.settings.title")}</CardTitle>
        <CardDescription>{t("branches.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2">
          <Label htmlFor="book-auto-sync">{t("branches.settings.mode.label")}</Label>
          <Select value={memory?.autoSync ?? DEFAULT} onValueChange={(value) => run(() => setBookAutoSyncMode(book.id, value === DEFAULT ? null : value as "off" | "open-focus" | "periodic"))}>
            <SelectTrigger id="book-auto-sync" className="w-full max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t("branches.settings.mode.default", { mode: t(`branches.settings.mode.${defaultAutoSyncMode(settings.repository)}`) })}</SelectItem>
              <SelectItem value="off">{t("branches.settings.mode.off")}</SelectItem>
              <SelectItem value="open-focus">{t("branches.settings.mode.open-focus")}</SelectItem>
              <SelectItem value="periodic">{t("branches.settings.mode.periodic")}</SelectItem>
            </SelectContent>
          </Select>
          {mode === "off" && <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm font-medium text-amber-900 dark:text-amber-200" data-testid="auto-sync-off">{t("branches.settings.mode.offNotice")}</p>}
          <AutoSyncStatus bookId={book.id} mode={mode} className="space-y-1 text-xs text-muted-foreground" />
        </div>

        <p className="text-sm" data-testid="last-working-branch">
          {memory?.lastWorkingBranch && memory.lastWorkingAt ? t("branches.settings.last", { branch: memory.lastWorkingBranch, when: when(memory.lastWorkingAt) }) : t("branches.settings.noLast")}
        </p>

        <section aria-labelledby="known-branches-title" className="space-y-2">
          <h3 id="known-branches-title" className="text-sm font-medium">{t("branches.settings.known")}</h3>
          <p className="text-xs text-muted-foreground">{t("branches.settings.knownHint")}</p>
          {!known.length && <p className="text-sm text-muted-foreground">{t("branches.settings.empty")}</p>}
          <ul className="divide-y rounded-md border">
            {known.map((entry) => {
              const here = entry.name === openHere;
              return (
                <li key={entry.name} className="grid gap-2 p-3 md:grid-cols-[1fr_auto] md:items-center" data-branch={entry.name}>
                  <div className="min-w-0 text-sm">
                    <p className="font-medium [overflow-wrap:anywhere]">{entry.name}{entry.label ? <span className="ml-1 font-normal text-muted-foreground">({entry.label})</span> : null}</p>
                    <p className="text-xs text-muted-foreground">{[t("branches.settings.usedWhen", { when: when(entry.lastUsedAt) }), entry.createdHere ? t("branches.settings.createdHere") : "", here ? t("branches.switcher.state.current") : ""].filter(Boolean).join(" · ")}</p>
                    {renaming?.branch === entry.name && (
                      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const label = renaming.label; setRenaming(null); run(() => updateBranchMemory(book.id, (record, at) => labelBranch(record, entry.name, label, at))); }}>
                        <div className="grid gap-1">
                          <Label htmlFor={`rename-${entry.name}`} className="text-xs">{t("branches.settings.renameLabel", { branch: entry.name })}</Label>
                          <Input id={`rename-${entry.name}`} autoFocus className="h-9 w-56" value={renaming.label} maxLength={60} onChange={(event) => setRenaming({ branch: entry.name, label: event.target.value })} />
                        </div>
                        <Button type="submit" size="sm">{t("branches.settings.save")}</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t("branches.settings.cancel")}</Button>
                      </form>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={keepValue(entry)} onValueChange={(value) => run(() => updateBranchMemory(book.id, (record, at) => keepBranchInSync(record, entry.name, value === "always" ? true : value === "never" ? false : undefined, at)))}>
                      <SelectTrigger className="h-9 w-full sm:w-56" aria-label={t("branches.settings.keep.label", { branch: entry.name })}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t("branches.settings.keep.auto")}</SelectItem>
                        <SelectItem value="always">{t("branches.settings.keep.always")}</SelectItem>
                        <SelectItem value="never">{t("branches.settings.keep.never")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="button" size="sm" variant="outline" aria-label={t("branches.settings.renameAria", { branch: entry.name })} onClick={() => setRenaming({ branch: entry.name, label: entry.label ?? "" })}>{t("branches.settings.rename")}</Button>
                    <Button type="button" size="sm" variant="outline" disabled={here} title={here ? t("branches.settings.forgetCurrent") : undefined} aria-label={t("branches.settings.forgetAria", { branch: entry.name })} onClick={() => run(() => updateBranchMemory(book.id, (record, at) => forgetBranch(record, entry.name, at)), t("branches.settings.forgotten", { branch: entry.name }))}>{t("branches.settings.forget")}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}
