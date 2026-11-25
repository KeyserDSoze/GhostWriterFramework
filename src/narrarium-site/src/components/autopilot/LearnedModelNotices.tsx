import { useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderWords } from "@/components/autopilot/ProviderWords";
import { useLearnedModelsStore, type LearnedModelNotice } from "@/autopilot/learnedModels";

/**
 * The notice of one model that a call learned to refuse thinking when the request carries tools: what the provider said, in its own words, and the two ways out in plain words, the Responses API first
 * when the provider's words tell to use it. Thinking is already off for the requests with tools of that model (the engine asked again without it, and the flag is in the model's row), so the second way
 * is said as done, and the first as what this version cannot do yet. A person can dismiss it; the model's row keeps the setting.
 */
function LearnedModelNoticeCard({ notice }: { notice: LearnedModelNotice }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dismiss = useLearnedModelsStore((state) => state.dismiss);
  return (
    <section role="status" data-learned-model data-learned-responses={notice.responses ? "" : undefined} aria-labelledby={titleId} className="space-y-2 rounded-2xl border border-amber-500/50 bg-amber-500/5 p-4 dark:border-amber-400/50 sm:p-5">
      <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold text-amber-800 dark:text-amber-300">
        <Info className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("autopilot.learned.title", { model: notice.model })}</span>
      </h2>
      <p className="text-sm">{t("autopilot.learned.said", { name: notice.integrationName })}</p>
      <ProviderWords body={notice.body} status />
      <p className="text-sm font-medium">{t(notice.responses ? "autopilot.learned.waysTitle" : "autopilot.learned.doneTitle")}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {notice.responses && <li data-learned-way="responses">{t("autopilot.learned.wayResponses")}</li>}
        <li data-learned-way="no-thinking">{t(notice.off === "none" ? "autopilot.learned.wayOffNone" : "autopilot.learned.wayOff")}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
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
