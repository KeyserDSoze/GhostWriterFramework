import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { BIBLE_THREADS_FILE, nextThreadId, serializeBibleThreads, type BibleThread, type ThreadStatus } from "narrarium-engine";
import "@/i18n/bibleStudio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveRow, useBibleSave, useFollowingForm } from "@/components/outline/bible/bibleParts";
import type { BibleData } from "@/outline/bibleModel";
import type { OutlineSource } from "@/outline/outlineSource";

interface Row {
  id: string;
  title: string;
  setup: string;
  payoff: string;
  status: ThreadStatus;
}

const rowsOf = (threads: readonly BibleThread[]): Row[] => threads.map((thread) => ({ id: thread.id, title: thread.title, setup: thread.setup ? String(thread.setup.chapter) : "", payoff: thread.payoff ? String(thread.payoff.chapter) : "", status: thread.status }));

const chapterOf = (text: string): number | undefined => {
  const value = Number(text.trim());
  return text.trim() && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/** The threads of setup and payoff (`bible/threads.md`), edited in place: what the story plants, and where it is paid. The notes of each point stay as they were. */
export function ThreadsSection({ data, source, onSaved }: { data: BibleData; source: OutlineSource | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const initial = rowsOf(data.threads.threads);
  const [rows, setRows] = useFollowingForm(initial);
  const { busy, message, save } = useBibleSave(source, onSaved);
  const changed = JSON.stringify(rows) !== JSON.stringify(initial);
  const update = (index: number, patch: Partial<Row>) => setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const submit = () => {
    const known = new Map(data.threads.threads.map((thread) => [thread.id, thread]));
    const threads: BibleThread[] = [];
    // A new thread takes the id after the highest of the ones the rows have, and after the ones given to new rows before it.
    const taken: BibleThread[] = rows.filter((row) => row.id).map((row) => ({ id: row.id, title: row.title, status: row.status }));
    for (const row of rows) {
      const title = row.title.trim();
      if (!title) continue;
      const before = known.get(row.id);
      const setup = chapterOf(row.setup);
      const payoff = chapterOf(row.payoff);
      const id = row.id || nextThreadId(taken);
      if (!row.id) taken.push({ id, title, status: row.status });
      threads.push({
        id,
        title,
        status: row.status,
        ...(setup ? { setup: { chapter: setup, note: before?.setup?.note ?? "" } } : {}),
        ...(payoff ? { payoff: { chapter: payoff, note: before?.payoff?.note ?? "" } } : {}),
      });
    }
    void save(BIBLE_THREADS_FILE, serializeBibleThreads({ threads, notes: data.threads.notes }, data.threadsFile?.content), data.threadsFile?.hash ?? null, "threads");
  };

  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.threads.intro")}</p>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t("bibleStudio.threads.empty")}</p>}
      <ul data-bible-threads className="space-y-2">
        {rows.map((row, index) => (
          <li key={row.id || `new-${index}`} data-thread={row.id || "new"} className="grid gap-2 rounded-xl border p-3 md:grid-cols-[minmax(0,2fr)_7rem_7rem_8rem_auto] md:items-end">
            <div className="space-y-1">
              <Label htmlFor={`${id}-${index}-title`} className="text-xs font-medium">{t("bibleStudio.threads.title")}{row.id ? ` (${row.id})` : ""}</Label>
              <Input id={`${id}-${index}-title`} value={row.title} disabled={busy} onChange={(event) => update(index, { title: event.target.value })} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${index}-setup`} className="text-xs font-medium">{t("bibleStudio.threads.setup")}</Label>
              <Input id={`${id}-${index}-setup`} inputMode="numeric" value={row.setup} disabled={busy} onChange={(event) => update(index, { setup: event.target.value })} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${index}-payoff`} className="text-xs font-medium">{t("bibleStudio.threads.payoff")}</Label>
              <Input id={`${id}-${index}-payoff`} inputMode="numeric" value={row.payoff} disabled={busy} onChange={(event) => update(index, { payoff: event.target.value })} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${index}-status`} className="text-xs font-medium">{t("bibleStudio.threads.status")}</Label>
              <select id={`${id}-${index}-status`} value={row.status} disabled={busy} onChange={(event) => update(index, { status: event.target.value as ThreadStatus })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {(["open", "paid", "dropped"] as const).map((state) => <option key={state} value={state}>{t(`bibleStudio.threads.state.${state}`)}</option>)}
              </select>
            </div>
            <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={t("bibleStudio.threads.removeFor", { title: row.title || row.id })} onClick={() => setRows(rows.filter((_, at) => at !== index))}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />{t("bibleStudio.threads.remove")}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRows([...rows, { id: "", title: "", setup: "", payoff: "", status: "open" }])}><Plus className="h-4 w-4" aria-hidden="true" />{t("bibleStudio.threads.add")}</Button>
        <SaveRow busy={busy} disabled={!changed} label={t("bibleStudio.threads.save")} message={message} />
      </div>
    </form>
  );
}
