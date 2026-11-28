import { useId } from "react";
import { useTranslation } from "react-i18next";
import { parseMarkdown, renderMarkdown } from "narrarium-engine";
import "@/i18n/bibleStudio";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Label } from "@/components/ui/label";
import { SaveRow, useBibleSave, useFollowingForm } from "@/components/outline/bible/bibleParts";
import type { BibleData, BibleGuideline } from "@/outline/bibleModel";
import type { OutlineFile } from "@/outline/outlineModel";
import type { OutlineSource } from "@/outline/outlineSource";

/** The guidelines of the book (`guidelines/`), each edited in place: the text under its frontmatter, which is kept as it is. */
export function GuidelinesSection({ data, files, source, onSaved }: { data: BibleData; files: ReadonlyMap<string, OutlineFile>; source: OutlineSource | null; onSaved: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.guidelines.intro")}</p>
      {data.guidelines.length === 0
        ? <p className="text-sm text-muted-foreground">{t("bibleStudio.guidelines.empty")}</p>
        : <ul data-bible-guidelines className="space-y-2">{data.guidelines.map((guideline) => <li key={guideline.path}><GuidelineEditor guideline={guideline} file={files.get(guideline.path)} source={source} onSaved={onSaved} /></li>)}</ul>}
    </div>
  );
}

function GuidelineEditor({ guideline, file, source, onSaved }: { guideline: BibleGuideline; file: OutlineFile | undefined; source: OutlineSource | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const initial = file ? parseMarkdown(file.content).body : "";
  const [text, setText] = useFollowingForm(initial);
  const { busy, message, save } = useBibleSave(source, onSaved);
  const submit = () => {
    if (!file) return;
    const document = parseMarkdown(file.content);
    void save(guideline.path, renderMarkdown(document.frontmatter, text.trim()), file.hash, guideline.slug);
  };
  return (
    <details data-guideline={guideline.slug} className="rounded-xl border p-3">
      <summary className="cursor-pointer text-sm font-medium">{guideline.title}</summary>
      <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="space-y-1">
          <Label htmlFor={`${id}-text`} className="text-xs font-medium">{t("bibleStudio.guidelines.text", { title: guideline.title })}</Label>
          <AutoTextarea id={`${id}-text`} value={text} minRows={4} maxHeight={420} disabled={busy || !file} onChange={(event) => setText(event.target.value)} className="text-sm" />
        </div>
        <SaveRow busy={busy} disabled={text === initial || !file} label={t("bibleStudio.guidelines.save", { title: guideline.title })} message={message} />
      </form>
    </details>
  );
}
