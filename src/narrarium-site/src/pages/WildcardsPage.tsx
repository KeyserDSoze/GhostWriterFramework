import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookCopy, Copy, Download, Loader2, Plus, RotateCcw, Save, Sparkles, Trash2, Upload, UserRoundCog } from "lucide-react";
import { WILDCARD_CANON_RESPECT, WILDCARD_OUTPUT_FORMATS, WILDCARD_PRESETS, emptyWildcard, mergeWildcards, type WildcardProfile } from "narrarium-engine";
import "@/i18n/wildcards";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { ProfileWarnings, confirmProfileSave } from "@/components/book/ProfileWarnings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { useRegisterPageSave } from "@/store/saveStore";
import { saveSettingsNow } from "@/drive/useSettings";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveUnsavedChanges } from "@/hooks/resolveUnsavedChanges";
import { resolveWorkingCopyToken } from "@/types/settings";
import { deleteBookWildcard, exportedWildcard, importedWildcard, loadWildcardRoom, saveBookWildcard, withAccountWildcard, withoutAccountWildcard, type WildcardRoomLayers } from "@/wildcards/wildcardFiles";

/**
 * The wildcards of a book («Fuori dal coro»): the fourteen built-in ones and the author's own, provocateurs and sentinels, each turned on or off, changed,
 * duplicated, exported and imported. A change goes where the author chooses: into this book (`wildcards/<slug>.md`, what the autopilot uses too) or into
 * the account, for every book. The engine reads and writes the files; the page only shows them.
 */

type Scope = "book" | "account";
type Filter = "all" | "provocateur" | "sentinel" | "mine";

const EMPTY_LAYERS: WildcardRoomLayers = { room: [], book: [], account: [] };

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function WildcardsPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, error, reload } = useBookStructure(bookId);
  const token = book ? resolveWorkingCopyToken(book, settings) : "";
  const language = structure?.language ?? settings.ui.language;
  const [scope, setScope] = useState<Scope>("book");
  const [filter, setFilter] = useState<Filter>("all");
  const [layers, setLayers] = useState<WildcardRoomLayers>(EMPTY_LAYERS);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<WildcardProfile | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const importInput = useRef<HTMLInputElement | null>(null);

  // The room of the scope: the book's (built-in, account, book) or the account's (built-in, account).
  const shown = useMemo(() => (scope === "book" ? layers.room : mergeWildcards(language, { account: layers.account })), [layers, language, scope]);
  const visible = useMemo(() => shown.filter((profile) => filter === "all" || (filter === "mine" ? !profile.builtin : profile.group === filter)), [filter, shown]);
  const dirty = Boolean(draft && JSON.stringify(draft) !== savedDraft);
  const editing = useRef(false);
  editing.current = dirty;

  async function load(keep = selectedId) {
    if (!book || !structure) return;
    setLoading(true);
    try {
      const next = await loadWildcardRoom({ settings: useSettingsStore.getState().settings, token, book, branch, structure });
      setLayers(next);
      const list = scope === "book" ? next.room : mergeWildcards(language, { account: next.account });
      const selected = list.find((profile) => profile.id === keep) ?? list[0];
      setSelectedId(selected?.id ?? "");
      setDraft(selected ? { ...selected } : null);
      setSavedDraft(selected ? JSON.stringify(selected) : "");
    } finally {
      setLoading(false);
    }
  }

  // The book changed elsewhere (the Copilot applied a batch, a sync brought files) or the account's wildcards did: read again, unless a wildcard is being edited.
  const generation = useBooksStore((state) => (bookId ? state.structureGenerations[bookId] ?? 0 : 0));
  const files = structure ? (structure.wildcards ?? []).map((entry) => entry.path).join("|") : null;
  const accountKey = JSON.stringify(settings.wildcards ?? null);
  useEffect(() => { if (!editing.current) void load(); }, [book?.id, structure?.loadedBranch, token, generation, files, accountKey, scope]);

  async function allowChange(): Promise<boolean> {
    return resolveUnsavedChanges({ dirty, save: () => (draft ? persist(draft) : true), saveMessage: t("common.unsavedSaveConfirm"), discardMessage: t("common.unsavedDiscardConfirm") });
  }

  async function select(profile: WildcardProfile, persisted = true): Promise<boolean> {
    if (profile.id === selectedId && persisted) return true;
    if (!await allowChange()) return false;
    setSelectedId(profile.id);
    setDraft({ ...profile });
    setSavedDraft(persisted ? JSON.stringify(profile) : "");
    return true;
  }

  async function changeScope(next: Scope) {
    if (next === scope || !await allowChange()) return;
    setScope(next);
  }

  /** Write a wildcard where `target` says: the book's file, or the account. `confirmed`: the author was already asked about the problems of its file. */
  async function persist(profile: WildcardProfile, target: Scope = scope, confirmed = false): Promise<boolean> {
    if (!book) return false;
    if (!confirmed && !confirmProfileSave(t, profile.warnings)) return false;
    setBusy(true);
    try {
      const saved: WildcardProfile = { ...profile, warnings: [] };
      if (target === "book") {
        if (!token) return false;
        await saveBookWildcard({ token, book, branch, profile: saved });
        await reload();
      } else {
        patchSettings({ wildcards: withAccountWildcard(useSettingsStore.getState().settings, saved) });
        if (!await saveSettingsNow()) throw new Error(t("wildcards.saveFailed"));
      }
      if (target === scope && saved.id === selectedId) {
        setDraft(saved);
        setSavedDraft(JSON.stringify(saved));
      }
      editing.current = false;
      await load(saved.id);
      toast({ title: t(target === scope ? "wildcards.saved" : "wildcards.copied") });
      return true;
    } catch (err) {
      toast({ title: t("wildcards.saveFailed"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  useRegisterPageSave({ dirty, enabled: Boolean(draft && book), onSave: () => (draft ? persist(draft) : true) });

  /** Remove what the scope has of a wildcard: a built-in one goes back to what is below it, one of the author's own is gone. */
  async function unset(profile: WildcardProfile) {
    if (!book) return;
    setBusy(true);
    try {
      if (scope === "book") {
        if (token) await deleteBookWildcard({ token, book, branch, profile });
        await reload();
      } else {
        patchSettings({ wildcards: withoutAccountWildcard(useSettingsStore.getState().settings, profile.id) });
        await saveSettingsNow();
      }
      editing.current = false;
      await load(profile.builtin ? profile.id : "");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(profile: WildcardProfile) {
    if (dirty || !confirmProfileSave(t, profile.warnings)) return;
    await persist({ ...profile, enabled: !profile.enabled }, scope, true);
  }

  function duplicate(profile: WildcardProfile) {
    const next: WildcardProfile = { ...profile, id: `wildcard:custom:${crypto.randomUUID()}`, slug: `${profile.slug}-copy-${Date.now().toString(36)}`, name: t("wildcards.copyName", { name: profile.name }), builtin: false, source: undefined, path: undefined, fields: undefined, warnings: [] };
    void select(next, false);
  }

  function create() {
    const next = emptyWildcard(language, filter === "sentinel" ? "sentinel" : "provocateur", 1000 + shown.length);
    void select({ ...next, slug: "" }, false);
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!chosen.length || !await allowChange()) return;
    const own = scope === "book" ? layers.book : layers.account;
    let imported = 0;
    for (const file of chosen) {
      try {
        const profile = importedWildcard(file.name, await file.text());
        const existing = own.find((entry) => entry.id === profile.id);
        if (existing && !window.confirm(t("wildcards.importReplace", { name: existing.name }))) continue;
        if (await persist(profile, scope, true)) imported += 1;
      } catch (err) {
        toast({ title: t("wildcards.importFailed", { name: file.name, reason: err instanceof Error ? err.message : String(err) }), variant: "destructive" });
      }
    }
    if (imported) toast({ title: t("wildcards.imported", { count: imported }) });
  }

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  const own = (profile: WildcardProfile) => (scope === "book" ? profile.source === "book" : profile.source === "account");
  return (
    // What the Copilot sees of the page besides its files: where changes go, the filter and the wildcard that is open (see `readPageView`).
    <div className="space-y-6" data-copilot-page="wildcards" data-copilot-view={JSON.stringify({ scope, filter, ...(selectedId ? { selected: selectedId } : {}) })}>
      <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm sm:p-8">
        <Badge variant="secondary"><Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t("wildcards.badge")}</Badge>
        <h1 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">{t("wildcards.title")}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{t("wildcards.description")}</p>
      </div>

      <div className="space-y-2">
        <div role="group" aria-label={t("wildcards.scope.label")} className="flex flex-wrap gap-2">
          {(["book", "account"] as const).map((value) => (
            <Button key={value} size="sm" variant={scope === value ? "default" : "outline"} aria-pressed={scope === value} onClick={() => void changeScope(value)}>
              {value === "book" ? <BookCopy className="mr-1.5 h-4 w-4" aria-hidden /> : <UserRoundCog className="mr-1.5 h-4 w-4" aria-hidden />}{t(`wildcards.scope.${value}`)}
            </Button>
          ))}
        </div>
        <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{t(scope === "book" ? "wildcards.scope.bookHint" : "wildcards.scope.accountHint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("wildcards.filters.label")} className="flex flex-wrap gap-2">
          {(["all", "provocateur", "sentinel", "mine"] as const).map((value) => (
            <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`wildcards.filters.${value}`)}</Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={create} disabled={busy}><Plus className="mr-1.5 h-4 w-4" aria-hidden />{t("wildcards.new")}</Button>
          <Button size="sm" variant="outline" onClick={() => importInput.current?.click()} disabled={busy}><Upload className="mr-1.5 h-4 w-4" aria-hidden />{t("wildcards.import")}</Button>
          <input ref={importInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple className="sr-only" tabIndex={-1} aria-label={t("wildcards.importLabel")} onChange={(event) => void importFiles(event)} />
        </div>
      </div>

      <details className="rounded-2xl border p-4 text-sm">
        <summary className="cursor-pointer font-medium">{t("wildcards.presets.title")}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t("wildcards.presets.hint")}</p>
        <ul className="mt-2 space-y-1">
          {WILDCARD_PRESETS.map((preset) => (
            <li key={preset.id}><span className="font-medium">{t(`wildcards.presets.${preset.id}`)}</span>: {preset.slugs.map((slug) => shown.find((profile) => profile.slug === slug)?.name ?? slug).join(", ")}</li>
          ))}
        </ul>
      </details>

      {/* One column under the large screens, never wider than the page: a long name is cut, the badges wrap. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          {loading && !shown.length ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("common.loading")}</div>
          ) : visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">{t("wildcards.empty")}</p>
          ) : (
            <ul aria-label={t("wildcards.list")} className="space-y-2">
              {visible.map((profile) => (
                <li key={profile.id} className={selectedId === profile.id ? "rounded-xl border border-primary bg-primary/5 p-3" : "rounded-xl border p-3"}>
                  <button type="button" className="w-full text-left" aria-current={selectedId === profile.id ? "true" : undefined} onClick={() => void select(profile)}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{profile.name || t("wildcards.untitled")}</span>
                      {profile.warnings?.length ? <Badge variant="outline" className="border-amber-600 text-amber-900 dark:border-amber-400 dark:text-amber-200">{t("wildcards.hasProblems")}</Badge> : null}
                      <Badge variant="outline">{t(`wildcards.groups.${profile.group}`)}</Badge>
                      <Badge variant="secondary">{t(`wildcards.source.${profile.source ?? "builtin"}`)}</Badge>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{profile.mandate}</span>
                  </button>
                  <div className="mt-3 flex items-center gap-2">
                    <Switch checked={profile.enabled} disabled={busy || dirty} onCheckedChange={() => void toggle(profile)} aria-label={t("wildcards.toggle", { name: profile.name, state: profile.enabled ? t("wildcards.enabled") : t("wildcards.disabled") })} />
                    <span className="text-xs text-muted-foreground">{profile.enabled ? t("wildcards.enabled") : t("wildcards.disabled")}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {draft ? (
          <WildcardEditor
            profile={draft}
            scope={scope}
            own={own(draft)}
            busy={busy}
            dirty={dirty}
            onChange={setDraft}
            onSave={() => void persist(draft)}
            onDuplicate={() => duplicate(draft)}
            onExport={() => { const file = exportedWildcard(draft); download(file.text, file.name); }}
            onUnset={() => { if (draft.builtin || window.confirm(t("wildcards.deleteConfirm", { name: draft.name }))) void unset(draft); }}
            onCopy={() => void persist(draft, scope === "book" ? "account" : "book", true)}
          />
        ) : <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">{t("wildcards.select")}</div>}
      </div>
    </div>
  );
}

function WildcardEditor({ profile, scope, own, busy, dirty, onChange, onSave, onDuplicate, onExport, onUnset, onCopy }: {
  profile: WildcardProfile;
  scope: Scope;
  own: boolean;
  busy: boolean;
  dirty: boolean;
  onChange: (profile: WildcardProfile) => void;
  onSave: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onUnset: () => void;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const patch = (next: Partial<WildcardProfile>) => onChange({ ...profile, ...next });
  const sentinel = profile.group === "sentinel";
  const below = profile.builtin ? (scope === "book" && profile.source === "book" ? "account" : "builtin") : null;
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-2xl border border-layer bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-xl font-semibold">{profile.name || t("wildcards.untitled")}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{profile.id}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={onDuplicate}><Copy className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.duplicate")}</Button>
          <Button size="sm" variant="outline" onClick={onExport}><Download className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.export")}</Button>
          {own && profile.source ? <Button size="sm" variant="outline" disabled={busy || dirty} onClick={onCopy}><BookCopy className="mr-1 h-4 w-4" aria-hidden />{t(scope === "book" ? "wildcards.copyToAccount" : "wildcards.copyToBook")}</Button> : null}
          {own && profile.builtin ? <Button size="sm" variant="outline" disabled={busy} onClick={onUnset} title={t("wildcards.resetHint", { source: t(`wildcards.source.${below ?? "builtin"}`) })}><RotateCcw className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.reset")}</Button> : null}
          {own && !profile.builtin ? <Button size="sm" variant="ghost" disabled={busy} onClick={onUnset} aria-label={`${t("wildcards.delete")}: ${profile.name}`}><Trash2 className="h-4 w-4 text-destructive" aria-hidden /></Button> : null}
        </div>
      </div>
      {scope === "book" && profile.source === "account" ? <p className="text-xs text-muted-foreground">{t("wildcards.readOnlyHere")}</p> : null}
      <ProfileWarnings warnings={profile.warnings} />
      <TextField id={`${id}-name`} label={t("wildcards.fields.name")} value={profile.name} onChange={(value) => patch({ name: value })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={`${id}-group`} label={t("wildcards.fields.group")} value={profile.group} options={(["provocateur", "sentinel"] as const).map((value) => [value, t(`wildcards.groups.${value}`)])} onChange={(value) => patch({ group: value as WildcardProfile["group"], ...(value === "provocateur" ? { secrets: "threshold" as const } : {}) })} />
        <SelectField id={`${id}-format`} label={t("wildcards.fields.outputFormat")} value={profile.outputFormat} options={WILDCARD_OUTPUT_FORMATS.map((value) => [value, t(`wildcards.outputFormat.${value}`)])} onChange={(value) => patch({ outputFormat: value as WildcardProfile["outputFormat"] })} />
      </div>
      <TextField id={`${id}-mandate`} label={t("wildcards.fields.mandate")} hint={t("wildcards.fields.mandateHint")} value={profile.mandate} onChange={(value) => patch({ mandate: value })} multiline />
      <TextField id={`${id}-temperament`} label={t("wildcards.fields.temperament")} value={profile.temperament} onChange={(value) => patch({ temperament: value })} multiline />
      <div className="grid gap-2">
        <Label htmlFor={`${id}-audacity`}>{t("wildcards.fields.audacity", { value: profile.audacity })}</Label>
        <input id={`${id}-audacity`} type="range" min={1} max={10} step={1} value={profile.audacity} aria-describedby={`${id}-audacity-hint`} aria-valuetext={t("wildcards.fields.audacity", { value: profile.audacity })} onChange={(event) => patch({ audacity: Number(event.target.value) })} className="w-full accent-primary" />
        <p id={`${id}-audacity-hint`} className="text-xs text-muted-foreground">{t("wildcards.fields.audacityHint")}</p>
      </div>
      <SelectField id={`${id}-canon`} label={t("wildcards.fields.canonRespect")} value={profile.canonRespect} options={WILDCARD_CANON_RESPECT.map((value) => [value, t(`wildcards.canonRespect.${value}`)])} onChange={(value) => patch({ canonRespect: value as WildcardProfile["canonRespect"] })} />
      <TextField id={`${id}-domain`} label={t("wildcards.fields.domain")} hint={t("wildcards.fields.domainHint")} value={profile.domain} onChange={(value) => patch({ domain: value })} />
      <SelectField id={`${id}-secrets`} label={t("wildcards.fields.secrets")} hint={t("wildcards.fields.secretsHint")} value={sentinel ? profile.secrets : "threshold"} disabled={!sentinel} options={(["threshold", "author"] as const).map((value) => [value, t(`wildcards.secrets.${value}`)])} onChange={(value) => patch({ secrets: value as WildcardProfile["secrets"] })} />
      <div className="flex items-center gap-2">
        <Switch id={`${id}-enabled`} checked={profile.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
        <Label htmlFor={`${id}-enabled`}>{t("wildcards.fields.enabled")}</Label>
      </div>
      <TextField id={`${id}-prompt`} label={t("wildcards.fields.prompt")} hint={t("wildcards.fields.promptHint")} value={profile.body} onChange={(value) => patch({ body: value })} multiline />
      <Button onClick={onSave} disabled={busy || !dirty || !profile.name.trim()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-2 h-4 w-4" aria-hidden />}{t("common.save")}</Button>
    </section>
  );
}

function TextField({ id, label, hint, value, onChange, multiline }: { id: string; label: string; hint?: string; value: string; onChange: (value: string) => void; multiline?: boolean }) {
  const described = hint ? `${id}-hint` : undefined;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline
        ? <AutoTextarea id={id} value={value} aria-describedby={described} onChange={(event) => onChange(event.target.value)} className="min-h-20" />
        : <Input id={id} value={value} aria-describedby={described} onChange={(event) => onChange(event.target.value)} />}
      {hint ? <p id={described} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SelectField({ id, label, hint, value, options, onChange, disabled }: { id: string; label: string; hint?: string; value: string; options: Array<readonly [string, string]>; onChange: (value: string) => void; disabled?: boolean }) {
  const described = hint ? `${id}-hint` : undefined;
  return (
    // A long option never makes the field wider than the page: the select takes the width it is given.
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} value={value} disabled={disabled} aria-describedby={described} onChange={(event) => onChange(event.target.value)} className="h-10 w-full min-w-0 rounded-md border border-field bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70">
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
      {hint ? <p id={described} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
