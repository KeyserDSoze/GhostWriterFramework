import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, PenLine, Plus, Save, Star, Trash2, Users } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { useRegisterPageSave } from "@/store/saveStore";
import { resolveBookToken } from "@/types/settings";
import { readFileWithSha } from "@/github/githubClient";
import { emptyGhostwriter, parseGhostwriter, serializeGhostwriter, type GhostwriterProfile } from "@/narrarium/ghostwriter";
import { slugify } from "@/narrarium/canon";
import { resolveUnsavedChanges } from "@/hooks/resolveUnsavedChanges";
import { captureImmediateMutation, commitImmediateMutation, commitImmediateMutations } from "@/assistant/immediateMutation";

export function GhostwritersPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  const [selected, setSelected] = useState<string | null>(null);
  const [profile, setProfile] = useState<GhostwriterProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const list = useMemo(() => structure?.ghostwriters ?? [], [structure]);

  useEffect(() => {
    if (!book || !token || !selected) return;
    const entry = list.find((g) => g.slug === selected);
    if (!entry) return;
    setBusy(true);
    readFileWithSha(token, book.owner, book.repo, branch, entry.path)
      .then(({ content }) => {
        const loaded = parseGhostwriter(selected, content);
        setProfile(loaded);
        setSavedProfile(serializeGhostwriter(loaded));
      })
      .catch((err) => toast({ title: t("ghostwriters.loadFailed"), description: String(err), variant: "destructive" }))
      .finally(() => setBusy(false));
  }, [book, token, branch, selected, list, t, toast]);

  async function createGhostwriter() {
    const name = newName.trim();
    if (!name || !book || !token || !await allowProfileChange()) return;
    const slug = slugify(name);
    setBusy(true);
    try {
      const content = serializeGhostwriter({ slug, ...emptyGhostwriter(name) });
      const snapshot = await captureImmediateMutation({ token, book, branch, path: `ghostwriters/${slug}.md` });
      if (snapshot.content) throw new Error(t("ghostwriters.alreadyExists"));
      await commitImmediateMutation({ token, book, branch, snapshot, content, message: `Add ghostwriter ${slug}` });
      setNewName(""); setCreating(false);
      await reload();
      setSelected(slug);
    } catch (err) {
      toast({ title: t("ghostwriters.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function save(): Promise<boolean> {
    if (!profile || !book || !token) return false;
    setBusy(true);
    try {
      const content = serializeGhostwriter(profile);
      const snapshot = await captureImmediateMutation({ token, book, branch, path: `ghostwriters/${profile.slug}.md` });
      await commitImmediateMutation({ token, book, branch, snapshot, content, message: `Update ghostwriter ${profile.slug}` });
      setSavedProfile(content);
      toast({ title: t("common.saved") });
      await reload();
      return true;
    } catch (err) {
      toast({ title: t("ghostwriters.saveFailed"), description: String(err), variant: "destructive" });
      return false;
    } finally { setBusy(false); }
  }

  const dirty = Boolean(profile && serializeGhostwriter(profile) !== savedProfile);
  useRegisterPageSave({ dirty, enabled: Boolean(profile && book && token), onSave: () => save() });

  async function allowProfileChange(): Promise<boolean> {
    return resolveUnsavedChanges({
      dirty,
      save,
      saveMessage: t("common.unsavedSaveConfirm"),
      discardMessage: t("common.unsavedDiscardConfirm"),
    });
  }

  async function selectProfile(slug: string) {
    if (slug === selected || !await allowProfileChange()) return;
    setSelected(slug);
  }

  async function remove() {
    if (!profile || !book || !token || structure?.ghostwriter === profile.slug) return;
    setBusy(true);
    try {
      const snapshot = await captureImmediateMutation({ token, book, branch, path: `ghostwriters/${profile.slug}.md` });
      if (!snapshot.content) return;
      await commitImmediateMutations({ token, book, branch, snapshots: [{ snapshot, content: null }], message: `Remove ghostwriter ${profile.slug}` });
      setSelected(null); setProfile(null); setSavedProfile("");
      await reload();
    } catch (err) {
      toast({ title: t("ghostwriters.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function setAsDefault() {
    if (!profile || !book || !token || structure?.ghostwriter === profile.slug || !await allowProfileChange()) return;
    setBusy(true);
    try {
      const snapshot = await captureImmediateMutation({ token, book, branch, path: "book.md" });
      const match = snapshot.content ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(snapshot.content) : null;
      const frontmatter = match ? ((parseDocument(match[1]).toJSON() as Record<string, unknown>) ?? {}) : { type: "book", id: "book", title: structure?.title ?? book.name };
      frontmatter.ghostwriter = profile.slug;
      const content = `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${(match?.[2] ?? structure?.description ?? "").trim()}\n`;
      await commitImmediateMutation({ token, book, branch, snapshot, content, message: `Set default ghostwriter ${profile.slug}` });
      await reload();
      toast({ title: t("ghostwriters.defaultSet", { name: profile.name }) });
    } catch (err) {
      toast({ title: t("ghostwriters.saveFailed"), description: String(err), variant: "destructive" });
    } finally { setBusy(false); }
  }

  const patch = (p: Partial<GhostwriterProfile>) => setProfile((prev) => (prev ? { ...prev, ...p } : prev));
  const csv = (arr: string[]) => arr.join(", ");
  const fromCsv = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><Users className="h-5 w-5" />{t("ghostwriters.title")}</h1>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="mr-1 h-4 w-4" />{t("ghostwriters.new")}</Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("ghostwriters.intro")}</p>
        {creating && (
          <div className="flex gap-2">
            <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("ghostwriters.namePlaceholder")} onKeyDown={(e) => { if (e.key === "Enter") void createGhostwriter(); }} />
            <Button size="sm" onClick={() => void createGhostwriter()} disabled={!newName.trim() || busy}>{t("common.add")}</Button>
          </div>
        )}
        {loading && !structure ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("ghostwriters.loading")}</div> : null}
        {list.length === 0 && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("ghostwriters.empty")}</p>}
        <div className="space-y-1">
          {list.map((g) => (
            <button key={g.slug} type="button" onClick={() => void selectProfile(g.slug)} className={selected === g.slug ? "flex w-full items-center gap-2 rounded-lg border bg-primary/5 px-3 py-2 text-left text-sm" : "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/40"}>
              <PenLine className="h-4 w-4 text-muted-foreground" />{g.name}{structure?.ghostwriter === g.slug && <Star className="ml-auto h-3.5 w-3.5 fill-current text-amber-500" />}
            </button>
          ))}
        </div>
      </div>

      <div>
        {!profile ? (
          <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("ghostwriters.selectHint")}</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl font-semibold">{profile.name}</h2>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void setAsDefault()} disabled={busy || structure?.ghostwriter === profile.slug}><Star className="mr-1 h-4 w-4" />{structure?.ghostwriter === profile.slug ? t("ghostwriters.defaultActive") : t("ghostwriters.setDefault")}</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy || structure?.ghostwriter === profile.slug}><Trash2 className="mr-1 h-4 w-4" />{t("common.delete")}</Button>
                <Button size="sm" onClick={() => void save()} disabled={busy || !dirty}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1"><Label>{t("ghostwriters.writingStyle")}</Label><AutoTextarea value={profile.writingStyle} onChange={(e) => patch({ writingStyle: e.target.value })} className="min-h-32 text-sm leading-6" /></div>
              <div className="space-y-1"><Label>{t("ghostwriters.punctuationStyle")}</Label><AutoTextarea value={profile.punctuationStyle} onChange={(e) => patch({ punctuationStyle: e.target.value })} className="min-h-32 text-sm leading-6" /></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("ghostwriters.name")} value={profile.name} onChange={(v) => patch({ name: v })} />
              <Field label={t("ghostwriters.language")} value={profile.language} onChange={(v) => patch({ language: v })} />
              <Field label={t("ghostwriters.tone")} value={profile.tone} onChange={(v) => patch({ tone: v })} />
              <Field label={t("ghostwriters.voice")} value={profile.voice} onChange={(v) => patch({ voice: v })} />
              <Field label={t("ghostwriters.pov")} value={profile.povDefault} onChange={(v) => patch({ povDefault: v })} />
              <Field label={t("ghostwriters.tense")} value={profile.tenseDefault} onChange={(v) => patch({ tenseDefault: v })} />
              <Field label={t("ghostwriters.rhythm")} value={profile.sentenceRhythm} onChange={(v) => patch({ sentenceRhythm: v })} />
              <Field label={t("ghostwriters.dialogue")} value={profile.dialogueStyle} onChange={(v) => patch({ dialogueStyle: v })} />
              <Field label={t("ghostwriters.vocabulary")} value={profile.vocabulary} onChange={(v) => patch({ vocabulary: v })} />
              <Field label={t("ghostwriters.temperature")} value={String(profile.temperature)} onChange={(v) => patch({ temperature: Number(v) || 0 })} />
              <Field label={t("ghostwriters.influences")} value={csv(profile.influences)} onChange={(v) => patch({ influences: fromCsv(v) })} />
              <Field label={t("ghostwriters.strengths")} value={csv(profile.strengths)} onChange={(v) => patch({ strengths: fromCsv(v) })} />
              <Field label={t("ghostwriters.avoid")} value={csv(profile.avoid)} onChange={(v) => patch({ avoid: fromCsv(v) })} />
            </div>
            <div className="space-y-1">
              <Label>{t("ghostwriters.instructions")}</Label>
              <AutoTextarea value={profile.body} onChange={(e) => patch({ body: e.target.value })} className="text-sm leading-7" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
    </div>
  );
}
