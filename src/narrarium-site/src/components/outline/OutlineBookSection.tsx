import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import type { OutlineBriefFields } from "narrarium-engine";
import { WORDS_PER_SCENE } from "@/autopilot/outlineBrief";
import { NumberField } from "@/components/autopilot/config/NumberField";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface OutlineBookSectionProps {
  workingTitle: string;
  idea: string;
  brief: OutlineBriefFields;
  dirty: boolean;
  busy: boolean;
  ideaRef: RefObject<HTMLTextAreaElement>;
  onTitle: (title: string) => void;
  onIdea: (idea: string) => void;
  onBrief: (patch: Partial<OutlineBriefFields>) => void;
  onSave: () => void;
}

/**
 * The book, at the top of the Scaletta, in one card: its working title, its idea (the description of the book, which is the idea, promise or pitch of
 * it), and the brief the autopilot writes from (genre, audience, words per scene, synopsis). One «Save» (and Ctrl+S) saves all of it.
 */
export function OutlineBookSection({ workingTitle, idea, brief, dirty, busy, ideaRef, onTitle, onIdea, onBrief, onSave }: OutlineBookSectionProps) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="outline-book-title" className="space-y-4 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="outline-book-title" className="text-lg font-semibold">{t("outline.book.title")}</h2>
        {dirty && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{t("outline.book.unsaved")}</span>
            <Button size="sm" onClick={onSave} disabled={busy}><Save className="h-4 w-4" aria-hidden="true" />{t("outline.book.save")}</Button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="outline-working-title">{t("outline.book.workingTitle")}</Label>
        <Input id="outline-working-title" value={workingTitle} onChange={(event) => onTitle(event.target.value)} aria-describedby="outline-working-title-hint" className="h-9" />
        <p id="outline-working-title-hint" className="text-xs text-muted-foreground">{t("outline.book.workingTitleHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="outline-idea">{t("outline.book.idea")}</Label>
        <AutoTextarea ref={ideaRef} id="outline-idea" value={idea} onChange={(event) => onIdea(event.target.value)} minRows={3} maxHeight={640} placeholder={t("outline.book.ideaPlaceholder")} aria-describedby="outline-idea-help" className="text-sm leading-6" />
        <p id="outline-idea-help" className="text-xs text-muted-foreground">{t("outline.book.ideaHelp")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor="outline-brief-genre" className="text-xs">{t("outline.brief.genre")}</Label><Input id="outline-brief-genre" className="h-9" value={brief.genre} onChange={(event) => onBrief({ genre: event.target.value })} /></div>
        <div className="space-y-1"><Label htmlFor="outline-brief-audience" className="text-xs">{t("outline.brief.audience")}</Label><Input id="outline-brief-audience" className="h-9" value={brief.audience} onChange={(event) => onBrief({ audience: event.target.value })} /></div>
        <div className="space-y-1">
          <NumberField id="outline-brief-words" label={t("outline.brief.words")} value={brief.wordsPerScene} min={WORDS_PER_SCENE.min} max={WORDS_PER_SCENE.max} step={WORDS_PER_SCENE.step} describedBy="outline-brief-words-hint" fill={false} onChange={(value) => onBrief({ wordsPerScene: value })} />
          <p id="outline-brief-words-hint" className="text-xs text-muted-foreground">{t("outline.brief.wordsHint")}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="outline-brief-synopsis">{t("outline.brief.synopsis")}</Label>
        <AutoTextarea id="outline-brief-synopsis" value={brief.synopsis} onChange={(event) => onBrief({ synopsis: event.target.value })} minRows={3} maxHeight={640} placeholder={t("outline.brief.synopsisPlaceholder")} className="text-sm leading-6" aria-describedby="outline-brief-synopsis-hint" />
        <p id="outline-brief-synopsis-hint" className="text-xs text-muted-foreground">{t("outline.brief.synopsisHint")}</p>
      </div>
      <p className="text-xs text-muted-foreground">{t("outline.brief.appliesNext")}</p>
      <p className="text-xs text-muted-foreground">{t("outline.savingHint")}</p>
    </section>
  );
}
