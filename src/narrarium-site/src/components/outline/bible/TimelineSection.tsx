import { useTranslation } from "react-i18next";
import { findingText } from "narrarium-engine";
import "@/i18n/bibleStudio";
import type { BibleData } from "@/outline/bibleModel";
import { FindingIcon } from "@/components/outline/bible/bibleParts";

/** The events of the timeline in the order of their dates, with the chapter each is anchored to and what the checks say of the ones that disagree with the chapters. */
export function TimelineSection({ data, language, onShowEntry, shownChapters }: { data: BibleData; language: string; onShowEntry: (number: number) => void; shownChapters: ReadonlySet<number> }) {
  const { t } = useTranslation();
  const slugs = new Map(data.timeline.map((event) => [event.slug, event]));
  const eventFindings = data.findings.filter((finding) => finding.event && slugs.has(finding.event.slug));
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("bibleStudio.timeline.intro")}</p>
      {data.timeline.length === 0
        ? <p className="text-sm text-muted-foreground">{t("bibleStudio.timeline.empty")}</p>
        : (
          <ol data-bible-timeline className="space-y-2">
            {data.timeline.map((event) => (
              <li key={event.path} data-timeline-event={event.slug} className="space-y-1 rounded-xl border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{event.title}</span>
                  <span className="text-xs font-medium text-muted-foreground">{event.date ?? t("bibleStudio.timeline.noDate")}</span>
                </div>
                {event.summary && <p className="text-sm text-muted-foreground">{event.summary}</p>}
                <p className="text-xs text-muted-foreground">
                  {event.participants.length > 0 && <>{t("bibleStudio.timeline.participants", { names: event.participants.join(", ") })}</>}
                  {event.chapter !== undefined && (
                    <>{event.participants.length > 0 ? " · " : ""}{shownChapters.has(event.chapter)
                      ? <button type="button" className="inline-flex min-h-6 items-center underline underline-offset-4 [@media(pointer:coarse)]:min-h-11" onClick={() => onShowEntry(event.chapter!)}>{t("bibleStudio.timeline.chapter", { number: event.chapter })}</button>
                      : t("bibleStudio.timeline.chapter", { number: event.chapter })}</>
                  )}
                </p>
                {eventFindings.filter((finding) => finding.event?.slug === event.slug).map((finding, index) => (
                  <p key={index} className="flex items-start gap-1.5 text-xs"><FindingIcon finding={finding} />{findingText(finding, language)}</p>
                ))}
              </li>
            ))}
          </ol>
        )}
    </div>
  );
}
