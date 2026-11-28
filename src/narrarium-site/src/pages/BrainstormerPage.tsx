import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Compass, Loader2, Sparkles } from "lucide-react";
import { BookConflictError, brainstormerBoldnessBand, type BrainstormerProfile } from "narrarium-engine";
import "@/i18n/brainstormer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { FileChangedNotice } from "@/components/book/FileChangedNotice";
import { ProfileWarnings, confirmProfileSave } from "@/components/book/ProfileWarnings";
import { SaveBar, type SaveBarState } from "@/components/layout/SaveBar";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useBooksStore } from "@/store/booksStore";
import { useGuardedDocumentLoad } from "@/hooks/useGuardedDocumentLoad";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { studioHref } from "@/autopilot/pitchChoice";
import { loadBrainstormerProfile, renderBrainstormerFile, saveBrainstormerProfile } from "@/narrarium/brainstormer";
import { useRegisterPageSave } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveWorkingCopyToken } from "@/types/settings";

type ListField = "priorities" | "avoid";

const toLines = (values: string[]): string => values.join("\n");
const fromLines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
const listsOf = (profile: BrainstormerProfile): Record<ListField, string> => ({ priorities: toLines(profile.priorities), avoid: toLines(profile.avoid) });

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The Brainstormer as a character sheet: who it is (name, language, persona), how bold it is, what it cares about and what it refuses, and its method. The design run of the autopilot
 * reads it (`brainstormer.md`): the pitches it proposes, the foundation and the chapters it designs, and the weak parts it rewrites are written in its voice. A bar at the bottom says
 * whether the sheet is saved, and saves or discards it; leaving the page with changes asks first.
 */
export function BrainstormerPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const generation = useBooksStore((state) => (bookId ? state.structureGenerations[bookId] ?? 0 : 0));
  const token = book ? resolveWorkingCopyToken(book, settings) : "";
  const [profile, setProfile] = useState<BrainstormerProfile | null>(null);
  const [lists, setLists] = useState<Record<ListField, string>>({ priorities: "", avoid: "" });
  const [savedContent, setSavedContent] = useState("");
  const [exists, setExists] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastSaved = useRef<BrainstormerProfile | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const id = useId();
  const language = structure?.language;
  const canLoad = Boolean(book && token && structure && ready);

  const current = useMemo<BrainstormerProfile | null>(() => (profile ? { ...profile, priorities: fromLines(lists.priorities), avoid: fromLines(lists.avoid) } : null), [profile, lists]);
  const currentContent = useMemo(() => (current ? renderBrainstormerFile(current, null) : ""), [current]);
  const edited = Boolean(current && currentContent !== savedContent);
  const dirty = Boolean(current && (!exists || edited));

  const file = useGuardedDocumentLoad<{ profile: BrainstormerProfile; exists: boolean }>({
    document: canLoad && book ? `${book.id}|${book.owner}/${book.repo}` : null,
    source: `${branch}|${language ?? ""}|${generation}`,
    load: async () => {
      const { profile: loaded, exists: present, hash } = await loadBrainstormerProfile({ book: book!, branch, language });
      return { value: { profile: loaded, exists: present }, version: hash };
    },
    edited,
    apply: ({ profile: loaded, exists: present }) => {
      lastSaved.current = loaded;
      setProfile(loaded);
      setLists(listsOf(loaded));
      setSavedContent(renderBrainstormerFile(loaded, null));
      setExists(present);
      setSaveError(null);
    },
    onLoading: setBusy,
    onError: (cause) => toast({ title: t("brainstormerPage.loadFailed"), description: String(cause), variant: "destructive" }),
  });

  async function save(): Promise<boolean> {
    if (!current || !book) return false;
    if (!current.name.trim()) {
      toast({ title: t("brainstormerPage.saveFailed"), variant: "destructive" });
      return false;
    }
    // The file is rewritten from the form: what the engine could not read of it would be lost.
    if (!confirmProfileSave(t, current.warnings)) return false;
    setBusy(true);
    setSaveError(null);
    try {
      const { hash } = await saveBrainstormerProfile({ book, branch, profile: current, expectedHash: file.baseVersion() });
      file.adopt(hash);
      setSavedContent(renderBrainstormerFile(current, null));
      lastSaved.current = { ...current, warnings: [] };
      setProfile((previous) => (previous ? { ...previous, warnings: [] } : previous));
      setExists(true);
      toast({ title: t("brainstormerPage.saved") });
      await reload();
      return true;
    } catch (cause) {
      if (cause instanceof BookConflictError) {
        file.flagChanged();
        setSaveError(t("brainstormerPage.bar.conflict"));
        toast({ title: t("brainstormerPage.saveFailed"), description: t("brainstormerPage.changedElsewhere"), variant: "destructive" });
      } else {
        setSaveError(cause instanceof Error ? cause.message : String(cause));
        toast({ title: t("brainstormerPage.saveFailed"), description: String(cause), variant: "destructive" });
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

  useRegisterPageSave({ dirty: edited, enabled: Boolean(current && book), onSave: () => save() });

  const patch = (next: Partial<BrainstormerProfile>) => {
    setSaveError(null);
    setProfile((previous) => (previous ? { ...previous, ...next } : previous));
  };

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const barState: SaveBarState = busy && profile ? "saving" : saveError ? "failed" : edited ? "unsaved" : !exists ? "defaults" : "saved";
  // The word for a boldness is one of the four the engine tells the model about.
  const caption = profile ? t(`brainstormerPage.boldness.captions.${brainstormerBoldnessBand(profile.boldness)}`) : "";

  return (
    <div ref={setRoot} className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-col gap-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:flex-row sm:items-start sm:p-5">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="h-8 w-8" /></div>
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("brainstormerPage.title")}</p>
            <h1 className="break-words font-serif text-3xl font-semibold tracking-tight">{profile?.name.trim() || t("brainstormerPage.title")}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("brainstormerPage.description")}</p>
            {profile && <ul className="flex flex-wrap gap-1.5"><li><Badge variant="outline">{t("brainstormerPage.boldness.value", { value: profile.boldness, caption })}</Badge></li></ul>}
          </div>
        </div>
        <Button asChild variant="outline" className="min-h-11 sm:min-h-10"><Link to={studioHref(book.id)}><Compass className="h-4 w-4" aria-hidden="true" />{t("brainstormerPage.open")}</Link></Button>
      </header>

      {file.changedElsewhere && <FileChangedNotice message={t("brainstormerPage.changedElsewhere")} reloadLabel={t("brainstormerPage.reload")} onReload={file.reload} />}
      {(loading && !structure) || !profile ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("common.loading")}</div>
      ) : (
        <>
          <ProfileWarnings warnings={profile.warnings} />
          {!exists && <Alert><AlertDescription>{t("brainstormerPage.defaults")}</AlertDescription></Alert>}

          <Section title={t("brainstormerPage.sections.identity")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-name`}>{t("brainstormerPage.name")}</Label>
                <Input id={`${id}-name`} className="h-11 sm:h-10" value={profile.name} onChange={(event) => patch({ name: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-language`}>{t("brainstormerPage.language")}</Label>
                <Input id={`${id}-language`} className="h-11 sm:h-10" value={profile.language} aria-describedby={`${id}-language-hint`} onChange={(event) => patch({ language: event.target.value })} />
                <p id={`${id}-language-hint`} className="text-xs text-muted-foreground">{t("brainstormerPage.languageHint")}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-persona`}>{t("brainstormerPage.persona")}</Label>
              <AutoTextarea id={`${id}-persona`} value={profile.persona} aria-describedby={`${id}-persona-hint`} onChange={(event) => patch({ persona: event.target.value })} minRows={2} className="text-sm leading-6" />
              <p id={`${id}-persona-hint`} className="text-xs text-muted-foreground">{t("brainstormerPage.personaHint")}</p>
            </div>
          </Section>

          <Section title={t("brainstormerPage.sections.boldness")}>
            <div className="space-y-2">
              <Label htmlFor={`${id}-boldness`}>{t("brainstormerPage.boldness.label")}</Label>
              <div className="flex items-center gap-3">
                <input
                  id={`${id}-boldness`}
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={profile.boldness}
                  aria-valuetext={t("brainstormerPage.boldness.value", { value: profile.boldness, caption })}
                  aria-describedby={`${id}-boldness-help`}
                  className="h-11 min-w-0 flex-1 accent-primary"
                  onChange={(event) => patch({ boldness: Number(event.target.value) })}
                />
                <output htmlFor={`${id}-boldness`} className="w-28 shrink-0 text-sm font-medium">{t("brainstormerPage.boldness.value", { value: profile.boldness, caption })}</output>
              </div>
              <div aria-hidden="true" className="flex justify-between text-xs text-muted-foreground"><span>{t("brainstormerPage.boldness.scale.low")}</span><span>{t("brainstormerPage.boldness.scale.middle")}</span><span>{t("brainstormerPage.boldness.scale.high")}</span></div>
              <p id={`${id}-boldness-help`} className="text-xs text-muted-foreground">{t("brainstormerPage.boldness.help")}</p>
            </div>
          </Section>

          <Section title={t("brainstormerPage.sections.cares")}>
            <div className="grid gap-3 sm:grid-cols-2">
              {([["priorities", t("brainstormerPage.priorities")], ["avoid", t("brainstormerPage.avoid")]] as Array<[ListField, string]>).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`${id}-${field}`}>{label}</Label>
                  <AutoTextarea id={`${id}-${field}`} value={lists[field]} onChange={(event) => { setSaveError(null); setLists((previous) => ({ ...previous, [field]: event.target.value })); }} minRows={4} className="text-sm leading-6" />
                  <p className="text-xs text-muted-foreground">{t("brainstormerPage.listHint")}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title={t("brainstormerPage.sections.method")}>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-method`}>{t("brainstormerPage.method")}</Label>
              <AutoTextarea id={`${id}-method`} value={profile.body} aria-describedby={`${id}-method-hint`} onChange={(event) => patch({ body: event.target.value })} minRows={5} className="text-sm leading-7" />
              <p id={`${id}-method-hint`} className="text-xs text-muted-foreground">{t("brainstormerPage.methodHint")}</p>
            </div>
          </Section>
        </>
      )}

      {profile && (
        <SaveBar
          anchor={root}
          label={t("brainstormerPage.bar.label")}
          state={barState}
          status={barState === "failed" ? t("brainstormerPage.bar.failed", { reason: saveError ?? "" }) : t(`brainstormerPage.bar.${barState}`)}
          saveLabel={t("brainstormerPage.save")}
          canSave={dirty && Boolean(current?.name.trim())}
          busy={busy}
          onSave={() => void save()}
          discard={{ label: t("brainstormerPage.bar.discard"), enabled: edited, onDiscard: discard }}
        />
      )}
    </div>
  );
}

export default BrainstormerPage;
