import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { AiErrorBody } from "narrarium-engine";
import { providerRows, type ProviderTextScope } from "@/autopilot/providerWords";
import { cn } from "@/lib/utils";

/**
 * What a provider answered when it refused a request, as labelled fields (Message, Type, Param, Code, and the HTTP status when `status` is asked), in its own words and whole: the page never cuts what the
 * engine kept. A body that is no structure (a text, the page of a gateway) is shown as it is, in a box that keeps its lines; one with nothing in it says that it had none. Every field is a term and a
 * description, so that a screen reader says the label and then the words.
 */
export function ProviderWords({ body, scope = "autopilot.failure.provider", status = false, className }: { body: AiErrorBody; scope?: ProviderTextScope; status?: boolean; className?: string }) {
  const { t } = useTranslation();
  const rows = providerRows(t, body, scope, { status });
  if (!rows.length) return null;
  return (
    <dl data-provider-words data-provider-shape={body.shape} className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs", className)}>
      {rows.map((row) => (
        <Fragment key={row.id}>
          <dt data-provider-field={row.id} className="text-muted-foreground">{row.label}</dt>
          <dd className={cn("min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]", row.id === "message" && "font-medium", row.verbatim && "rounded-md bg-muted/60 p-1.5 font-mono")}>{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
