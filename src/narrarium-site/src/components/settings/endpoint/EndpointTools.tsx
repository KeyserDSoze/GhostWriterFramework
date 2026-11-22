import { Suspense, lazy, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import "@/i18n/endpoint";
import { Button } from "@/components/ui/button";
import type { AIIntegration } from "@/types/settings";
import { EndpointCheckButton } from "./EndpointCheckButton";
import { EndpointCheckResult } from "./EndpointCheckResult";
import { useEndpointCheck } from "./useEndpointCheck";

/** The dialog and the code that reads the catalog are loaded when the author opens it: the settings page does not carry them. */
const ModelCatalogDialog = lazy(() => import("./ModelCatalogDialog"));

/**
 * The two buttons of the card of an OpenAI-compatible integration that ask its endpoint something, with the address and the key as they are written now: «Check the connection» (does it
 * answer, how fast, how many models) and «Read the models from the endpoint» (a dialog with what it lists, to add to the integration or to update). Their names say which integration they
 * act on, and begin with the words on them. A check that is on its way asks nothing more, and its button keeps the focus.
 */
export function EndpointTools({ integration, onChange, disabled = false }: { integration: AIIntegration; onChange: (patch: Partial<AIIntegration>) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const statusId = useId();
  const { state, check, checking } = useEndpointCheck(integration);
  const [reading, setReading] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const name = integration.name.trim() || t("settings.unnamedIntegration");

  return (
    <div data-endpoint-tools className="grid gap-2 sm:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <EndpointCheckButton name={name} checking={checking} onCheck={check} describedBy={statusId} disabled={disabled} />
        <Button ref={opener} type="button" variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" disabled={disabled} aria-label={t("endpoint.readNamed", { name })} onClick={() => setReading(true)}>
          <ListChecks className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t("endpoint.read")}
        </Button>
      </div>
      <EndpointCheckResult id={statusId} state={state} />
      {reading && (
        <Suspense fallback={null}>
          <ModelCatalogDialog integration={integration} name={name} onClose={() => setReading(false)} onApply={onChange} returnFocus={() => opener.current?.focus()} />
        </Suspense>
      )}
    </div>
  );
}
