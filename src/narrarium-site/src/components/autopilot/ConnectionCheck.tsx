import { useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "@/i18n/endpoint";
import { Button } from "@/components/ui/button";
import { integrationLink } from "@/components/settings/endpoint/anchor";
import { EndpointCheckButton } from "@/components/settings/endpoint/EndpointCheckButton";
import { EndpointCheckResult } from "@/components/settings/endpoint/EndpointCheckResult";
import { useEndpointCheck } from "@/components/settings/endpoint/useEndpointCheck";
import type { AIIntegration } from "@/types/settings";

/**
 * «Check the connection» in the panel of an error: the same check, with the same result and the same words, as in the card of the integration of the step that failed, and the way to
 * that card. A run on the personal server fails from the server's own network, which the browser does not share: the check says that it asks from here.
 */
export function ConnectionCheck({ integration, hostedOnServer }: { integration: AIIntegration; hostedOnServer: boolean }) {
  const { t } = useTranslation();
  const statusId = useId();
  const { state, check, checking } = useEndpointCheck(integration);
  const name = integration.name.trim() || t("settings.unnamedIntegration");
  return (
    <div data-connection-check className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <EndpointCheckButton name={name} checking={checking} onCheck={check} describedBy={statusId} />
        <Button asChild size="sm" variant="ghost">
          <Link to={integrationLink(integration.id)}>{t("endpoint.open")}</Link>
        </Button>
      </div>
      <EndpointCheckResult id={statusId} state={state} />
      {hostedOnServer && <p className="text-xs text-muted-foreground">{t("endpoint.fromBrowser")}</p>}
    </div>
  );
}
