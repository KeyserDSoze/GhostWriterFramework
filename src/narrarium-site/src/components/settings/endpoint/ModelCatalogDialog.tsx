import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Brain, Eye, Loader2, Wrench, Zap, type LucideIcon } from "lucide-react";
import type { AiModelCatalog, AiModelCatalogEntry } from "narrarium-engine";
import "@/i18n/aiRouter";
import "@/i18n/catalog";
import "@/i18n/endpoint";
import { FILL_KEYS, MEDIA_KINDS, applyChoices, currentMedia, defaultChoices, fillOf, groupCatalog, tellsKinds, thinkingSuggestion, type CatalogChoices, type CatalogKind, type MediaKind } from "@/ai/catalogPlan";
import { failureOf, readCatalog, type EndpointFailure } from "@/ai/endpointTools";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import type { AIIntegration } from "@/types/settings";

type Load = { status: "loading" } | { status: "error"; failure: EndpointFailure } | { status: "ready"; catalog: AiModelCatalog };

const NO_CHOICES: CatalogChoices = { models: new Set(), thinking: new Set(), media: {} };

const CAPABILITIES: ReadonlyArray<{ key: "tools" | "streaming" | "reasoning" | "vision"; icon: LucideIcon }> = [
  { key: "tools", icon: Wrench },
  { key: "streaming", icon: Zap },
  { key: "reasoning", icon: Brain },
  { key: "vision", icon: Eye },
];

/** A checkbox is 16 px, and its label is at least 24 px tall (`NAME`), so that every row has a target of the size a pointer needs: the label toggles the box. */
const BOX = "mt-1 h-4 w-4 shrink-0 accent-primary";
const NAME = "inline-flex min-h-6 items-center break-all font-mono text-sm font-medium";

interface Props {
  /** The integration as the author has it now, key and address included: it is read once, when the dialog opens. */
  integration: AIIntegration;
  /** The name the integration is called by. */
  name: string;
  onClose: () => void;
  /** The change to make to the integration: only what the author confirmed. */
  onApply: (patch: Partial<AIIntegration>) => void;
  /** Where the focus goes when the dialog closes: the button that opened it. A dialog that has no trigger of its own does not give the focus back by itself, and it would be lost. */
  returnFocus?: () => void;
}

/**
 * Reads the models of the endpoint of an OpenAI-compatible integration and lets the author choose what to add or update. It is loaded when it is opened, with its own texts, and it reads
 * again every time (nothing is kept from the last time). The list is grouped by kind, each model with its declared window, largest answer and capabilities, and whether the integration
 * has it; the new text models are ticked, nothing else is; confirming changes only what the author ticked, and never what the author wrote (see `applyChoices`).
 */
export default function ModelCatalogDialog({ integration, name, onClose, onApply, returnFocus }: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const baseId = useId();
  const [source] = useState(integration);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [choices, setChoices] = useState<CatalogChoices>(NO_CHOICES);
  const language = i18n.resolvedLanguage || i18n.language || "en";

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    Promise.resolve()
      .then(() => readCatalog(source, { signal: controller.signal }))
      .then(
        (catalog) => {
          if (controller.signal.aborted) return;
          setChoices(defaultChoices(source, catalog));
          setLoad({ status: "ready", catalog });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setLoad({ status: "error", failure: failureOf(error, source) });
        },
      );
    return () => controller.abort();
  }, [source, attempt]);

  const catalog = load.status === "ready" ? load.catalog : null;
  const plan = useMemo(() => (catalog ? applyChoices(source, catalog, choices, () => "preview") : null), [source, catalog, choices]);
  const models = plan ? plan.added.length + plan.updated.length : 0;
  const media = plan ? plan.media.length : 0;

  const words = (list: string[]) => (list.length < 2 ? list.join("") : t("catalog.list.and", { list: list.slice(0, -1).join(", "), last: list[list.length - 1] }));
  const number = (value: number) => new Intl.NumberFormat(language).format(value);

  function toggleModel(entry: AiModelCatalogEntry, on: boolean) {
    setChoices((current) => {
      const next = { ...current, models: new Set(current.models), thinking: new Set(current.thinking) };
      if (on) {
        next.models.add(entry.id);
        if (thinkingSuggestion(entry.id)) next.thinking.add(entry.id);
      } else {
        next.models.delete(entry.id);
        next.thinking.delete(entry.id);
      }
      return next;
    });
  }

  function toggleThinking(id: string, on: boolean) {
    setChoices((current) => {
      const thinking = new Set(current.thinking);
      if (on) thinking.add(id);
      else thinking.delete(id);
      return { ...current, thinking };
    });
  }

  function chooseMedia(kind: MediaKind, id: string, on: boolean) {
    setChoices((current) => ({ ...current, media: { ...current.media, [kind]: on ? id : undefined } }));
  }

  function confirm() {
    if (!catalog || !plan) return;
    const outcome = applyChoices(source, catalog, choices);
    const said = [
      outcome.added.length ? t("catalog.done.added", { count: outcome.added.length }) : "",
      outcome.updated.length ? t("catalog.done.updated", { count: outcome.updated.length }) : "",
      outcome.media.length ? t("catalog.done.media", { count: outcome.media.length }) : "",
    ].filter(Boolean);
    onApply(outcome.patch);
    toast({ title: t("catalog.title", { name }), description: said.join(" ") });
    onClose();
  }

  const paths = ["/models", ...(catalog?.source.details ? ["/models/details"] : []), ...(catalog?.source.modalities ? ["/modalities"] : [])];
  const sourceLine = !catalog ? "" : !tellsKinds(catalog.source) ? t("catalog.source.only") : catalog.source.details ? t("catalog.source.read", { paths: words(paths) }) : t("catalog.source.noLimits", { paths: words(paths) });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideCloseButton
        data-catalog-state={load.status}
        className="flex max-h-[90vh] w-[calc(100%-1rem)] max-w-3xl flex-col gap-3 overflow-hidden p-4 sm:p-6"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus?.();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("catalog.title", { name })}</DialogTitle>
          <DialogDescription>{t("catalog.description")}</DialogDescription>
        </DialogHeader>

        <p role="status" data-catalog-status className="flex items-start gap-2 text-sm">
          {load.status === "loading" && (
            <>
              <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
              <span>{t("catalog.loading")}</span>
            </>
          )}
          {load.status === "ready" && <span>{sourceLine}</span>}
        </p>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {load.status === "error" && (
            <div className="space-y-2">
              <div role="alert" className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/5 p-3 text-sm dark:border-red-400/50">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-400" />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{t("catalog.error.title")}</p>
                  <p>{t(`catalog.error.${load.failure.reason}`, { why: t("endpoint.why") })}</p>
                </div>
              </div>
              {load.failure.message && (
                <details data-catalog-details className="text-xs">
                  <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("endpoint.details")}</summary>
                  <p lang="en" className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono">{load.failure.message}</p>
                </details>
              )}
            </div>
          )}

          {catalog && (
            <>
              {!tellsKinds(catalog.source) && <p className="text-sm text-muted-foreground">{t("catalog.noKinds")}</p>}
              {groupCatalog(catalog).map((group) => (
                <fieldset key={group.kind} className="min-w-0 rounded-lg border border-layer p-3">
                  <legend className="px-1 text-sm font-semibold">{t(`catalog.group.${group.kind}`)} ({group.entries.length})</legend>
                  <ul className="grid gap-2">
                    {group.entries.map((entry) => (
                      <ModelRow
                        key={entry.id}
                        id={`${baseId}-${catalog.models.indexOf(entry)}`}
                        entry={entry}
                        kind={group.kind}
                        integration={source}
                        choices={choices}
                        number={number}
                        words={words}
                        onModel={toggleModel}
                        onThinking={toggleThinking}
                        onMedia={chooseMedia}
                      />
                    ))}
                  </ul>
                </fieldset>
              ))}
              {plan?.defaulted && <p data-catalog-defaulted className="text-sm text-muted-foreground">{t("catalog.defaulted", { name: plan.defaulted })}</p>}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{load.status === "error" ? t("catalog.close") : t("catalog.cancel")}</Button>
          {load.status === "error" && <Button type="button" onClick={() => setAttempt((count) => count + 1)}>{t("catalog.retry")}</Button>}
          {load.status === "ready" && (
            <Button type="button" disabled={models === 0 && media === 0} onClick={confirm}>
              {models === 0 && media > 0 ? t("catalog.applyChoices") : t("catalog.apply", { count: models })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RowProps {
  id: string;
  entry: AiModelCatalogEntry;
  kind: CatalogKind;
  integration: AIIntegration;
  choices: CatalogChoices;
  number: (value: number) => string;
  words: (list: string[]) => string;
  onModel: (entry: AiModelCatalogEntry, on: boolean) => void;
  onThinking: (id: string, on: boolean) => void;
  onMedia: (kind: MediaKind, id: string, on: boolean) => void;
}

/**
 * One model: its name, whether the integration has it, what it declares (window, largest answer, capabilities: words with an icon, so that nothing depends on a colour), and, by kind,
 * what ticking it does. A text model is added or, when the integration has it, updated where it is empty; a model of another kind can be set as the integration's model for images, speech or
 * transcription while that field is empty; the others are listed for information.
 */
function ModelRow({ id, entry, kind, integration, choices, number, words, onModel, onThinking, onMedia }: RowProps) {
  const { t } = useTranslation();
  const isText = kind === "text";
  const mediaKind = (MEDIA_KINDS as readonly string[]).includes(kind) ? (kind as MediaKind) : undefined;
  const have = isText ? (integration.chatModels ?? []).find((model) => model.name === entry.id) : undefined;
  const fillKeys = have ? FILL_KEYS.filter((key) => key in fillOf(have, entry)) : [];
  const nothingToAdd = Boolean(have) && fillKeys.length === 0;
  const taken = mediaKind ? currentMedia(integration, mediaKind) : "";
  const suggestion = isText && !have ? thinkingSuggestion(entry.id) : undefined;
  const declared = CAPABILITIES.filter((capability) => entry.capabilities[capability.key] === true);
  const limits = [
    entry.contextWindow !== undefined ? t("catalog.limits.window", { value: number(entry.contextWindow) }) : "",
    entry.maxOutputTokens !== undefined ? t("catalog.limits.output", { value: number(entry.maxOutputTokens) }) : "",
  ].filter(Boolean);
  const boxId = `${id}-box`;
  const nameId = `${id}-name`;
  const badgeId = `${id}-badge`;
  const metaId = `${id}-meta`;
  const actionId = `${id}-action`;
  const hintId = `${id}-hint`;

  const checked = isText ? choices.models.has(entry.id) : mediaKind ? choices.media[mediaKind] === entry.id : false;
  const hasBox = isText || (mediaKind !== undefined && !taken);

  return (
    <li data-model={entry.id} className="rounded-md border border-layer p-2">
      <div className="flex items-start gap-2">
        {hasBox && (
          <input
            id={boxId}
            type="checkbox"
            className={BOX}
            checked={checked}
            disabled={nothingToAdd}
            aria-labelledby={isText ? nameId : `${nameId} ${actionId}`}
            aria-describedby={isText ? `${badgeId} ${metaId}` : metaId}
            onChange={(event) => (isText ? onModel(entry, event.target.checked) : onMedia(mediaKind as MediaKind, entry.id, event.target.checked))}
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {isText ? <label id={nameId} htmlFor={boxId} className={NAME}>{entry.id}</label> : <span id={nameId} className={NAME}>{entry.id}</span>}
            {isText && <span id={badgeId} data-catalog-badge className="rounded border border-layer px-1.5 py-0.5 text-xs">{have ? t("catalog.badge.existing") : t("catalog.badge.new")}</span>}
            {hasBox && mediaKind && <label id={actionId} htmlFor={boxId} className="inline-flex min-h-6 items-center text-xs">{t(`catalog.media.${mediaKind}`)}</label>}
          </div>
          <div id={metaId} className="space-y-1 text-xs text-muted-foreground">
            {limits.length > 0 && <p>{limits.join(" · ")}</p>}
            {declared.length > 0 && (
              <ul aria-label={t("catalog.capabilities")} className="flex flex-wrap gap-x-3 gap-y-1">
                {declared.map(({ key, icon: Icon }) => (
                  <li key={key} className="inline-flex items-center gap-1">
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {t(`catalog.capability.${key}`)}
                  </li>
                ))}
              </ul>
            )}
            {isText && limits.length === 0 && declared.length === 0 && <p>{t("catalog.notDeclared")}</p>}
            {mediaKind && taken && <p>{t(`catalog.media.taken.${mediaKind}`, { model: taken })}</p>}
            {!isText && !mediaKind && <p>{t("catalog.informational")}</p>}
            {have && !nothingToAdd && (
              <>
                <p data-catalog-fills>{t("catalog.fills", { fields: words(fillKeys.map((key) => t(`catalog.field.${key}`))) })}</p>
                <p>{t("catalog.kept")}</p>
              </>
            )}
            {nothingToAdd && <p>{t("catalog.nothingToAdd")}</p>}
          </div>
          {suggestion && checked && (
            <div className="mt-1 space-y-1 rounded-md bg-muted/40 p-2">
              <label className="flex items-start gap-2 py-1 text-xs font-medium">
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={choices.thinking.has(entry.id)} aria-describedby={hintId} onChange={(event) => onThinking(entry.id, event.target.checked)} />
                <span>{t("catalog.thinking.use", { name: entry.id, value: suggestion })}</span>
              </label>
              <p id={hintId} className="text-xs text-muted-foreground">{t("settings.thinkingParameterSuggestion", { value: suggestion })} {t("catalog.thinking.untick")}</p>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
