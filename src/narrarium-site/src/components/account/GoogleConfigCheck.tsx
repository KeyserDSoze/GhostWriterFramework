import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ListChecks } from "lucide-react";
import "@/i18n/googleAccess";
import { GOOGLE_CLIENT_ID } from "@/config/publicClients";
import { googleConfigReport } from "@/account/googleConfigCheck";

/**
 * «Check Google configuration»: the permissions this site asks Google for at every sign-in, the number of the project its client id belongs to, and the list
 * to go through in the Google Cloud console when signing in fails. A lazy chunk, opened from the Google card; it shows nothing secret (a client id is public,
 * and only its project number is written).
 */
export function GoogleConfigCheck() {
  const { t } = useTranslation();
  const titleId = useId();
  const report = googleConfigReport(GOOGLE_CLIENT_ID);
  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3 text-sm" data-testid="google-config-check">
      <h4 id={titleId} className="flex items-center gap-2 font-semibold"><ListChecks aria-hidden="true" className="h-4 w-4" />{t("googleAccess.check.title")}</h4>
      <p className="text-xs text-muted-foreground">{t("googleAccess.check.intro")}</p>
      <div className="space-y-1">
        <h5 className="text-xs font-medium">{t("googleAccess.check.scopes")}</h5>
        <ul className="ml-4 list-disc break-words text-xs" data-testid="google-config-scopes">
          {report.scopes.map((scope) => <li key={scope}>{t(`googleAccess.check.scope.${scope.replace("https://www.googleapis.com/auth/drive.", "")}`, { defaultValue: scope })}</li>)}
        </ul>
        <p className="flex items-start gap-2 text-xs"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t("googleAccess.check.notAsked")}</p>
      </div>
      <div className="space-y-1">
        <h5 className="text-xs font-medium">{t("googleAccess.check.client")}</h5>
        <p className="text-xs" data-testid="google-config-client">{report.project ? t("googleAccess.check.clientValue", { project: report.project }) : t("googleAccess.check.clientUnknown")}</p>
      </div>
      <div className="space-y-1">
        <h5 className="text-xs font-medium">{t("googleAccess.check.checklist")}</h5>
        <ul className="ml-4 list-disc space-y-1 text-xs">
          {(["audience", "project", "scopes", "origins", "grants"] as const).map((item) => <li key={item}>{t(`googleAccess.check.items.${item}`)}</li>)}
        </ul>
      </div>
    </section>
  );
}
