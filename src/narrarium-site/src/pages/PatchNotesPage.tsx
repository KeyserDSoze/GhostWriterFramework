import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { patchNotes, localizedPatchNote } from "@/content/patchNotes";

export function PatchNotesPage() {
  const { t, i18n } = useTranslation();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-sm sm:p-8">
        <Badge variant="secondary">{t("patchNotes.badge")}</Badge>
        <h1 className="mt-4 font-serif text-3xl font-semibold sm:text-4xl">{t("patchNotes.title")}</h1>
        <p className="mt-3 text-muted-foreground">{t("patchNotes.description")}</p>
      </div>
      {patchNotes.map((note) => {
        const localized = localizedPatchNote(note, i18n.language);
        return <article key={note.version} className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{localized.title}</h2><p className="mt-1 text-sm text-muted-foreground">{localized.summary}</p></div><div className="text-right"><Badge>v{note.version}</Badge><p className="mt-1 text-xs text-muted-foreground">{new Date(note.date).toLocaleDateString()}</p></div></div><ul className="mt-5 space-y-2 text-sm leading-6">{localized.changes.map((change) => <li key={change} className="flex gap-3"><span className="text-primary">•</span><span>{change}</span></li>)}</ul></article>;
      })}
    </div>
  );
}
