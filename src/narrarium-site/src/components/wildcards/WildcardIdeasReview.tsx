import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import type { WildcardIdea, WildcardTarget, WildcardVoiceResult } from "narrarium-engine";
import "@/i18n/wildcards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WildcardChoice } from "@/wildcards/applyIdeas";

/**
 * The table of the ideas of the room: every idea (or finding) with who gave it, why it works, what it changes and its risk, and the author's decision on it,
 * accept or skip. One button applies the decisions; nothing is applied before it, and an idea left undecided stays so. Never a score: the room advises.
 */

export interface WildcardReviewResult {
  target: WildcardTarget;
  ideas: WildcardIdea[];
  voices: WildcardVoiceResult[];
  voicesOmitted?: number;
  clipped?: { from: number; to: number };
}

export function WildcardIdeasReview({ result, applyLabel, onApply, disabled }: {
  result: WildcardReviewResult;
  /** The words of the one button: where the accepted ideas go. */
  applyLabel: string;
  /** Applies the decisions; resolves with what to tell the author. */
  onApply: (choices: Record<string, WildcardChoice>) => Promise<string>;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [choices, setChoices] = useState<Record<string, WildcardChoice>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState("");
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const accepted = Object.values(choices).filter((choice) => choice === "accept").length;
  const skipped = Object.values(choices).filter((choice) => choice === "skip").length;
  const pending = result.ideas.length - accepted - skipped;
  const done = Boolean(status);

  useEffect(() => { if (status) statusRef.current?.focus(); }, [status]);

  const choose = (ideaId: string, choice: WildcardChoice) => setChoices((current) => ({ ...current, [ideaId]: choice }));
  const all = (choice: WildcardChoice) => setChoices(Object.fromEntries(result.ideas.map((idea) => [idea.id, choice])));

  async function apply() {
    setBusy(true);
    setFailure("");
    try {
      setStatus(await onApply(choices));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3" data-wildcard-review="">
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold">{t("wildcards.review.title")}</h3>
        <p className="text-sm text-muted-foreground">{result.target.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("wildcards.review.advisory")}</p>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("wildcards.review.voices")}</h4>
        <ul className="mt-1 flex flex-wrap gap-2 text-xs">
          {result.voices.map((voice) => (
            <li key={voice.persona.id} className="rounded-full border px-2 py-1" data-voice={voice.persona.slug} data-status={voice.status}>
              <span className="font-medium">{voice.persona.name}</span>
              {" · "}
              {voice.status === "ok" ? t("wildcards.review.ideas", { count: voice.ideas.length }) : voice.status === "skipped" ? t("wildcards.review.voiceSkipped") : t("wildcards.review.voiceFailed", { reason: voice.reason ?? "" })}
              {voice.omitted ? ` · ${t("wildcards.review.omitted", { count: voice.omitted })}` : ""}
            </li>
          ))}
        </ul>
        {result.clipped ? <p className="mt-1 text-xs text-muted-foreground">{t("wildcards.review.clipped", { to: result.clipped.to, from: result.clipped.from })}</p> : null}
      </div>
      {result.ideas.length > 0 && (
        <>
          <div role="group" aria-label={t("wildcards.review.bulk")} className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={done || busy} onClick={() => all("accept")}><Check className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.review.acceptAll")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={done || busy} onClick={() => all("skip")}><X className="mr-1 h-4 w-4" aria-hidden />{t("wildcards.review.skipAll")}</Button>
          </div>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">{`${t("wildcards.review.title")} — ${result.target.label}`}</caption>
            <thead className="sr-only sm:not-sr-only">
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">{t("wildcards.review.idea")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("wildcards.review.why")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("wildcards.review.changes")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("wildcards.review.risk")}</th>
                <th scope="col" className="py-2 font-medium">{t("wildcards.review.decision")}</th>
              </tr>
            </thead>
            <tbody>
              {result.ideas.map((idea) => {
                const choice = choices[idea.id];
                return (
                  <tr key={idea.id} className="block border-b py-3 align-top sm:table-row sm:py-0" data-idea={idea.id} data-choice={choice ?? "pending"}>
                    <th scope="row" className="block pb-2 pr-3 font-normal sm:table-cell sm:py-3">
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{idea.persona.name}</span>
                        <Badge variant="outline">{t(`wildcards.groups.${idea.persona.group}`)}</Badge>
                        <span>{t("wildcards.review.audacity", { value: idea.audacity })}</span>
                        {idea.severity ? <Badge variant="secondary">{t(`wildcards.review.severity.${idea.severity}`)}</Badge> : null}
                      </span>
                      <span className="mt-1 block font-semibold">{idea.title}</span>
                      <span className="mt-1 block">{idea.idea}</span>
                      {idea.evidence ? <span className="mt-1 block text-xs text-muted-foreground">{t("wildcards.review.evidence")}: {idea.evidence}</span> : null}
                    </th>
                    <td className="block pb-2 pr-3 sm:table-cell sm:py-3"><span className="text-xs font-medium text-muted-foreground sm:hidden">{idea.kind === "finding" ? t("wildcards.review.whyFinding") : t("wildcards.review.why")}: </span>{idea.why || "—"}</td>
                    <td className="block pb-2 pr-3 sm:table-cell sm:py-3">
                      <span className="text-xs font-medium text-muted-foreground sm:hidden">{t("wildcards.review.changes")}: </span>
                      {idea.changes.summary || "—"}
                      {idea.changes.chapters.length ? <span className="block text-xs text-muted-foreground">{t("wildcards.review.chapters", { list: idea.changes.chapters.join(", ") })}</span> : null}
                    </td>
                    <td className="block pb-2 pr-3 sm:table-cell sm:py-3"><span className="text-xs font-medium text-muted-foreground sm:hidden">{t("wildcards.review.risk")}: </span>{idea.risk || "—"}</td>
                    <td className="block sm:table-cell sm:py-3">
                      <fieldset className="flex flex-wrap gap-2" disabled={done || busy}>
                        <legend className="sr-only">{t("wildcards.review.decisionOn", { title: idea.title })}</legend>
                        {(["accept", "skip"] as const).map((value) => (
                          <label key={value} className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 ${choice === value ? (value === "accept" ? "border-primary bg-primary/10" : "border-foreground/40 bg-muted") : "border-field"}`}>
                            <input type="radio" name={`${id}-${idea.id}`} value={value} checked={choice === value} onChange={() => choose(idea.id, value)} className="accent-primary" />
                            {t(`wildcards.review.${value}`)}
                          </label>
                        ))}
                      </fieldset>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <p className="text-xs text-muted-foreground" aria-live="polite">{t("wildcards.review.counts", { accepted, skipped, pending })}</p>
      {failure ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" role="alert">{failure}</p> : null}
      {done ? (
        <p ref={statusRef} tabIndex={-1} role="status" className="rounded-md border border-primary/40 bg-primary/5 p-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">{status}</p>
      ) : (
        <Button type="button" onClick={() => void apply()} disabled={disabled || busy || accepted + skipped === 0}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
          {applyLabel}
        </Button>
      )}
    </section>
  );
}
