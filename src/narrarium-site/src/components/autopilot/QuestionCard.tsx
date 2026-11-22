import "@/i18n/frozen";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Clapperboard, Lock, Play } from "lucide-react";
import type { DirectorQuestion, QuestionAnswer, QuestionChoice } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { questionHeading } from "@/autopilot/format";
import type { useAutopilotActions } from "@/autopilot/useAutopilotActions";

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

/** The questions about a change the author made: a frozen chapter's text, or the outline entry of a chapter already written. */
function isChangeQuestion(question: DirectorQuestion): boolean {
  return question.kind === "frozen-change" || question.kind === "outline-change";
}

/** A choice in the language of the app when the app knows it (the engine labels it in the language of the book), else as the engine says it. */
function choiceLabel(choice: QuestionChoice): string {
  const key = `frozen.actions.${choice.id}`;
  return i18next.exists(key) ? i18next.t(key) : choice.label;
}

/**
 * The question the autopilot waits on, on the Live page. A question of the director has its options and the button that accepts the work as it is;
 * a question about a change has its choices as buttons, each with what it does, and the answer is the id of the one chosen; the author's own words
 * instead start a review that calls the AI, and the field says so. Once answered, the autopilot goes on.
 */
export function QuestionCard({ bookId, question, disabled, run }: { bookId: string; question: DirectorQuestion; disabled: boolean; run: RunAction }) {
  const { t } = useTranslation();
  const id = useId();
  const [answer, setAnswer] = useState("");
  const change = isChangeQuestion(question);
  const choices = change ? question.choices ?? [] : [];
  const send = (input: Omit<QuestionAnswer, "questionId">) => void run("answer", async (runtime, book) => {
    await runtime.answer(book, { questionId: question.id, ...input });
    await runtime.start(book);
  });
  const about = question.frozen;
  const freeTextId = `${id}-free-text`;
  return (
    <section id="autopilot-question" tabIndex={-1} aria-labelledby="autopilot-question-title" className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5" aria-live="polite">
      <h2 id="autopilot-question-title" className="flex items-center gap-2 text-base font-semibold">
        {change ? <Lock className="h-4 w-4 text-amber-700 dark:text-amber-600" aria-hidden="true" /> : <Clapperboard className="h-4 w-4 text-amber-700 dark:text-amber-600" aria-hidden="true" />}
        {questionHeading(t, question)}
      </h2>
      <p className="whitespace-pre-wrap text-sm font-medium">{question.question}</p>
      {question.context && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{question.context}</p>}
      {about && (
        <p className="text-sm">
          {about.kind === "outline" ? (
            <Link className="font-medium underline underline-offset-4" to={`/app/books/${encodeURIComponent(bookId)}/outline`}>{t("autopilot.question.openOutline")}</Link>
          ) : (
            <Link className="font-medium underline underline-offset-4" to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(about.slug)}`}>{t("autopilot.question.openChapter", { number: about.number })}</Link>
          )}
        </p>
      )}
      {change && choices.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-3">
          {choices.map((choice) => (
            <li key={choice.id} className="space-y-1">
              <Button size="sm" variant={choice.id === "mark-reviewed" ? "outline" : "default"} className="h-auto min-h-9 w-full justify-start whitespace-normal py-1.5 text-left" disabled={disabled} aria-describedby={i18next.exists(`frozen.actionHelp.${choice.id}`) ? `${id}-${choice.id}` : undefined} onClick={() => send({ answer: choice.id, choice: choice.id, accept: false })}>
                {choiceLabel(choice)}
              </Button>
              {i18next.exists(`frozen.actionHelp.${choice.id}`) && <p id={`${id}-${choice.id}`} className="text-xs text-muted-foreground">{t(`frozen.actionHelp.${choice.id}`)}</p>}
            </li>
          ))}
        </ul>
      ) : question.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => <Button key={option} size="sm" variant="outline" disabled={disabled} onClick={() => send({ answer: option, accept: false })}>{option}</Button>)}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`answer-${bookId}`}>{t("autopilot.question.answer")}</Label>
        <AutoTextarea id={`answer-${bookId}`} value={answer} onChange={(event) => setAnswer(event.target.value)} minRows={2} className="text-sm" disabled={disabled} aria-describedby={change ? freeTextId : undefined} />
        {change && <p id={freeTextId} className="text-xs text-muted-foreground">{t(question.kind === "outline-change" ? "autopilot.question.freeTextOutline" : "autopilot.question.freeTextFrozen")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !answer.trim()} onClick={() => send({ answer: answer.trim(), accept: false })}><Play className="h-4 w-4" />{t("autopilot.question.send")}</Button>
        {!change && <Button variant="outline" disabled={disabled} onClick={() => send({ answer: "", accept: true })}>{t("autopilot.question.accept")}</Button>}
      </div>
    </section>
  );
}
