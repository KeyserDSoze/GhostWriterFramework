import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Copy, Loader2, Plus, RotateCcw, Save, Trash2, Users } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { deleteReaderPersonaOverride, findOrphanReaderEvaluationPaths, loadReaderPersonas, saveReaderPersona } from "@/narrarium/readerEvaluations";
import { emptyReaderPersona, type ReaderPersonaProfile } from "@/narrarium/readerPersona";
import { slugify } from "@/narrarium/canon";

export function ReaderPersonasPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const [profiles, setProfiles] = useState<ReaderPersonaProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ReaderPersonaProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "standard" | "genre" | "custom">("all");

  async function load() {
    if (!book || !structure || !token) return;
    setLoading(true);
    try {
      const loaded = await loadReaderPersonas({ token, book, branch, structure });
      setProfiles(loaded);
      const selected = loaded.find((profile) => profile.id === selectedId) ?? loaded[0];
      setSelectedId(selected?.id ?? "");
      setDraft(selected ? { ...selected } : null);
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [book?.id, structure?.loadedBranch, token]);
  const visible = useMemo(() => profiles.filter((profile) => filter === "all" || profile.readerType === filter), [filter, profiles]);
  const orphanPaths = structure ? findOrphanReaderEvaluationPaths(structure) : [];

  function select(profile: ReaderPersonaProfile) {
    setSelectedId(profile.id);
    setDraft({ ...profile });
  }

  async function persist(profile: ReaderPersonaProfile) {
    if (!book || !token) return;
    setBusy(true);
    try {
      const slug = profile.slug || slugify(profile.name) || `reader-${crypto.randomUUID().slice(0, 8)}`;
      await saveReaderPersona({ token, book, branch, profile: { ...profile, slug } });
      await reload();
      await load();
      toast({ title: t("readerPersonas.saved") });
    } catch (err) { toast({ title: t("readerPersonas.saveFailed"), description: String(err), variant: "destructive" }); }
    finally { setBusy(false); }
  }

  async function toggle(profile: ReaderPersonaProfile) {
    const next = { ...profile, enabled: !profile.enabled };
    setProfiles((current) => current.map((entry) => entry.id === profile.id ? next : entry));
    if (draft?.id === profile.id) setDraft(next);
    await persist(next);
  }

  async function reset(profile: ReaderPersonaProfile) {
    if (!book || !token || !profile.builtin) return;
    setBusy(true);
    try {
      await deleteReaderPersonaOverride({ token, book, branch, profile });
      await reload();
      await load();
    } finally { setBusy(false); }
  }

  function duplicate(profile: ReaderPersonaProfile) {
    const next = { ...profile, id: `reader:custom:${crypto.randomUUID()}`, slug: `${profile.slug}-copy-${Date.now().toString(36)}`, name: `${profile.name} Copy`, builtin: false, readerType: "custom" as const, order: 1000 + profiles.length, path: undefined };
    setProfiles((current) => [...current, next]);
    select(next);
  }

  async function remove(profile: ReaderPersonaProfile) {
    if (!book || !token || profile.builtin || !window.confirm(t("readerPersonas.deleteConfirm"))) return;
    await deleteReaderPersonaOverride({ token, book, branch, profile });
    await reload();
    await load();
  }

  async function move(profile: ReaderPersonaProfile, direction: -1 | 1) {
    const sorted = [...profiles];
    const index = sorted.findIndex((entry) => entry.id === profile.id);
    const otherIndex = index + direction;
    if (index < 0 || otherIndex < 0 || otherIndex >= sorted.length) return;
    const other = sorted[otherIndex];
    const next = { ...profile, order: other.order };
    const nextOther = { ...other, order: profile.order };
    setProfiles(sorted.map((entry) => entry.id === next.id ? next : entry.id === nextOther.id ? nextOther : entry).sort((a, b) => a.order - b.order));
    await Promise.all([persist(next), persist(nextOther)]);
  }

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm sm:p-8">
        <Badge variant="secondary"><Users className="mr-1.5 h-3.5 w-3.5" />{t("readerPersonas.badge")}</Badge>
        <h1 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">{t("readerPersonas.title")}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{t("readerPersonas.description")}</p>
      </div>
      <div className="flex flex-wrap gap-2">{(["all", "standard", "genre", "custom"] as const).map((value) => <Button key={value} size="sm" variant={filter === value ? "default" : "outline"} onClick={() => setFilter(value)}>{t(`readerPersonas.filters.${value}`)}</Button>)}</div>
      {orphanPaths.length > 0 && <Alert variant="destructive"><AlertDescription>{t("readerPersonas.orphans", { count: orphanPaths.length })}</AlertDescription></Alert>}
      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Button variant="outline" className="w-full justify-start" onClick={() => { const next = emptyReaderPersona(structure?.language, 1000 + profiles.length); setProfiles((current) => [...current, next]); select(next); }}><Plus className="mr-2 h-4 w-4" />{t("readerPersonas.new")}</Button>
          {loading ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div> : visible.map((profile) => (
            <div key={profile.id} className={selectedId === profile.id ? "rounded-xl border border-primary bg-primary/5 p-3" : "rounded-xl border p-3"}>
              <button className="w-full text-left" onClick={() => select(profile)}><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{profile.name}</span><Badge variant="outline">{t(`readerPersonas.types.${profile.readerType}`)}</Badge></div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{profile.description}</p></button>
              <div className="mt-3 flex items-center gap-1"><Switch checked={profile.enabled} onCheckedChange={() => void toggle(profile)} /><span className="mr-auto text-xs text-muted-foreground">{profile.enabled ? t("common.enabled") : t("common.disabled")}</span><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void move(profile, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void move(profile, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button></div>
            </div>
          ))}
        </div>
        {draft ? <ReaderPersonaEditor profile={draft} onChange={setDraft} onSave={() => void persist(draft)} onDuplicate={() => duplicate(draft)} onReset={() => void reset(draft)} onDelete={() => void remove(draft)} busy={busy} /> : <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">{t("readerPersonas.select")}</div>}
      </div>
    </div>
  );
}

function csv(value: string): string[] { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }

function ReaderPersonaEditor({ profile, onChange, onSave, onDuplicate, onReset, onDelete, busy }: { profile: ReaderPersonaProfile; onChange: (profile: ReaderPersonaProfile) => void; onSave: () => void; onDuplicate: () => void; onReset: () => void; onDelete: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const patch = (next: Partial<ReaderPersonaProfile>) => onChange({ ...profile, ...next });
  return <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-xl font-semibold">{profile.name || t("readerPersonas.untitled")}</h2><p className="font-mono text-xs text-muted-foreground">{profile.id}</p></div><div className="flex gap-1"><Button size="sm" variant="outline" onClick={onDuplicate}><Copy className="mr-1 h-4 w-4" />{t("readerPersonas.duplicate")}</Button>{profile.builtin ? <Button size="sm" variant="outline" onClick={onReset}><RotateCcw className="mr-1 h-4 w-4" />{t("readerPersonas.reset")}</Button> : <Button size="icon" variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4 text-destructive" /></Button>}</div></div>
    <Field label={t("readerPersonas.name")} value={profile.name} onChange={(value) => patch({ name: value, slug: profile.path ? profile.slug : slugify(value) })} />
    <Field label={t("readerPersonas.descriptionLabel")} value={profile.description} onChange={(value) => patch({ description: value })} multiline />
    <Field label={t("readerPersonas.profile")} value={profile.profile} onChange={(value) => patch({ profile: value })} multiline />
    <div className="grid gap-3 sm:grid-cols-3"><Field label={t("readerPersonas.language")} value={profile.language} onChange={(value) => patch({ language: value })} /><Field label={t("readerPersonas.experience")} value={profile.experienceLevel} onChange={(value) => patch({ experienceLevel: value })} /><Field label={t("readerPersonas.audienceAge")} value={profile.audienceAge} onChange={(value) => patch({ audienceAge: value })} /></div>
    <div><Label>{t("readerPersonas.severity")} ({profile.severity}/10)</Label><input type="range" min="1" max="10" value={profile.severity} onChange={(event) => patch({ severity: Number(event.target.value) })} className="mt-2 w-full" /></div>
    <ListField label={t("readerPersonas.aspects")} value={profile.aspects} onChange={(value) => patch({ aspects: value })} /><ListField label={t("readerPersonas.preferredGenres")} value={profile.preferredGenres} onChange={(value) => patch({ preferredGenres: value })} /><ListField label={t("readerPersonas.dislikedGenres")} value={profile.dislikedGenres} onChange={(value) => patch({ dislikedGenres: value })} /><ListField label={t("readerPersonas.interests")} value={profile.interests} onChange={(value) => patch({ interests: value })} /><ListField label={t("readerPersonas.appreciated")} value={profile.appreciatedElements} onChange={(value) => patch({ appreciatedElements: value })} /><ListField label={t("readerPersonas.criticisms")} value={profile.frequentCriticisms} onChange={(value) => patch({ frequentCriticisms: value })} />
    <Field label={t("readerPersonas.customPrompt")} value={profile.customPrompt} onChange={(value) => patch({ customPrompt: value })} multiline /><Field label={t("readerPersonas.notes")} value={profile.body} onChange={(value) => patch({ body: value })} multiline />
    <Button onClick={onSave} disabled={busy || !profile.name.trim()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t("common.save")}</Button>
  </div>;
}

function Field({ label, value, onChange, multiline }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean }) { return <div className="grid gap-2"><Label>{label}</Label>{multiline ? <AutoTextarea value={value} onChange={(event) => onChange(event.target.value)} className="min-h-20" /> : <Input value={value} onChange={(event) => onChange(event.target.value)} />}</div>; }
function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) { return <Field label={label} value={value.join(", ")} onChange={(value) => onChange(csv(value))} />; }
