import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import "@/i18n/googleAccess";
import { Button } from "@/components/ui/button";
import { GOOGLE_SCOPE_FULL_DRIVE } from "@/config/googleAuth";
import { GoogleScopeConsentError, requestGoogleScope, type GoogleScopeGrant } from "@/account/googleScopeConsent";

export type FullAccessReason = "export" | "browse" | "legacy";

/**
 * The one place full access to Drive (Google's restricted «drive» scope) is asked for, and only when a person chose something that needs it: the notice says
 * why, what Google will say about it and how to take it back, and the permission is asked on the button, never before. The answer is held by the caller for
 * the session; nothing is saved.
 */
export function GoogleFullAccessNotice({ reason, hint, onGranted, onDismiss }: { reason: FullAccessReason; hint?: string; onGranted: (grant: GoogleScopeGrant) => void; onDismiss?: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function allow() {
    setAsking(true);
    setFailure(null);
    try {
      const grant = await requestGoogleScope(GOOGLE_SCOPE_FULL_DRIVE, { hint });
      setDone(true);
      onGranted(grant);
    } catch (error) {
      setFailure(error instanceof GoogleScopeConsentError ? error.reason : "failed");
    } finally {
      setAsking(false);
    }
  }

  if (done) return <p role="status" className="flex items-start gap-2 text-sm"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("googleAccess.full.granted")}</p>;
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border border-amber-600/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="google-full-access-notice">
      <h4 id={titleId} className="flex items-start gap-2 font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("googleAccess.full.title")}</h4>
      <p>{t("googleAccess.full.body", { reason: t(`googleAccess.full.reason.${reason}`) })}</p>
      {failure && <p role="alert" className="flex items-start gap-2 font-medium"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`googleAccess.full.error.${failure}`)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={asking} onClick={() => void allow()}>
          {asking ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{asking ? t("googleAccess.full.allowing") : t("googleAccess.full.allow")}
        </Button>
        {onDismiss && <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t("googleAccess.full.dismiss")}</Button>}
      </div>
    </section>
  );
}
