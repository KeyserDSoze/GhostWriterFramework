import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AI_API_PROTOCOLS, describeUrl, effectiveApiVersion, endpointUrlProblem, endpointUrlSecretKeys, looksLikeResponsesUrl, modelRequestTarget, normalizeApiProtocol, normalizeEndpointUrl, type AiIntegrationConfig } from "narrarium-engine";
import "@/i18n/aiRouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ApiProtocol, ChatModel } from "@/types/settings";

/** What the editor needs to know of the integration to say where a model's requests go: the same facts the engine builds the address from. */
export type ModelRequestIntegration = Pick<AiIntegrationConfig, "provider" | "endpoint" | "apiVersion">;

/** The two fields of a model that this editor sets, as the model has them after the change: a field that is absent is not set. */
export type ModelRequestPatch = Pick<ChatModel, "apiProtocol" | "endpointUrl">;

/** The protocol the engine would use for what is stored: `responses` exactly, and Chat Completions for anything else. */
export function protocolOf(model: Pick<ChatModel, "apiProtocol">): ApiProtocol {
  return normalizeApiProtocol(model.apiProtocol) ?? "chat-completions";
}

/**
 * The «API protocol» and the «Address of this model» of a model, in its row of the integration card: how its requests are made (Chat Completions, or the Responses API, which takes a thinking
 * level and function tools together), and, for a gateway whose address is not the one built from the integration, the whole address of the request, used as it is written.
 *
 * What is stored is exactly what the author chooses: the protocol only when it is the Responses API (Chat Completions is what no value means), the address with its spaces taken off, and nothing when it
 * is empty. The page never switches a model by itself: for an address that ends with `/responses` it offers the Responses API with a button, and says it in the field's description. The line «Requests go
 * to» tells what the engine will send the request to, from the engine's own rule (`modelRequestTarget`), so that the version the Responses API is asked with (which is not the one of an integration that
 * keeps an older one for its Chat Completions models) is not a surprise. A problem with the address is said in words and in the field (`aria-invalid`), a key in its query is warned of, and while the model has
 * an address of its own the note says that the API versions are not used for it. `hintId` is the paragraph of the card that explains both settings once for all its models.
 */
export function ModelRequestFields({ model, integration, hintId, onChange }: { model: ChatModel; integration: ModelRequestIntegration; hintId: string; onChange: (patch: ModelRequestPatch) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const protocol = protocolOf(model);
  const written = model.endpointUrl ?? "";
  const problem = endpointUrlProblem(written);
  const own = normalizeEndpointUrl(written);
  const secrets = endpointUrlSecretKeys(written);
  const offerResponses = protocol !== "responses" && looksLikeResponsesUrl(written);
  const { provider, endpoint, apiVersion } = integration;
  const name = model.name.trim();
  const target = useMemo(
    () => modelRequestTarget({ id: "editor", name: "editor", apiKey: "", provider, endpoint, apiVersion }, { name: name || "model", apiVersion: model.apiVersion, apiProtocol: model.apiProtocol, endpointUrl: written }),
    [provider, endpoint, apiVersion, name, model.apiVersion, model.apiProtocol, written],
  );
  // The Responses API is not asked with the version of an integration that predates it: the line says which it is asked with, and why.
  const versionChanged = !("problem" in target) && !target.own && target.protocol === "responses" && provider === "azure_openai" && target.apiVersion !== undefined && target.apiVersion !== "v1"
    && target.apiVersion !== effectiveApiVersion({ provider, endpoint, apiVersion }, { apiVersion: model.apiVersion });
  const protocolId = `${id}-protocol`;
  const urlId = `${id}-url`;
  const goesId = `${id}-goes`;
  const suggestionId = `${id}-suggestion`;
  const problemId = `${id}-problem`;
  const secretId = `${id}-secret`;
  const noteId = `${id}-note`;
  const azure = provider === "azure_openai";

  return (
    <div data-model-request={protocol} data-model-own-address={own ? "" : undefined} className="grid gap-2 sm:col-span-3">
      <div className="grid gap-1">
        <Label htmlFor={protocolId} className="text-xs">{t("settings.apiProtocol")}{name && <>{" "}<span className="sr-only">— {name}</span></>}</Label>
        <Select value={protocol} onValueChange={(next) => onChange({ ...(next === "responses" ? { apiProtocol: "responses" as const } : {}), ...(model.endpointUrl ? { endpointUrl: model.endpointUrl } : {}) })}>
          <SelectTrigger id={protocolId} aria-describedby={cn(hintId, goesId)} className="h-8 text-sm sm:max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AI_API_PROTOCOLS.map((value) => (
              <SelectItem key={value} value={value}>{t(value === "responses" ? "settings.apiProtocolResponses" : "settings.apiProtocolChat")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={urlId} className="text-xs">{t("settings.modelEndpointUrl")}{name && <>{" "}<span className="sr-only">— {name}</span></>}</Label>
        <Input
          id={urlId}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={written}
          onChange={(event) => {
            const next = event.target.value.trim();
            onChange({ ...(model.apiProtocol ? { apiProtocol: model.apiProtocol } : {}), ...(next ? { endpointUrl: next } : {}) });
          }}
          placeholder={t("settings.modelEndpointUrlPlaceholder")}
          aria-describedby={cn(hintId, goesId, problem && problemId, secrets.length > 0 && secretId, own && azure && noteId, offerResponses && suggestionId)}
          aria-invalid={Boolean(problem) || undefined}
          className="h-8 text-sm"
        />
        {problem && <p id={problemId} role="alert" data-model-url-problem={problem} className="text-xs text-destructive">{t(`settings.modelEndpointUrlProblem.${problem}`)}</p>}
        {secrets.length > 0 && <p id={secretId} role="status" data-model-url-secret className="text-xs text-amber-800 dark:text-amber-300">{t("settings.modelEndpointUrlSecret", { names: secrets.join(", ") })}</p>}
        {own && azure && <p id={noteId} data-model-url-versions className="text-xs text-muted-foreground">{t("settings.modelEndpointUrlVersionsIgnored")}</p>}
      </div>
      {offerResponses && (
        <div id={suggestionId} data-responses-suggestion className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-layer bg-muted/30 px-3 py-2 text-xs">
          <p className="min-w-0 flex-1 basis-60">{t("settings.modelResponsesSuggestion")}</p>
          <Button type="button" size="sm" variant="outline" aria-label={t("settings.modelResponsesUseFor", { name })} onClick={() => onChange({ apiProtocol: "responses", ...(model.endpointUrl ? { endpointUrl: model.endpointUrl } : {}) })}>
            {t("settings.modelResponsesUse")}
          </Button>
        </div>
      )}
      <div id={goesId} data-model-goes-to className="grid gap-1 break-all text-xs text-muted-foreground">
        {"problem" in target
          ? <p>{t(target.problem === "no-responses-api" ? "settings.modelNoResponsesApi" : "settings.modelNoAddress")}</p>
          : <p>{t("settings.modelRequestsGoTo")}{" "}<code className="rounded bg-muted px-1 py-0.5 text-xs">{target.own ? describeUrl(target.url) : target.url}</code></p>}
        {versionChanged && !("problem" in target) && <p data-model-responses-version>{t("settings.modelResponsesVersionNote", { integration: effectiveApiVersion({ provider, endpoint, apiVersion }, { apiVersion: model.apiVersion }), version: target.apiVersion })}</p>}
      </div>
    </div>
  );
}
