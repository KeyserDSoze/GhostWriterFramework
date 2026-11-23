import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clapperboard, Loader2, Plane, RefreshCcw } from "lucide-react";
import { BookConflictError, DIRECTOR_AUTONOMIES, listDirectorOpinions, type DirectorOpinionRecord, type DirectorProfile, type ReaderPersonaProfile } from "narrarium-engine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { FileChangedNotice } from "@/components/book/FileChangedNotice";
import { ProfileWarnings, confirmProfileSave } from "@/components/book/ProfileWarnings";
import { DirectorVerdictBadge } from "@/components/director/DirectorOpinionView";
import { DirectorPreview } from "@/components/director/DirectorPreview";
import { LanguageField } from "@/components/director/LanguageField";
import { OpinionTrend } from "@/components/director/OpinionTrend";
import { SaveBar, type SaveBarState } from "@/components/director/SaveBar";
import { ScoreSlider } from "@/components/director/ScoreSlider";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { formatCount, formatDateTime } from "@/autopilot/format";
import { approvalCaption, knownLanguage, strictnessCaption } from "@/director/sheetModel";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useContainerWidth } from "@/hooks/useContainerWidth";
import { useGuardedDocumentLoad } from "@/hooks/useGuardedDocumentLoad";
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

function listsOf(profile: DirectorProfile): Record<ListField, string> {
  return { priorities: toLines(profile.priorities), taste: toLines(profile.taste), redLines: toLines(profile.redLines) };
}

/** A part of the sheet, named by its heading. */
function SheetSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5 ${className ?? ""}`}>
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A choice among a few values, as native radio buttons (the arrows move between them), each said in words and, when it needs it, explained. */
function RadioChoice<T extends string | number>({ name, label, value, options, onChange }: { name: string; label: string; value: T; options: ReadonlyArray<{ value: T; label: string; help?: string }>; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={`${id}-label`} className="space-y-2">
      <p id={`${id}-label`} className="text-sm font-medium leading-none">{label}</p>
      <div className={options.some((option) => option.help) ? "grid gap-2" : "flex flex-wrap gap-2"}>
        {options.map((option) => (
          <div key={String(option.value)} className={`rounded-lg border text-sm transition ${value === option.value ? "border-primary/60 bg-primary/5" : "border-layer hover:bg-muted/40"}`}>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 px-2.5 py-2 font-medium">
              <input
                type="radio"
                name={`${name}-${id}`}
                value={String(option.value)}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                aria-describedby={option.help ? `${id}-${option.value}` : undefined}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              {option.label}
            </label>
            {option.help && <p id={`${id}-${option.value}`} className="-mt-1 px-2.5 pb-2 pl-[2.125rem] text-xs text-muted-foreground">{option.help}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The director as a character sheet: who the director is (name, language, persona), how it judges (autonomy, strictness, the approval score and the
 * rounds of review, with a preview in words of what they do, worked out from the engine's rules), what it cares about, how much each simulated
 * reader weighs, and its vision; then its saved opinions as score cards, with how their scores went. A bar at the bottom says whether the sheet is
 * saved, and saves or discards it (fixed at the bottom of the window, over the page's column); leaving the page with changes asks first.
 */
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [readers, setReaders] = useState<ReaderPersonaProfile[]>([]);
  const [opinions, setOpinions] = useState<DirectorOpinionRecord[] | null>(null);
  const [opinionsLoading, setOpinionsLoading] = useState(false);
  const [opinionsKey, setOpinionsKey] = useState(0);
  // The profile as it was last loaded or saved: what Discard changes goes back to.
  const lastSaved = useRef<DirectorProfile | null>(null);
  // The layout follows the width of the page, not of the screen: the sidebar and the dossier take their part of it.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const { width } = useContainerWidth(root);
  const roomy = width === null || width >= 560;
  const wide = width === null || width >= 860;

  const language = structure?.language;
  const canLoad = Boolean(book && token && structure && ready);

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
  const edited = Boolean(current && currentContent !== savedContent);
  const dirty = Boolean(current && (!exists || edited));

  // The settings are replaced whenever they reload, so the `book` object is new each time: the file is
  // read again only for another book, branch or language, and never over what the author is typing.
  const file = useGuardedDocumentLoad<{ profile: DirectorProfile; exists: boolean }>({
    document: canLoad && book ? `${book.id}|${book.owner}/${book.repo}` : null,
    source: `${branch}|${language ?? ""}`,
    load: async () => {
      const { profile: loaded, exists: present, hash } = await loadDirectorProfile({ book: book!, branch, language });
      return { value: { profile: loaded, exists: present }, version: hash };
    },
    edited,
    apply: ({ profile: loaded, exists: present }) => {
      // A director that is not saved yet speaks the language of the book (the defaults know only English and Italian).
      const bookLanguage = present ? null : knownLanguage(language);
      const sheet = bookLanguage ? { ...loaded, language: bookLanguage } : loaded;
      lastSaved.current = sheet;
      setProfile(sheet);
      setLists(listsOf(sheet));
      setSavedContent(renderDirectorFile(sheet, null));
      setExists(present);
      setSaveError(null);
    },
    onLoading: setBusy,
    onError: (cause) => toast({ title: t("director.loadFailed"), description: String(cause), variant: "destructive" }),
  });

  async function save(): Promise<boolean> {
    if (!current || !book) return false;
    if (!current.name.trim()) {
      toast({ title: t("director.saveFailed"), variant: "destructive" });
      return false;
    }
    // The file is rewritten from the form: what the engine could not read of it would be lost.
    if (!confirmProfileSave(t, current.warnings)) return false;
    setBusy(true);
    setSaveError(null);
    try {
      const { hash } = await saveDirectorProfile({ book, branch, profile: current, expectedHash: file.baseVersion() });
      file.adopt(hash);
      setSavedContent(renderDirectorFile(current, null));
      lastSaved.current = { ...current, warnings: [] };
      setProfile((previous) => (previous ? { ...previous, warnings: [] } : previous));
      setExists(true);
      toast({ title: t("director.saved") });
      await reload();
      return true;
    } catch (cause) {
      if (cause instanceof BookConflictError) {
        file.flagChanged();
        setSaveError(t("director.bar.conflict"));
        toast({ title: t("director.saveFailed"), description: t("director.changedElsewhere"), variant: "destructive" });
      } else {
        setSaveError(cause instanceof Error ? cause.message : String(cause));
        toast({ title: t("director.saveFailed"), description: String(cause), variant: "destructive" });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    const saved = lastSaved.current;
    if (!saved) return;
    setProfile(saved);
    setLists(listsOf(saved));
    setSaveError(null);
  }

  useRegisterPageSave({ dirty, enabled: Boolean(current && book), onSave: () => save() });

  const patch = (next: Partial<DirectorProfile>) => {
    setSaveError(null);
    setProfile((previous) => (previous ? { ...previous, ...next } : previous));
  };
  const setWeight = (slug: string, weight: number) => setProfile((previous) => {
    if (!previous) return previous;
    const readerWeights = { ...previous.readerWeights };
    if (weight === 1) delete readerWeights[slug];
    else readerWeights[slug] = weight;
    return { ...previous, readerWeights };
  });

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const barState: SaveBarState = busy && profile ? "saving" : saveError ? "failed" : edited ? "unsaved" : !exists ? "defaults" : "saved";
  const strictnessWord = profile ? t(`director.scale.${strictnessCaption(profile.strictness)}`) : "";
  const approvalWord = profile ? t(`director.scale.${approvalCaption(profile.approvalScore)}`) : "";
  const ask = () => bookId && openAskDirector({ bookId, target: { kind: "book" } });

  return (
    <div ref={setRoot} className="mx-auto max-w-5xl space-y-6">
      <header className={`flex gap-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5 ${wide ? "flex-row items-start" : "flex-col"}`}>
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Clapperboard className="h-8 w-8" /></div>
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("director.title")}</p>
            <h1 className="break-words font-serif text-3xl font-semibold tracking-tight">{profile?.name.trim() || t("director.title")}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("director.description")}</p>
            {profile && (
              <ul aria-label={t("director.chips.label")} className="flex flex-wrap gap-1.5">
                <li><Badge variant="outline">{t(`director.autonomyOptions.${profile.autonomy}`)}</Badge></li>
                <li><Badge variant="outline">{t("director.chips.strictness", { caption: strictnessWord })}</Badge></li>
                <li><Badge variant="outline">{t("director.chips.approval", { value: formatCount(profile.approvalScore) })}</Badge></li>
                <li><Badge variant="outline">{t("director.chips.rounds", { count: profile.maxReviewRounds })}</Badge></li>
              </ul>
            )}
          </div>
        </div>
        <div className={`flex flex-wrap gap-2 ${wide ? "shrink-0 justify-end" : ""}`}>
          <Button className="min-h-11 sm:min-h-10" onClick={ask}><Clapperboard className="h-4 w-4" aria-hidden="true" />{t("director.ask.title")}</Button>
          <Button asChild variant="outline" className="min-h-11 sm:min-h-10"><Link to={`/app/books/${encodeURIComponent(book.id)}/autopilot`}><Plane className="h-4 w-4" aria-hidden="true" />{t("autopilot.title")}</Link></Button>
        </div>
      </header>

      {file.changedElsewhere && <FileChangedNotice message={t("director.changedElsewhere")} reloadLabel={t("director.reloadFile")} onReload={file.reload} />}
      {(loading && !structure) || !profile ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("common.loading")}</div>
      ) : (
        <>
          <ProfileWarnings warnings={profile.warnings} />
          {!exists && <Alert><AlertDescription>{t("director.defaults")}</AlertDescription></Alert>}

          <SheetSection title={t("director.sections.identity")}>
            <div className={`grid gap-3 ${roomy ? "grid-cols-2" : ""}`}>
              <div className="space-y-1.5"><Label htmlFor="director-name">{t("director.name")}</Label><Input id="director-name" className="h-11 sm:h-10" value={profile.name} onChange={(event) => patch({ name: event.target.value })} /></div>
              <LanguageField value={profile.language} bookLanguage={language} onChange={(code) => patch({ language: code })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="director-persona">{t("director.persona")}</Label>
              <AutoTextarea id="director-persona" value={profile.persona} onChange={(event) => patch({ persona: event.target.value })} minRows={2} className="text-sm leading-6" />
            </div>
          </SheetSection>

          <SheetSection title={t("director.sections.judgement")}>
            <div className={`grid gap-5 ${wide ? "grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" : ""}`}>
              <div className="space-y-5">
                <RadioChoice
                  name="autonomy"
                  label={t("director.autonomy")}
                  value={profile.autonomy}
                  options={DIRECTOR_AUTONOMIES.map((autonomy) => ({ value: autonomy, label: t(`director.autonomyOptions.${autonomy}`), help: t(`director.autonomyHelp.${autonomy}`) }))}
                  onChange={(autonomy) => patch({ autonomy })}
                />
                <ScoreSlider
                  label={t("director.strictness")}
                  value={profile.strictness}
                  onChange={(strictness) => patch({ strictness })}
                  valueText={t("director.strictnessValue", { value: formatCount(profile.strictness), caption: strictnessWord })}
                  caption={strictnessWord}
                  scale={[t("director.scale.lenient"), t("director.scale.balanced"), t("director.scale.strict")]}
                  numberLabel={t("director.asNumber", { label: t("director.strictness") })}
                  help={t("director.strictnessHelp")}
                />
                <ScoreSlider
                  label={t("director.approvalScore")}
                  value={profile.approvalScore}
                  onChange={(approvalScore) => patch({ approvalScore })}
                  valueText={t("director.approvalValue", { value: formatCount(profile.approvalScore), caption: approvalWord })}
                  caption={approvalWord}
                  scale={[t("director.scale.low"), t("director.scale.medium"), t("director.scale.high")]}
                  numberLabel={t("director.asNumber", { label: t("director.approvalScore") })}
                  help={t("director.approvalHelp")}
                />
                <RadioChoice
                  name="rounds"
                  label={t("director.maxReviewRounds")}
                  value={Math.min(3, Math.max(1, Math.round(profile.maxReviewRounds)))}
                  options={[1, 2, 3].map((count) => ({ value: count, label: t("director.rounds", { count }) }))}
                  onChange={(maxReviewRounds) => patch({ maxReviewRounds })}
                />
              </div>
              <div className={wide ? "sticky top-4 self-start" : ""}>
                <DirectorPreview profile={profile} />
              </div>
            </div>
          </SheetSection>

          <SheetSection title={t("director.sections.cares")}>
            <div className={`grid gap-3 ${wide ? "grid-cols-3" : ""}`}>
              {([["priorities", t("director.priorities")], ["taste", t("director.taste")], ["redLines", t("director.redLines")]] as Array<[ListField, string]>).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`director-${field}`}>{label}</Label>
                  <AutoTextarea id={`director-${field}`} value={lists[field]} onChange={(event) => { setSaveError(null); setLists((previous) => ({ ...previous, [field]: event.target.value })); }} minRows={4} className="text-sm leading-6" />
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
                <div className={`grid gap-2 ${roomy ? "grid-cols-2" : ""}`}>
                  {readers.map((reader) => (
                    <div key={reader.slug} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
                      <span className="min-w-0 truncate text-sm">{reader.name}</span>
                      <Select value={String(profile.readerWeights[reader.slug] ?? 1)} onValueChange={(value) => setWeight(reader.slug, Number(value))}>
                        <SelectTrigger className="h-9 w-36 shrink-0" aria-label={`${t("director.readerWeights")}: ${reader.name}`}><SelectValue /></SelectTrigger>
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
          </SheetSection>
        </>
      )}

      <section aria-labelledby="director-opinions-title" className="space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="director-opinions-title" className="text-lg font-semibold">{t("director.opinions.title")}</h2>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-9" onClick={() => setOpinionsKey((value) => value + 1)} disabled={opinionsLoading}>
            {opinionsLoading ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCcw className="h-4 w-4" aria-hidden="true" />}{t("autopilot.actions.refresh")}
          </Button>
        </div>
        {opinions === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("common.loading")}</div>
        ) : opinions.length === 0 ? (
          <div className="space-y-3 rounded-xl border border-dashed p-4">
            <p className="text-sm text-muted-foreground">{t("director.trend.empty")}</p>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={ask}><Clapperboard className="h-4 w-4" aria-hidden="true" />{t("director.ask.title")}</Button>
          </div>
        ) : (
          <>
            <OpinionTrend records={opinions} threshold={profile?.approvalScore ?? 7} />
            <ul aria-label={t("director.opinions.title")} className="space-y-2">
              {opinions.map((record) => <li key={record.path}><OpinionRecord record={record} /></li>)}
            </ul>
          </>
        )}
      </section>

      {profile && <SaveBar anchor={root} state={barState} reason={saveError ?? undefined} edited={edited} canSave={dirty && Boolean(current?.name.trim())} busy={busy} onSave={() => void save()} onDiscard={discard} />}
    </div>
  );
}

/** A saved opinion as a small score card: the score with its scale, the verdict, what it is on, who asked and when; it opens on what the director wrote. */
function OpinionRecord({ record }: { record: DirectorOpinionRecord }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? renderRepositoryMarkdownHtml(record.body) : ""), [open, record.body]);
  return (
    <details className="rounded-xl border border-layer" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-3 rounded-xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex items-baseline gap-0.5">
          <span data-score className="font-serif text-2xl font-semibold leading-none tabular-nums">{formatCount(record.score)}</span>
          <span className="text-xs text-muted-foreground">/10</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium">{record.title}</span>
          <span className="block text-xs text-muted-foreground">{t(`director.opinions.source.${record.source}`)} · {formatDateTime(record.createdAt)}</span>
          {record.question && <span className="block truncate text-xs italic text-muted-foreground">«{record.question}»</span>}
        </span>
        <DirectorVerdictBadge verdict={record.verdict} />
      </summary>
      {open && <div className="doc-prose max-w-none border-t px-4 py-3 text-sm" dangerouslySetInnerHTML={{ __html: html }} />}
    </details>
  );
}
