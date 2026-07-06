import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronRight, Cloud, CloudOff, Download, Github, Loader2, Mic, Plus, Route, Trash2, Volume2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { fetchGitHubModelsCatalog, type GitHubCatalogModel } from "@/github/githubModelsCatalog";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { CHAT_CAPABILITIES, ROUTING_TASKS, type AIIntegration, type AIProviderType, type AppSettings, type ChatCapability, type ChatModel, type RoutingTarget, type RoutingTaskKind, type TaskRoute } from "@/types/settings";
import { integrationChatModels } from "@/assistant/llm";
import { BROWSER_ROUTING_ID } from "@/assistant/router";

const PROVIDERS: Array<{ value: AIProviderType; label: string }> = [
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "openai", label: "OpenAI / compatible" },
  { value: "github_models", label: "GitHub Models" },
  { value: "m365_copilot", label: "Microsoft 365 Copilot" },
];

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const sync = () => setVoices(window.speechSynthesis.getVoices());
    sync();
    window.speechSynthesis.addEventListener("voiceschanged", sync);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", sync);
  }, []);
  return voices;
}

/** Collapsible settings section (closed by default) styled like a card. */
function Section({ title, description, icon, defaultOpen, children }: { title: string; description?: string; icon?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-xl border bg-card text-card-foreground shadow-sm [&[open]>summary_.chev]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="chev h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
        {icon}
        <div className="min-w-0">
          <p className="font-semibold leading-none">{title}</p>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
      </summary>
      <div className="px-6 pb-6">{children}</div>
    </details>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus, lastSynced, load } = useSettings();

  const didAutoLoad = useRef(false);
  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    void load();
  }, [load]);

  const [defaultToken, setDefaultToken] = useState(settings.defaultGitHubToken);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [newIntegration, setNewIntegration] = useState<AIIntegration>(() => createBlankIntegration());

  useEffect(() => {
    setDefaultToken(settings.defaultGitHubToken);
  }, [settings.defaultGitHubToken]);

  const isSaving = syncStatus === "saving";
  const isLoading = syncStatus === "loading";
  const aiIntegrations = settings.aiIntegrations ?? [];
  const defaultWriting = settings.defaultWritingIntegrationId ?? aiIntegrations[0]?.id;
  const defaultReview = settings.defaultReviewIntegrationId ?? aiIntegrations[0]?.id;

  async function handleSave() {
    const azureOpenAI = integrationToAzureCompat(aiIntegrations) ?? settings.azureOpenAI;
    patchSettings({ defaultGitHubToken: defaultToken, azureOpenAI });
    await save();
  }

  function patchAi(patch: Partial<AppSettings>) {
    patchSettings(patch);
  }

  function addExtraToken() {
    if (!newTokenLabel || !newToken) return;
    patchSettings({
      extraGitHubTokens: [...settings.extraGitHubTokens, { label: newTokenLabel, token: newToken }],
    });
    setNewTokenLabel("");
    setNewToken("");
  }

  function removeExtraToken(index: number) {
    patchSettings({ extraGitHubTokens: settings.extraGitHubTokens.filter((_, i) => i !== index) });
  }

  function addIntegration() {
    const candidate = normalizeIntegration(newIntegration);
    if (!candidate.name.trim()) return;
    const next = [...aiIntegrations, candidate];
    patchAi({
      aiIntegrations: next,
      defaultWritingIntegrationId: defaultWriting ?? candidate.id,
      defaultReviewIntegrationId: defaultReview ?? candidate.id,
      azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI,
    });
    setNewIntegration(createBlankIntegration());
  }

  function updateIntegration(id: string, patch: Partial<AIIntegration>) {
    const next = aiIntegrations.map((integration) =>
      integration.id === id ? normalizeIntegration({ ...integration, ...patch }) : integration,
    );
    patchAi({ aiIntegrations: next, azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI });
  }

  function removeIntegration(id: string) {
    const next = aiIntegrations.filter((integration) => integration.id !== id);
    patchAi({
      aiIntegrations: next,
      defaultWritingIntegrationId: settings.defaultWritingIntegrationId === id ? next[0]?.id : settings.defaultWritingIntegrationId,
      defaultReviewIntegrationId: settings.defaultReviewIntegrationId === id ? next[0]?.id : settings.defaultReviewIntegrationId,
      azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI,
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("settings.title")}</h1>
          <p className="text-muted-foreground">{t("settings.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Cloud className="mr-1 h-3 w-3" />}
            {t("settings.syncFromDrive")}
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {t("settings.save")}
          </Button>
        </div>
      </div>

      {syncStatus === "error" && (
        <Alert variant="destructive">
          <CloudOff className="h-4 w-4" />
          <AlertDescription>{t("settings.syncError")}</AlertDescription>
        </Alert>
      )}

      {lastSynced && (
        <p className="text-xs text-muted-foreground">
          {t("settings.lastSynced")}: {new Date(lastSynced).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </p>
      )}

      <div className="space-y-3">
        {aiIntegrations.length > 0 && (
          <Section title={t("routing.title")} description={t("routing.description")} icon={<Route className="h-4 w-4 shrink-0" />}>
            <TaskRoutingBody settings={settings} patchSettings={patchSettings} />
          </Section>
        )}

        <Section title={t("settings.aiIntegrations")} description={t("settings.aiDescription")} icon={<Bot className="h-4 w-4 shrink-0" />} defaultOpen={aiIntegrations.length === 0}>
          <div className="space-y-5">
            <DefaultIntegrationSelectors
              integrations={aiIntegrations}
              defaultWriting={defaultWriting}
              defaultReview={defaultReview}
              onWritingChange={(id) => patchAi({ defaultWritingIntegrationId: id })}
              onReviewChange={(id) => patchAi({ defaultReviewIntegrationId: id })}
            />

            {aiIntegrations.length === 0 && <p className="text-sm text-muted-foreground">{t("settings.noIntegrations")}</p>}

            <div className="grid gap-3">
              {aiIntegrations.map((integration) => (
                <IntegrationAccordion
                  key={integration.id}
                  integration={integration}
                >
                  <IntegrationEditor
                    integration={integration}
                    onChange={(patch) => updateIntegration(integration.id, patch)}
                    onRemove={() => removeIntegration(integration.id)}
                  />
                </IntegrationAccordion>
              ))}
            </div>

            <Separator />

            <div className="rounded-2xl border border-dashed p-4">
              <p className="mb-3 text-sm font-medium">{t("settings.addIntegration")}</p>
              <IntegrationEditor integration={newIntegration} onChange={(patch) => setNewIntegration((current) => normalizeIntegration({ ...current, ...patch }))} />
              <Button className="mt-3" variant="outline" onClick={addIntegration} disabled={!newIntegration.name.trim()}>
                <Plus className="mr-2 h-4 w-4" />{t("settings.addIntegration")}
              </Button>
            </div>
          </div>
        </Section>

        <Section title={t("speech.title")} description={t("speech.browserOnlyDescription")} icon={<Volume2 className="h-4 w-4 shrink-0" />}>
          <SpeechCardBody settings={settings} patchSettings={patchSettings} />
        </Section>

        <Section title={t("settings.github")} description={t("settings.githubDescription")} icon={<Github className="h-4 w-4 shrink-0" />}>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="default-token">{t("settings.defaultGithubToken")}</Label>
              <Input id="default-token" type="password" placeholder="github_pat_..." value={defaultToken} onChange={(e) => setDefaultToken(e.target.value)} autoComplete="off" />
              <p className="text-xs text-muted-foreground">{t("settingsExtra.patRecommended")}</p>
            </div>

            <Separator />

            <div className="space-y-3">
              <p className="text-sm font-medium">{t("settings.additionalTokens")}</p>
              {settings.extraGitHubTokens.map((token, index) => (
                <div key={`${token.label}-${index}`} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{token.label}</p>
                    <p className="text-xs text-muted-foreground">...{token.token.slice(-4)}</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => removeExtraToken(index)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <Input placeholder={t("settingsExtra.label")} value={newTokenLabel} onChange={(e) => setNewTokenLabel(e.target.value)} />
                <Input type="password" placeholder="github_pat_..." value={newToken} onChange={(e) => setNewToken(e.target.value)} autoComplete="off" />
                <Button variant="outline" size="icon" onClick={addExtraToken} disabled={!newTokenLabel || !newToken}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </Section>

        <Section title={t("repoSettings.title")} description={t("repoSettings.description")} icon={<Route className="h-4 w-4 shrink-0" />}>
          <RepositorySettingsBody settings={settings} patchSettings={patchSettings} />
        </Section>
      </div>
    </div>
  );
}

function SpeechCardBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const browserVoices = useBrowserVoices();

  function preview() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance("Narrarium voice preview.");
    const voice = browserVoices.find((entry) => entry.name === settings.speech.ttsVoice);
    if (voice) utterance.voice = voice;
    utterance.rate = Number.isFinite(settings.speech.ttsRate) ? settings.speech.ttsRate : 0.95;
    window.speechSynthesis.speak(utterance);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-2">
        <Label>{t("speech.voice")}</Label>
        {browserVoices.length > 0 ? (
          <div className="flex gap-2">
            <Select value={settings.speech.ttsVoice} onValueChange={(value) => patchSettings({ speech: { ...settings.speech, ttsVoice: value } })}>
              <SelectTrigger className="flex-1"><SelectValue placeholder={t("speech.selectVoice")} /></SelectTrigger>
              <SelectContent>
                {browserVoices.map((voice) => (
                  <SelectItem key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} ({voice.lang})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="icon" onClick={preview}><Volume2 className="h-4 w-4" /></Button>
          </div>
        ) : (
          <Input value={settings.speech.ttsVoice} onChange={(e) => patchSettings({ speech: { ...settings.speech, ttsVoice: e.target.value } })} placeholder={t("speech.browserVoiceName")} />
        )}
      </div>
      <div className="grid gap-2">
        <Label>{t("speech.browserTtsSpeed")}</Label>
        <Input type="number" min="0.5" max="1.5" step="0.05" value={settings.speech.ttsRate} onChange={(e) => patchSettings({ speech: { ...settings.speech, ttsRate: Number(e.target.value) || 0.95 } })} />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2"><Mic className="mr-1 inline h-3 w-3" />{t("speech.routerHint")}</p>
    </div>
  );
}

function RepositorySettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const repo = settings.repository;
  const patchRepo = (patch: Partial<AppSettings["repository"]>) => patchSettings({ repository: { ...repo, ...patch } });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{t("repoSettings.autoFetchOnOpen")}</p>
          <p className="text-xs text-muted-foreground">{t("repoSettings.autoFetchOnOpenHint")}</p>
        </div>
        <Switch checked={repo.autoFetchOnOpen} onCheckedChange={(checked) => patchRepo({ autoFetchOnOpen: checked })} />
      </div>
      <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_160px] sm:items-center">
        <div>
          <p className="text-sm font-medium">{t("repoSettings.autoFetchInterval")}</p>
          <p className="text-xs text-muted-foreground">{t("repoSettings.autoFetchIntervalHint")}</p>
        </div>
        <Input type="number" min="0" step="1" value={repo.autoFetchIntervalMinutes} onChange={(event) => patchRepo({ autoFetchIntervalMinutes: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div>
          <p className="text-sm font-medium">{t("repoSettings.autoPullWhenClean")}</p>
          <p className="text-xs text-muted-foreground">{t("repoSettings.autoPullWhenCleanHint")}</p>
        </div>
        <Switch checked={repo.autoPullWhenClean} onCheckedChange={(checked) => patchRepo({ autoPullWhenClean: checked })} />
      </div>
    </div>
  );
}

function DefaultIntegrationSelectors({
  integrations,
  defaultWriting,
  defaultReview,
  onWritingChange,
  onReviewChange,
}: {
  integrations: AIIntegration[];
  defaultWriting?: string;
  defaultReview?: string;
  onWritingChange: (id: string) => void;
  onReviewChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(() => integrations.map((integration) => ({ id: integration.id, label: integration.name || integration.provider })), [integrations]);
  if (options.length === 0) return null;

  return (
    <div className="grid gap-4 rounded-2xl border bg-muted/20 p-4 sm:grid-cols-2">
      <div className="grid gap-2">
        <Label>{t("settings.defaultWriting")}</Label>
        <Select value={defaultWriting} onValueChange={onWritingChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label>{t("settings.defaultReview")}</Label>
        <Select value={defaultReview} onValueChange={onReviewChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

function hasMultimodalInput(model: GitHubCatalogModel): boolean {
  const modalities = (model.supported_input_modalities ?? []).map((entry) => entry.toLowerCase());
  return modalities.includes("text") && modalities.some((entry) => entry !== "text");
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function catalogMaxInputTokens(model: GitHubCatalogModel): number | undefined {
  return firstFiniteNumber(model.max_input_tokens, model.limits?.max_input_tokens, model.context_window, model.limits?.context_window);
}

function catalogMaxOutputTokens(model: GitHubCatalogModel): number | undefined {
  return firstFiniteNumber(model.max_output_tokens, model.limits?.max_output_tokens);
}

function IntegrationAccordion({ integration, children }: { integration: AIIntegration; children: ReactNode }) {
  const { t } = useTranslation();
  const providerLabel = PROVIDERS.find((provider) => provider.value === integration.provider)?.label ?? integration.provider;
  const modelCount = integration.chatModels?.length ?? 0;
  return (
    <details className="group rounded-2xl border bg-card shadow-sm [&[open]>summary_.chev]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="chev h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{integration.name || t("settings.unnamedIntegration")}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {providerLabel} · {t("settings.modelCount", { count: modelCount })}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-xs">{providerLabel}</Badge>
      </summary>
      <div className="border-t p-4">{children}</div>
    </details>
  );
}

function IntegrationEditor({ integration, onChange, onRemove }: { integration: AIIntegration; onChange: (patch: Partial<AIIntegration>) => void; onRemove?: () => void }) {
  const { t } = useTranslation();
  const isGithub = integration.provider === "github_models";
  const usesApiKey = integration.provider !== "m365_copilot";
  const usesEndpoint = integration.provider !== "m365_copilot" && !isGithub;
  const usesMedia = integration.provider !== "m365_copilot" && !isGithub;

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>{t("settings.integrationName")}</Label>
            <Input value={integration.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Azure OpenAI" />
          </div>
          <div className="grid gap-2">
            <Label>{t("settings.provider")}</Label>
            <Select value={integration.provider} onValueChange={(value) => onChange({ provider: value as AIProviderType })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PROVIDERS.map((provider) => <SelectItem key={provider.value} value={provider.value}>{provider.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {onRemove && (
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {usesEndpoint && (
          <div className="grid gap-2 sm:col-span-2">
            <Label>{t("settings.endpoint")}</Label>
            <Input value={integration.endpoint ?? ""} onChange={(e) => onChange({ endpoint: e.target.value })} placeholder={integration.provider === "azure_openai" ? "https://resource.openai.azure.com" : "https://api.openai.com/v1"} />
          </div>
        )}
        {usesApiKey && (
          <div className="grid gap-2">
            <Label>{isGithub ? t("settings.githubPat") : t("settings.apiKey")}</Label>
            <Input type="password" value={integration.apiKey} onChange={(e) => onChange({ apiKey: e.target.value })} autoComplete="off" placeholder={isGithub ? "ghp_… (GitHub PAT)" : undefined} />
            {isGithub && <p className="text-xs text-muted-foreground">{t("settings.githubModelsHint")}</p>}
          </div>
        )}
        {usesMedia && (
          <>
            <div className="grid gap-2">
              <Label>{t("speech.sttModel")}</Label>
              <Input value={integration.modelSpeechToText ?? ""} onChange={(e) => onChange({ modelSpeechToText: e.target.value })} placeholder="whisper-1 or deployment" />
            </div>
            <div className="grid gap-2">
              <Label>{t("speech.ttsModel")}</Label>
              <Input value={integration.modelTextToSpeech ?? ""} onChange={(e) => onChange({ modelTextToSpeech: e.target.value })} placeholder="tts-1 or deployment" />
            </div>
            <div className="grid gap-2">
              <Label>{t("images.imageModel")}</Label>
              <Input value={integration.modelImageGeneration ?? ""} onChange={(e) => onChange({ modelImageGeneration: e.target.value })} placeholder="gpt-image-1 or deployment" />
            </div>
          </>
        )}
        {integration.provider === "azure_openai" && (
          <div className="grid gap-2">
            <Label>{t("settings.apiVersion")}</Label>
            <Input value={integration.apiVersion ?? ""} onChange={(e) => onChange({ apiVersion: e.target.value })} placeholder="2024-10-21" />
          </div>
        )}
      </div>

      {integration.provider !== "m365_copilot" && (
        <ChatModelsEditor
          provider={integration.provider}
          apiKey={integration.apiKey}
          models={integration.chatModels ?? []}
          onChange={(chatModels) => onChange({ chatModels })}
        />
      )}

      {usesMedia && (
        <details className="mt-3 rounded-lg border bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("costs.mediaPricingTitle")}</summary>
          <p className="mt-1 text-xs text-muted-foreground">{t("costs.mediaPricingHint")}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <PriceField label={t("costs.priceTts")} value={integration.pricing?.ttsPerMChar} onChange={(v) => onChange({ pricing: { ...integration.pricing, ttsPerMChar: v } })} />
            <PriceField label={t("costs.priceStt")} value={integration.pricing?.sttPerHour} onChange={(v) => onChange({ pricing: { ...integration.pricing, sttPerHour: v } })} />
          </div>
          <p className="mt-3 text-xs font-medium text-muted-foreground">{t("costs.imageTokenPricing")}</p>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            <PriceField label={t("costs.priceImgInputText")} value={integration.pricing?.imageInputTextPerMTok} onChange={(v) => onChange({ pricing: { ...integration.pricing, imageInputTextPerMTok: v } })} />
            <PriceField label={t("costs.priceImgCachedText")} value={integration.pricing?.imageCachedInputTextPerMTok} onChange={(v) => onChange({ pricing: { ...integration.pricing, imageCachedInputTextPerMTok: v } })} />
            <PriceField label={t("costs.priceImgInputImage")} value={integration.pricing?.imageInputImagePerMTok} onChange={(v) => onChange({ pricing: { ...integration.pricing, imageInputImagePerMTok: v } })} />
            <PriceField label={t("costs.priceImgCachedImage")} value={integration.pricing?.imageCachedInputImagePerMTok} onChange={(v) => onChange({ pricing: { ...integration.pricing, imageCachedInputImagePerMTok: v } })} />
            <PriceField label={t("costs.priceImgOutput")} value={integration.pricing?.imageOutputPerMTok} onChange={(v) => onChange({ pricing: { ...integration.pricing, imageOutputPerMTok: v } })} />
          </div>
        </details>
      )}
      <Badge variant="secondary" className="mt-3 text-xs">{PROVIDERS.find((provider) => provider.value === integration.provider)?.label}</Badge>
    </div>
  );
}

function ChatModelsEditor({ provider, apiKey, models, onChange }: { provider: AIProviderType; apiKey: string; models: ChatModel[]; onChange: (models: ChatModel[]) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  function patchModel(id: string, patch: Partial<ChatModel>) {
    onChange(models.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }
  function toggleCapability(id: string, capability: ChatCapability) {
    onChange(models.map((m) => {
      if (m.id !== id) return m;
      const has = m.capabilities?.includes(capability);
      const capabilities = has
        ? m.capabilities.filter((c) => c !== capability)
        : [...(m.capabilities ?? []), capability];
      return { ...m, capabilities };
    }));
  }
  function addModel() {
    onChange([...models, { id: crypto.randomUUID(), name: "", capabilities: models.length === 0 ? ["default", "copilot", "simple-tasks", "review"] : [] }]);
  }
  function removeModel(id: string) {
    onChange(models.filter((m) => m.id !== id));
  }

  async function loadCatalog() {
    if (!apiKey.trim()) { toast({ title: t("settings.githubPatMissing"), variant: "destructive" }); return; }
    setLoadingCatalog(true);
    try {
      const catalog = await fetchGitHubModelsCatalog(apiKey.trim());
      const existing = new Set(models.map((m) => m.name));
      const added: ChatModel[] = catalog
        .filter((c) => c.id && hasMultimodalInput(c) && !existing.has(c.id))
        .map((c) => ({
          id: crypto.randomUUID(),
          name: c.id,
          capabilities: [],
          tier: c.rate_limit_tier,
          maxInputTokens: catalogMaxInputTokens(c),
          maxOutputTokens: catalogMaxOutputTokens(c),
        }));
      if (models.length === 0 && added.length) {
        added[0].capabilities = ["default", "copilot", "simple-tasks", "review"];
      }
      if (!added.length) { toast({ title: t("settings.catalogNoNew") }); return; }
      onChange([...models, ...added]);
      toast({ title: t("settings.catalogLoaded", { count: added.length }) });
    } catch (err) {
      toast({ title: t("settings.catalogFailed"), description: String(err), variant: "destructive" });
    } finally {
      setLoadingCatalog(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border bg-muted/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t("settings.chatModels")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.chatModelsHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          {provider === "github_models" && (
            <Button type="button" variant="outline" size="sm" disabled={loadingCatalog} onClick={() => void loadCatalog()}>
              {loadingCatalog ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
              {t("settings.loadCatalogModels")}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={addModel}>
            <Plus className="mr-1 h-3.5 w-3.5" />{t("settings.addChatModel")}
          </Button>
        </div>
      </div>
      {models.length === 0 && <p className="text-xs text-muted-foreground">{t("settings.noChatModels")}</p>}
      <div className="space-y-3">
        {models.map((model) => (
          <div key={model.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <Label className="text-xs">{t("settings.chatModelName")}</Label>
                <Input value={model.name} onChange={(e) => patchModel(model.id, { name: e.target.value })} placeholder="gpt-4o" className="h-8 text-sm" />
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeModel(model.id)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {provider === "github_models" && (
                <div className="grid gap-1">
                  <Label className="text-xs">{t("settings.modelTier")}</Label>
                  <Input value={model.tier ?? ""} onChange={(e) => patchModel(model.id, { tier: e.target.value.trim() || undefined })} placeholder="low / standard / high" className="h-8 text-sm" />
                </div>
              )}
              <TokenLimitField label={t("settings.maxInputTokens")} value={model.maxInputTokens} onChange={(v) => patchModel(model.id, { maxInputTokens: v })} />
              <TokenLimitField label={t("settings.maxOutputTokens")} value={model.maxOutputTokens} onChange={(v) => patchModel(model.id, { maxOutputTokens: v })} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHAT_CAPABILITIES.map((capability) => {
                const active = model.capabilities?.includes(capability);
                return (
                  <button
                    key={capability}
                    type="button"
                    onClick={() => toggleCapability(model.id, capability)}
                    className={active
                      ? "rounded-full border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                      : "rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"}
                  >
                    {t(`settings.capability.${capability}`)}
                  </button>
                );
              })}
            </div>
            <details className="mt-2 rounded-md border bg-muted/20 p-2">
              <summary className="cursor-pointer text-xs font-medium">{t("costs.chatPricingTitle")}</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <PriceField label={t("costs.priceInput")} value={model.pricing?.inputPerMTok} onChange={(v) => patchModel(model.id, { pricing: { ...model.pricing, inputPerMTok: v } })} />
                <PriceField label={t("costs.priceCached")} value={model.pricing?.cachedPerMTok} onChange={(v) => patchModel(model.id, { pricing: { ...model.pricing, cachedPerMTok: v } })} />
                <PriceField label={t("costs.priceOutput")} value={model.pricing?.outputPerMTok} onChange={(v) => patchModel(model.id, { pricing: { ...model.pricing, outputPerMTok: v } })} />
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

function PriceField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === "" ? undefined : Number(raw));
        }}
        placeholder="0"
        className="h-8 text-sm"
      />
    </div>
  );
}

function TokenLimitField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const next = raw === "" ? undefined : Math.max(0, Math.floor(Number(raw)));
          onChange(Number.isFinite(next) ? next : undefined);
        }}
        placeholder="0"
        className="h-8 text-sm"
      />
    </div>
  );
}

function createBlankIntegration(): AIIntegration {
  return {
    id: crypto.randomUUID(),
    name: "",
    provider: "azure_openai",
    endpoint: "",
    apiKey: "",
    chatModels: [
      { id: crypto.randomUUID(), name: "gpt-4o", capabilities: ["default", "copilot", "simple-tasks", "review"] },
    ],
    modelSpeechToText: "",
    modelTextToSpeech: "",
    modelImageGeneration: "gpt-image-1",
    apiVersion: "2024-10-21",
  };
}

function normalizeIntegration(integration: AIIntegration): AIIntegration {
  if (integration.provider === "m365_copilot") {
    return { ...integration, endpoint: "", apiKey: "", chatModels: [], modelWriting: "", modelReview: "", modelImageGeneration: "", apiVersion: "" };
  }
  if (integration.provider === "github_models") {
    // OpenAI-compatible, LLM-only: fixed baseURL, no version, no media models. Keep PAT + chatModels.
    return { ...integration, endpoint: "", apiVersion: "", modelSpeechToText: "", modelTextToSpeech: "", modelImageGeneration: "" };
  }
  if (integration.provider === "openai") {
    return { ...integration, apiVersion: "" };
  }
  return { ...integration, apiVersion: integration.apiVersion || "2024-10-21" };
}

function integrationToAzureCompat(integrations: AIIntegration[]): AppSettings["azureOpenAI"] | null {
  const azure = integrations.find((integration) => integration.provider === "azure_openai");
  if (!azure) return null;
  const defaultModel = azure.chatModels?.find((m) => m.capabilities?.includes("default"))?.name
    ?? azure.chatModels?.[0]?.name
    ?? azure.modelWriting
    ?? "gpt-4o";
  return {
    endpoint: azure.endpoint ?? "",
    apiKey: azure.apiKey,
    model: defaultModel,
    apiVersion: azure.apiVersion || "2024-10-21",
  };
}

// ─── Task routing ─────────────────────────────────────────────────────────────

const MEDIA_TASKS = new Set<RoutingTaskKind>(["tts", "stt", "image"]);

function isMediaTask(task: RoutingTaskKind): boolean {
  return MEDIA_TASKS.has(task);
}

interface IntegrationChoice { id: string; label: string; }

/** Integration options for a task's selects, including a "Browser" pseudo-entry for tts/stt. */
function taskIntegrationChoices(integrations: AIIntegration[], task: RoutingTaskKind, t: (k: string) => string): IntegrationChoice[] {
  const choices: IntegrationChoice[] = [];
  if (task === "tts" || task === "stt") choices.push({ id: BROWSER_ROUTING_ID, label: t("routing.browser") });
  const list = isMediaTask(task)
    ? integrations.filter((i) => i.provider === "openai" || i.provider === "azure_openai")
    : integrations.filter((i) => i.provider !== "m365_copilot");
  for (const i of list) choices.push({ id: i.id, label: i.name || i.provider });
  return choices;
}

/** Model options for a given selected integrationId + task. Browser → ["browser"]. */
function modelChoicesFor(integrations: AIIntegration[], integrationId: string | undefined, task: RoutingTaskKind): string[] {
  if (integrationId === BROWSER_ROUTING_ID) return ["browser"];
  const integration = integrations.find((i) => i.id === integrationId);
  if (!integration) return [];
  if (!isMediaTask(task)) return integrationChatModels(integration).map((m) => m.name).filter(Boolean);
  const media = task === "tts" ? integration.modelTextToSpeech
    : task === "stt" ? integration.modelSpeechToText
    : integration.modelImageGeneration;
  return media?.trim() ? [media.trim()] : [];
}

function TaskRoutingBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const integrations = settings.aiIntegrations ?? [];
  const routing = settings.taskRouting ?? {};

  function setRoute(task: RoutingTaskKind, route: TaskRoute | undefined) {
    const next: NonNullable<AppSettings["taskRouting"]> = { ...routing };
    if (route && (route.primary || route.fallbacks.length)) next[task] = route;
    else delete next[task];
    patchSettings({ taskRouting: next });
  }

  return (
    <div className="space-y-4">
      {ROUTING_TASKS.map((task) => (
        <TaskRouteEditor
          key={task}
          task={task}
          integrations={integrations}
          route={routing[task]}
          onChange={(route) => setRoute(task, route)}
        />
      ))}
    </div>
  );
}

function TaskRouteEditor({ task, integrations, route, onChange }: { task: RoutingTaskKind; integrations: AIIntegration[]; route?: TaskRoute; onChange: (route: TaskRoute | undefined) => void }) {
  const { t } = useTranslation();
  const current: TaskRoute = route ?? { primary: undefined, fallbacks: [] };
  const firstChoice = taskIntegrationChoices(integrations, task, t)[0];

  function setPrimary(target: RoutingTarget | undefined) {
    onChange({ ...current, primary: target });
  }
  function setFallback(index: number, target: RoutingTarget | undefined) {
    const fallbacks = [...current.fallbacks];
    if (target) fallbacks[index] = target; else fallbacks.splice(index, 1);
    onChange({ ...current, fallbacks });
  }
  function addFallback() {
    const model = modelChoicesFor(integrations, firstChoice?.id, task)[0] ?? "";
    onChange({ ...current, fallbacks: [...current.fallbacks, { integrationId: firstChoice?.id ?? "", model }] });
  }

  const label = t(`routing.task.${task}`);

  return (
    <div className="rounded-lg border bg-muted/10 p-3">
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="grid gap-2">
        <div className="grid gap-1">
          <Label className="text-xs">{t("routing.primary")}</Label>
          <TargetRow task={task} integrations={integrations} target={current.primary} onChange={setPrimary} clearable />
        </div>
        {current.fallbacks.map((fb, i) => (
          <div key={i} className="grid gap-1">
            <Label className="text-xs">{t("routing.fallbackN", { n: i + 1 })}</Label>
            <TargetRow task={task} integrations={integrations} target={fb} onChange={(t2) => setFallback(i, t2)} clearable onRemove={() => setFallback(i, undefined)} />
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={addFallback} disabled={!current.primary}>
          <Plus className="mr-1 h-3.5 w-3.5" />{t("routing.addFallback")}
        </Button>
      </div>
    </div>
  );
}

function TargetRow({ task, integrations, target, onChange, clearable, onRemove }: { task: RoutingTaskKind; integrations: AIIntegration[]; target?: RoutingTarget; onChange: (target: RoutingTarget | undefined) => void; clearable?: boolean; onRemove?: () => void }) {
  const { t } = useTranslation();
  const integrationChoices = taskIntegrationChoices(integrations, task, t);
  const models = modelChoicesFor(integrations, target?.integrationId, task);
  const browserSelected = target?.integrationId === BROWSER_ROUTING_ID;

  return (
    <div className="flex items-center gap-2">
      <Select
        value={target?.integrationId ?? ""}
        onValueChange={(integrationId) => {
          const firstModel = modelChoicesFor(integrations, integrationId, task)[0] ?? "";
          onChange({ integrationId, model: firstModel });
        }}
      >
        <SelectTrigger className="h-8 flex-1 text-sm"><SelectValue placeholder={t("routing.pickIntegration")} /></SelectTrigger>
        <SelectContent>{integrationChoices.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
      </Select>
      {browserSelected ? (
        <div className="h-8 flex-1 rounded-md border bg-muted/40 px-3 text-sm leading-8 text-muted-foreground">{t("routing.browser")}</div>
      ) : (
        <Select
          value={target?.model ?? ""}
          onValueChange={(model) => target && onChange({ ...target, model })}
        >
          <SelectTrigger className="h-8 flex-1 text-sm"><SelectValue placeholder={t("routing.pickModel")} /></SelectTrigger>
          <SelectContent>
            {models.length === 0 ? (
              <SelectItem value="__none__" disabled>{t("routing.noModel")}</SelectItem>
            ) : models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {clearable && target && (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => (onRemove ? onRemove() : onChange(undefined))}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}
