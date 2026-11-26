import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, BookMarked, Info, Loader2, Save } from "lucide-react";
import { BIBLE_THEMES_FILE, BIBLE_WORLD_FILE, BookConflictError, designFindingText, serializeBibleThemes, serializeBibleWorld, type AutopilotState, type DesignFinding, type OutlineChapterEntry } from "narrarium-engine";
import "@/i18n/design";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBibleFiles } from "@/components/outline/bible/useBibleFiles";
import { canonHref, composeBible, type BibleCanonEntry, type BibleData, type BibleSecret, type BibleSection } from "@/outline/bibleModel";
import type { OutlineSource } from "@/outline/outlineSource";
import { cn } from "@/lib/utils";

export interface BibleTabProps {
  bookId: string;
  source: OutlineSource | null;
  entries: readonly OutlineChapterEntry[];
  state: AutopilotState | null;
  refreshKey: string;
  /** Show an entry of the Synopsis (its tab, the entry in view), or the Synopsis itself. */
  onShowEntry: (number: number) => void;
  onShowSynopsis: () => void;
}

const SECTION_IDS = { premise: "bible-premise", themes: "bible-themes", world: "bible-world", cast: "bible-cast", places: "bible-places", factions: "bible-factions", items: "bible-items", secrets: "bible-secrets", checks: "bible-checks" } as const;

/**
 * The Bible: the parts of the book that make its story, composed from its own files and read again when the autopilot or a sync changes them. The themes, the
 * tone and the rules of the world are edited here (`bible/`); every entry of the canon opens its page; the findings of the checks of the design point to their
 * chapter.
 */
export function BibleTab({ bookId, source, entries, state, refreshKey, onShowEntry, onShowSynopsis }: BibleTabProps) {
  const { t, i18n } = useTranslation();
  const { files, failure, reload } = useBibleFiles(source, refreshKey);
  const data = useMemo(() => (files ? composeBible({ files, entries, state }) : null), [files, entries, state]);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const names = useMemo(() => new Map((data?.canon.characters ?? []).flatMap((entry) => [[`character:${entry.slug}`, entry.name], [entry.slug, entry.name]] as const)), [data]);
  const nameOf = (value: string) => names.get(value) ?? value.replace(/^character:/, "");

  if (failure === "folder") return <Alert><AlertDescription>{t("design.bible.noFolder")}</AlertDescription></Alert>;
  if (failure === "read" && !data) return <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-3">{t("design.bible.failed")}<Button size="sm" variant="outline" onClick={reload}>{t("common.retry")}</Button></AlertDescription></Alert>;
  if (!data) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("design.bible.loading")}</p>;

  const byChapter = (finding: DesignFinding) => finding.chapter;
  const secretFindings = (slug: string) => data.findings.filter((finding) => finding.secret?.slug === slug);

  return (
    <div data-bible className="flex flex-col gap-5">
      <header className="space-y-2">
        <h2 className="flex items-center gap-2 text-xl font-semibold"><BookMarked className="h-5 w-5 text-primary" aria-hidden="true" />{t("design.bible.title")}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("design.bible.intro")}</p>
        <nav aria-label={t("design.bible.nav")}>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {(Object.keys(SECTION_IDS) as Array<keyof typeof SECTION_IDS>).map((key) => (
              <li key={key}><a href={`#${SECTION_IDS[key]}`} className="inline-flex min-h-6 items-center underline underline-offset-4 [@media(pointer:coarse)]:min-h-11">{t(`design.bible.sections.${key}`)}</a></li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id={SECTION_IDS.premise} title={t("design.bible.sections.premise")}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextBlock title={t("design.bible.premise.storyDesign")} text={data.storyDesign} />
          <TextBlock title={t("design.bible.premise.context")} text={data.context} />
        </div>
        <p className="text-xs text-muted-foreground">{t("design.bible.premise.description")} <button type="button" className="inline-flex min-h-6 items-center underline underline-offset-4" onClick={onShowSynopsis}>{t("design.bible.premise.editDescription")}</button></p>
      </Section>

      <Section id={SECTION_IDS.themes} title={t("design.bible.sections.themes")}>
        <ThemesEditor data={data} source={source} onSaved={reload} />
      </Section>

      <Section id={SECTION_IDS.world} title={t("design.bible.sections.world")}>
        <WorldEditor data={data} source={source} onSaved={reload} />
      </Section>

      {(["cast", "places", "factions", "items"] as const).map((key) => {
        const section: BibleSection = key === "cast" ? "characters" : key === "places" ? "locations" : key;
        return (
          <Section key={key} id={SECTION_IDS[key]} title={t(`design.bible.sections.${key}`)}>
            <CanonList bookId={bookId} entries={data.canon[section]} empty={t(`design.bible.empty.${key}`)} />
          </Section>
        );
      })}

      <Section id={SECTION_IDS.secrets} title={t("design.bible.sections.secrets")}>
        {data.secrets.length === 0
          ? <p className="text-sm text-muted-foreground">{t("design.bible.empty.secrets")}</p>
          : <ul className="space-y-3">{data.secrets.map((secret) => <li key={secret.path}><SecretCard bookId={bookId} secret={secret} nameOf={nameOf} findings={secretFindings(secret.slug)} language={language} /></li>)}</ul>}
      </Section>

      <Section id={SECTION_IDS.checks} title={t("design.bible.sections.checks")}>
        <p className="text-xs text-muted-foreground">{t("design.bible.checks.intro")}</p>
        {data.findings.length === 0
          ? <p data-bible-checks="none" className="text-sm">{t("design.bible.checks.none")}</p>
          : (
            <ul data-bible-checks className="space-y-1.5 text-sm">
              {data.findings.map((finding, index) => (
                <li key={`${finding.code}-${index}`} data-design-finding={finding.code} className="flex items-start gap-2">
                  <FindingIcon finding={finding} />
                  <span className="min-w-0">
                    {designFindingText(finding, language)}
                    {byChapter(finding) && entries.some((entry) => entry.number === finding.chapter) && (
                      <> <button type="button" className="inline-flex min-h-6 items-center text-xs underline underline-offset-4" onClick={() => onShowEntry(finding.chapter!)}>{t("design.bible.checks.show", { number: finding.chapter })}</button></>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <h3 id={`${id}-title`} className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A text of the book as lines to read: its title (its first `#` heading, before or after the logline the concept puts first) and the marks of the headings and of the quotes are left out. */
function plainText(text: string): string {
  const lines = text.trim().split("\n");
  const title = lines.findIndex((line) => /^#\s/.test(line));
  return lines.filter((_, index) => index !== title).map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function TextBlock({ title, text }: { title: string; text: string }) {
  const { t } = useTranslation();
  const plain = plainText(text);
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      {plain ? <p className="line-clamp-[12] whitespace-pre-line text-sm text-muted-foreground">{plain}</p> : <p className="text-sm italic text-muted-foreground">{t("design.bible.premise.none")}</p>}
    </div>
  );
}

function FindingIcon({ finding }: { finding: DesignFinding }) {
  return finding.severity === "warning"
    ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
    : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function CanonList({ bookId, entries, empty }: { bookId: string; entries: readonly BibleCanonEntry[]; empty: string }) {
  const { t } = useTranslation();
  if (!entries.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {entries.map((entry) => (
        <li key={entry.path} data-bible-entry={entry.path} className="space-y-1.5 rounded-xl border p-3">
          <Link to={canonHref(bookId, entry.path)} aria-label={t("design.bible.open", { name: entry.name })} className="inline-flex min-h-6 items-center font-medium underline-offset-4 hover:underline">{entry.name}</Link>
          {entry.summary && <p className="text-sm text-muted-foreground">{entry.summary}</p>}
          {entry.facts.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
              {entry.facts.map((fact) => (
                <div key={fact.key} className="contents">
                  <dt className="font-medium text-foreground">{t(`design.bible.fields.${fact.key}`)}</dt>
                  <dd className="text-muted-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

function SecretCard({ bookId, secret, nameOf, findings, language }: { bookId: string; secret: BibleSecret; nameOf: (value: string) => string; findings: DesignFinding[]; language: string }) {
  const { t } = useTranslation();
  const notes = (title: string, items: ReadonlyArray<{ chapter: number; note: string }>) => items.length > 0 && (
    <div>
      <dt className="font-medium text-foreground">{title}</dt>
      <dd><ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">{items.map((item, index) => <li key={index}><span className="font-medium">{t("design.bible.secret.chapter", { number: item.chapter })}</span>: {item.note}</li>)}</ul></dd>
    </div>
  );
  return (
    <article data-bible-secret={secret.slug} aria-labelledby={`secret-${secret.slug}`} className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={`secret-${secret.slug}`} className="font-medium"><Link to={canonHref(bookId, secret.path)} className="underline-offset-4 hover:underline">{secret.title}</Link></h4>
        <span data-secret-reveal className={cn("text-xs font-medium", secret.revealChapter ? "text-foreground" : "text-amber-800 dark:text-amber-300")}>
          {secret.revealChapter ? t(secret.planned ? "design.bible.secret.planned" : "design.bible.secret.reveal", { number: secret.revealChapter }) : t("design.bible.secret.unplaced")}
        </span>
      </div>
      <dl className="space-y-1.5 text-sm">
        {secret.truth && <div><dt className="font-medium text-foreground">{t("design.bible.secret.truth")}</dt><dd className="text-muted-foreground">{secret.truth}</dd></div>}
        {secret.holders.length > 0 && <div><dt className="font-medium text-foreground">{t("design.bible.secret.holders")}</dt><dd className="text-muted-foreground">{secret.holders.map(nameOf).join(", ")}</dd></div>}
        {secret.ledger.learnedBy.length > 0 && <div><dt className="font-medium text-foreground">{t("design.bible.secret.learnedBy")}</dt><dd className="text-muted-foreground">{secret.ledger.learnedBy.map((item) => t("design.bible.secret.learned", { name: nameOf(item.character), number: item.chapter })).join("; ")}</dd></div>}
        {notes(t("design.bible.secret.readerKnows"), secret.ledger.readerKnows)}
        {notes(t("design.bible.secret.clues"), secret.ledger.clues)}
        {notes(t("design.bible.secret.redHerrings"), secret.ledger.redHerrings)}
        {secret.ledger.consequences.length > 0 && <div><dt className="font-medium text-foreground">{t("design.bible.secret.consequences")}</dt><dd><ul className="list-disc pl-5 text-muted-foreground">{secret.ledger.consequences.map((line, index) => <li key={index}>{line}</li>)}</ul></dd></div>}
        {secret.knownFrom && secret.knownFrom !== secret.revealChapter && <div><dd className="text-xs text-muted-foreground">{t("design.bible.secret.knownFrom", { number: secret.knownFrom })}</dd></div>}
      </dl>
      {findings.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-xs font-semibold">{t("design.bible.secret.findings")}</p>
          <ul className="space-y-1 text-xs">{findings.map((finding, index) => <li key={index} className="flex items-start gap-1.5"><FindingIcon finding={finding} />{designFindingText(finding, language)}</li>)}</ul>
        </div>
      )}
    </article>
  );
}

/** Save a file of `bible/`, expecting it as it was read: what changed elsewhere is never overwritten. */
function useBibleSave(source: OutlineSource | null, onSaved: () => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const save = async (path: string, content: string, expectedHash: string | null, label: string) => {
    if (!source) return;
    setBusy(true);
    setMessage(null);
    try {
      await source.commit([{ path, content, expectedHash }], `Bible: ${label}`);
      setMessage({ tone: "ok", text: t("design.bible.saved") });
      onSaved();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof BookConflictError ? t("design.bible.conflict") : t("design.bible.saveFailed") });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, save };
}

const linesOf = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** A form that follows what the file says while the author has not changed it (the autopilot, a sync, another tab may change the file). */
function useFollowingForm<T>(initial: T): [T, (next: T) => void] {
  const key = JSON.stringify(initial);
  const [state, setState] = useState<{ key: string; value: T; edited: boolean }>({ key, value: initial, edited: false });
  if (state.key !== key && (!state.edited || JSON.stringify(state.value) === key)) setState({ key, value: initial, edited: false });
  return [state.value, (next) => setState({ key, value: next, edited: true })];
}

function ThemesEditor({ data, source, onSaved }: { data: BibleData; source: OutlineSource | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const initial = { themes: data.themes.themes.join("\n"), tone: data.themes.tone };
  const [form, setForm] = useFollowingForm(initial);
  const { busy, message, save } = useBibleSave(source, onSaved);
  const changed = form.themes !== initial.themes || form.tone !== initial.tone;
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(BIBLE_THEMES_FILE, serializeBibleThemes({ themes: linesOf(form.themes), tone: form.tone }, data.themesFile?.content), data.themesFile?.hash ?? null, "themes and tone"); }}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-themes`} className="text-xs font-medium">{t("design.bible.themes.themes")}</Label>
          <AutoTextarea id={`${id}-themes`} aria-describedby={`${id}-themes-hint`} value={form.themes} minRows={3} maxHeight={260} disabled={busy} onChange={(event) => setForm({ ...form, themes: event.target.value })} className="text-sm" />
          <p id={`${id}-themes-hint`} className="text-xs text-muted-foreground">{t("design.bible.themes.themesHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-tone`} className="text-xs font-medium">{t("design.bible.themes.tone")}</Label>
          <Input id={`${id}-tone`} value={form.tone} disabled={busy} onChange={(event) => setForm({ ...form, tone: event.target.value })} className="h-9" />
        </div>
      </div>
      <SaveRow busy={busy} disabled={!changed} label={t("design.bible.themes.save")} message={message} />
    </form>
  );
}

function WorldEditor({ data, source, onSaved }: { data: BibleData; source: OutlineSource | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const initial = data.world.rules.join("\n");
  const [rules, setRules] = useFollowingForm(initial);
  const { busy, message, save } = useBibleSave(source, onSaved);
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(BIBLE_WORLD_FILE, serializeBibleWorld({ rules: linesOf(rules) }, data.worldFile?.content), data.worldFile?.hash ?? null, "rules of the world"); }}>
      <div className="space-y-1">
        <Label htmlFor={`${id}-rules`} className="text-xs font-medium">{t("design.bible.world.rules")}</Label>
        <AutoTextarea id={`${id}-rules`} aria-describedby={`${id}-rules-hint`} value={rules} minRows={3} maxHeight={320} disabled={busy} onChange={(event) => setRules(event.target.value)} className="text-sm" />
        <p id={`${id}-rules-hint`} className="text-xs text-muted-foreground">{t("design.bible.world.rulesHint")}</p>
      </div>
      <SaveRow busy={busy} disabled={rules === initial} label={t("design.bible.world.save")} message={message} />
    </form>
  );
}

function SaveRow({ busy, disabled, label, message }: { busy: boolean; disabled: boolean; label: string; message: { tone: "ok" | "error"; text: string } | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={busy || disabled}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{label}</Button>
      <p role="status" className={cn("text-xs", message?.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground")}>{message?.text ?? ""}</p>
    </div>
  );
}
