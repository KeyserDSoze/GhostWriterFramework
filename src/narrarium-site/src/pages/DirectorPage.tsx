import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clapperboard, Loader2, Plane, RefreshCcw, Save } from "lucide-react";
import { DIRECTOR_AUTONOMIES, listDirectorOpinions, type DirectorAutonomy, type DirectorOpinionRecord, type DirectorProfile, type ReaderPersonaProfile } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { DirectorVerdictBadge } from "@/components/director/DirectorOpinionView";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { formatDateTime } from "@/autopilot/format";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { renderRepositoryMarkdownHtml } from "@/markdown/safeMarkdown";
import { loadDirectorProfile, renderDirectorFile, saveDirectorProfile } from "@/narrarium/director";
import { loadReaderPersonas } from "@/narrarium/readerPanel";
import { openAskDirector, useAskDirectorStore } from "@/store/askDirectorStore";
import { useRegisterPageSave } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveBookToken } from "@/types/settings";

type ListField = "priorities" | "taste" | "redLines";

function toLines(values: string[]): string {
  return values.join("\n");
}

function fromLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
}

function clamp(value: string, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function DirectorPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const savedVersion = useAskDirectorStore((state) => state.savedVersion);

  const [profile, setProfile] = useState<DirectorProfile | null>(null);
  const [lists, setLists] = useState<Record<ListField, string>>({ priorities: "", taste: "", redLines: "" });
  const [savedContent, setSavedContent] = useState("");
  const [exists, setExists] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readers, setReaders] = useState<ReaderPersonaProfile[]>([]);
  const [opinions, setOpinions] = useState<DirectorOpinionRecord[] | null>(null);
  const [opinionsLoading, setOpinionsLoading] = useState(false);
  const [opinionsKey, setOpinionsKey] = useState(0);

  const language = structure?.language;
  const canLoad = Boolean(book && token && structure && ready);

  useEffect(() => {
    if (!book || !canLoad) return;
    let cancelled = false;
    setBusy(true);
    loadDirectorProfile({ book, branch, language })
      .then(({ profile: loaded, exists: present }) => {
        if (cancelled) return;
        setProfile(loaded);
        setLists({ priorities: toLines(loaded.priorities), taste: toLines(loaded.taste), redLines: toLines(loaded.redLines) });
        setSavedContent(present ? renderDirectorFile(loaded, null) : "");
        setExists(present);
      })
      .catch((cause) => toast({ title: t("director.loadFailed"), description: String(cause), variant: "destructive" }))
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [book, branch, language, canLoad, t, toast]);

  useEffect(() => {
    if (!book || !token || !structure || !canLoad) return;
    let cancelled = false;
    loadReaderPersonas({ token, book, branch, structure })
      .then((loaded) => { if (!cancelled) setReaders(loaded.filter((reader) => reader.enabled)); })
      .catch(() => { if (!cancelled) setReaders([]); });
    return () => { cancelled = true; };
  }, [book, token, branch, structure, canLoad]);

  useEffect(() => {
    if (!book || !canLoad) return;
    let cancelled = false;
    setOpinionsLoading(true);
    listDirectorOpinions(createBrowserBookStore(book, branch))
      .then((records) => { if (!cancelled) setOpinions(records); })
      .catch(() => { if (!cancelled) setOpinions([]); })
      .finally(() => { if (!cancelled) setOpinionsLoading(false); });
    return () => { cancelled = true; };
  }, [book, branch, canLoad, savedVersion, opinionsKey]);

  const current = useMemo<DirectorProfile | null>(() => profile ? {
    ...profile,
    priorities: fromLines(lists.priorities),
    taste: fromLines(lists.taste),
    redLines: fromLines(lists.redLines),
  } : null, [profile, lists]);
  const currentContent = useMemo(() => (current ? renderDirectorFile(current, null) : ""), [current]);
  const dirty = Boolean(current && (!exists || currentContent !== savedContent));

  async function save(): Promise<boolean> {
    if (!current || !book) return false;
    if (!current.name.trim()) {
      toast({ title: t("director.saveFailed"), variant: "destructive" });
      return false;
    }
    setBusy(true);
    try {
      await saveDirectorProfile({ book, branch, profile: current });
      setSavedContent(renderDirectorFile(current, null));
      setExists(true);
      toast({ title: t("director.saved") });
      await reload();
      return true;
    } catch (cause) {
      toast({ title: t("director.saveFailed"), description: String(cause), variant: "destructive" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  useRegisterPageSave({ dirty, enabled: Boolean(current && book), onSave: () => save() });

  const patch = (next: Partial<DirectorProfile>) => setProfile((previous) => (previous ? { ...previous, ...next } : previous));
  const setWeight = (slug: string, weight: number) => setProfile((previous) => {
    if (!previous) return previous;
    const readerWeights = { ...previous.readerWeights };
    if (weight === 1) delete readerWeights[slug];
    else readerWeights[slug] = weight;
    return { ...previous, readerWeights };
  });

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Clapperboard className="h-6 w-6 text-primary" />{t("director.title")}</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t("director.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
          <Button onClick={() => bookId && openAskDirector({ bookId, target: { kind: "book" } })}><Clapperboard className="h-4 w-4" />{t("director.ask.title")}</Button>
          <Button asChild variant="outline"><Link to={`/app/books/${encodeURIComponent(book.id)}/autopilot`}><Plane className="h-4 w-4" />{t("autopilot.title")}</Link></Button>
        </div>
      </div>

      <section className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t("director.profileTitle")}</h2>
          <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || !current?.name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t("director.save")}
          </Button>
        </div>
        {(loading && !structure) || !profile ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
        ) : (
          <>
            {!exists && <Alert><AlertDescription>{t("director.defaults")}</AlertDescription></Alert>}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="space-y-1.5"><Label htmlFor="director-name">{t("director.name")}</Label><Input id="director-name" value={profile.name} onChange={(event) => patch({ name: event.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="director-language">{t("director.language")}</Label><Input id="director-language" value={profile.language} onChange={(event) => patch({ language: event.target.value })} /></div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="director-persona">{t("director.persona")}</Label>
              <AutoTextarea id="director-persona" value={profile.persona} onChange={(event) => patch({ persona: event.target.value })} minRows={2} className="text-sm leading-6" />
            </div>
            <div className="space-y-1.5 lg:max-w-md">
              <Label>{t("director.autonomy")}</Label>
              <Select value={profile.autonomy} onValueChange={(value) => patch({ autonomy: value as DirectorAutonomy })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DIRECTOR_AUTONOMIES.map((autonomy) => <SelectItem key={autonomy} value={autonomy}>{t(`director.autonomyOptions.${autonomy}`)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid items-end gap-3 sm:grid-cols-3">
              <div className="space-y-1.5"><Label htmlFor="director-strictness">{t("director.strictness")}</Label><Input id="director-strictness" type="number" min={1} max={10} value={profile.strictness} onChange={(event) => patch({ strictness: clamp(event.target.value, 1, 10, profile.strictness) })} /></div>
              <div className="space-y-1.5"><Label htmlFor="director-approval">{t("director.approvalScore")}</Label><Input id="director-approval" type="number" min={1} max={10} value={profile.approvalScore} onChange={(event) => patch({ approvalScore: clamp(event.target.value, 1, 10, profile.approvalScore) })} /></div>
              <div className="space-y-1.5"><Label htmlFor="director-rounds">{t("director.maxReviewRounds")}</Label><Input id="director-rounds" type="number" min={1} max={3} value={profile.maxReviewRounds} onChange={(event) => patch({ maxReviewRounds: clamp(event.target.value, 1, 3, profile.maxReviewRounds) })} /></div>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {([["priorities", t("director.priorities")], ["taste", t("director.taste")], ["redLines", t("director.redLines")]] as Array<[ListField, string]>).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`director-${field}`}>{label}</Label>
                  <AutoTextarea id={`director-${field}`} value={lists[field]} onChange={(event) => setLists((previous) => ({ ...previous, [field]: event.target.value }))} minRows={4} className="text-sm leading-6" />
                  <p className="text-xs text-muted-foreground">{t("director.listHint")}</p>
                </div>
              ))}
            </div>
            {readers.length > 0 && (
              <div className="space-y-2">
                <div>
                  <Label>{t("director.readerWeights")}</Label>
                  <p className="text-xs text-muted-foreground">{t("director.readerWeightsHint")}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {readers.map((reader) => (
                    <div key={reader.slug} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
                      <span className="min-w-0 truncate text-sm">{reader.name}</span>
                      <Select value={String(profile.readerWeights[reader.slug] ?? 1)} onValueChange={(value) => setWeight(reader.slug, Number(value))}>
                        <SelectTrigger className="h-8 w-36 shrink-0"><SelectValue /></SelectTrigger>
                        <SelectContent>{[0, 1, 2, 3].map((weight) => <SelectItem key={weight} value={String(weight)}>{weight} · {t(`director.readerWeight.${weight}`)}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="director-vision">{t("director.vision")}</Label>
              <AutoTextarea id="director-vision" value={profile.body} onChange={(event) => patch({ body: event.target.value })} minRows={6} className="text-sm leading-7" />
            </div>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t("director.opinions.title")}</h2>
          <Button size="sm" variant="ghost" onClick={() => setOpinionsKey((value) => value + 1)} disabled={opinionsLoading}>
            {opinionsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}{t("autopilot.actions.refresh")}
          </Button>
        </div>
        {opinions === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
        ) : opinions.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("director.opinions.empty")}</p>
        ) : (
          <div className="space-y-2">
            {opinions.map((record) => <OpinionRecord key={record.path} record={record} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function OpinionRecord({ record }: { record: DirectorOpinionRecord }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? renderRepositoryMarkdownHtml(record.body) : ""), [open, record.body]);
  return (
    <details className="rounded-xl border" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 p-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{record.title}</span>
        <DirectorVerdictBadge verdict={record.verdict} score={record.score} />
        <span className="text-xs text-muted-foreground">{t(`director.opinions.source.${record.source}`)} · {formatDateTime(record.createdAt)}</span>
        {record.question && <span className="w-full truncate text-xs italic text-muted-foreground">«{record.question}»</span>}
      </summary>
      {open && <div className="doc-prose max-w-none border-t px-4 py-3 text-sm" dangerouslySetInnerHTML={{ __html: html }} />}
    </details>
  );
}
