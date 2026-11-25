import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderWords } from "@/components/autopilot/ProviderWords";
import { chooseResponsesApi, providerHasResponsesApi, useLearnedModelsStore, type LearnedModelNotice } from "@/autopilot/learnedModels";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * The notice of one model that a call learned to refuse thinking when the request carries tools: what the provider said, in its own words, and the two ways out in plain words, the Responses API first.
 * Thinking is already off for the requests with tools of that model (the engine asked again without it, and the flag is in the model's row), so the second way is said as done. The first is the author's
 * choice, and a button makes it: the model is asked through the Responses API from the next call on, which takes a thinking level and function tools together (it is offered for a provider that has it, and while
 * the model is in the settings). Once the model is on the Responses API the notice says what changed instead, and keeps the flag's story short: it stays in the row, unused. A person can dismiss it; the model's row
 * keeps the settings.
 */
function LearnedModelNoticeCard({ notice }: { notice: LearnedModelNotice }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dismiss = useLearnedModelsStore((state) => state.dismiss);
  const provider = useSettingsStore((state) => state.settings.aiIntegrations.find((entry) => entry.id === notice.integrationId)?.provider);
  const protocol = useSettingsStore((state) => state.settings.aiIntegrations.find((entry) => entry.id === notice.integrationId)?.chatModels?.find((entry) => entry.name === notice.model)?.apiProtocol);
  const listed = useSettingsStore((state) => Boolean(state.settings.aiIntegrations.find((entry) => entry.id === notice.integrationId)?.chatModels?.some((entry) => entry.name === notice.model)));
  const onResponses = protocol === "responses";
  const canOffer = listed && !onResponses && providerHasResponsesApi(provider);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState(false);
  const doneRef = useRef<HTMLParagraphElement>(null);
  // The button that was pressed goes away with the choice: what changed is where the reader's place goes.
  useEffect(() => {
    if (chosen && onResponses) doneRef.current?.focus();
  }, [chosen, onResponses]);
  const showResponsesWay = canOffer || notice.responses;
  return (
    <section role="status" data-learned-model data-learned-responses={notice.responses ? "" : undefined} data-learned-on-responses={onResponses ? "" : undefined} aria-labelledby={titleId} className="space-y-2 rounded-2xl border border-amber-500/50 bg-amber-500/5 p-4 dark:border-amber-400/50 sm:p-5">
      <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold text-amber-800 dark:text-amber-300">
        <Info className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t(onResponses ? "autopilot.learned.titleResponses" : "autopilot.learned.title", { model: notice.model })}</span>
      </h2>
      <p className="text-sm">{t("autopilot.learned.said", { name: notice.integrationName })}</p>
      <ProviderWords body={notice.body} status />
      {onResponses ? (
        <p ref={doneRef} tabIndex={-1} data-learned-done-responses className="text-sm outline-none">{t("autopilot.learned.doneResponses", { model: notice.model })}</p>
      ) : (
        <>
          <p className="text-sm font-medium">{t(showResponsesWay ? "autopilot.learned.waysTitle" : "autopilot.learned.doneTitle")}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {showResponsesWay && <li data-learned-way="responses">{t("autopilot.learned.wayResponses")}</li>}
            <li data-learned-way="no-thinking">{t(notice.off === "none" ? "autopilot.learned.wayOffNone" : "autopilot.learned.wayOff")}</li>
          </ul>
        </>
      )}
      {failed && <p role="alert" data-learned-responses-failed className="text-sm text-destructive">{t("autopilot.learned.responsesFailed")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canOffer && (
          <Button size="sm" data-learned-use-responses onClick={() => { setChosen(true); setFailed(!chooseResponsesApi(notice.integrationId, notice.model)); }}>
            {t("autopilot.learned.useResponses", { model: notice.model })}
          </Button>
        )}
        <Button asChild size="sm" variant="outline">
          <Link to="/app/settings/ai-integrations">{t("autopilot.learned.openSettings")}</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => dismiss(notice.key)}>{t("autopilot.learned.dismiss")}</Button>
      </div>
    </section>
  );
}

/** The notices of the models that this page learned to refuse thinking with tools, one card each, under the band with the other things the author should read. */
export function LearnedModelNotices() {
  const notices = useLearnedModelsStore((state) => state.notices);
  return <>{notices.map((notice) => <LearnedModelNoticeCard key={notice.key} notice={notice} />)}</>;
}
