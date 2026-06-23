import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Cloud, CloudOff, Github, Loader2, Mic, Plus, Trash2, Volume2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { AIIntegration, AIProviderType, AppSettings } from "@/types/settings";

const PROVIDERS: Array<{ value: AIProviderType; label: string }> = [
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "openai", label: "OpenAI / compatible" },
  { value: "m365_copilot", label: "Microsoft 365 Copilot" },
];

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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Volume2 className="h-4 w-4" />Speech</CardTitle>
          <CardDescription>Choose browser or configured AI models for speech-to-text and text-to-speech.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>Speech-to-text</Label>
            <Select value={settings.speech.sttProvider} onValueChange={(value) => patchSettings({ speech: { ...settings.speech, sttProvider: value as "browser" | "ai" } })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="browser">Browser microphone</SelectItem>
                <SelectItem value="ai">AI transcription model</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Text-to-speech</Label>
            <Select value={settings.speech.ttsProvider} onValueChange={(value) => patchSettings({ speech: { ...settings.speech, ttsProvider: value as "browser" | "ai" } })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="browser">Browser voice</SelectItem>
                <SelectItem value="ai">AI TTS model</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Voice</Label>
            <Input value={settings.speech.ttsVoice} onChange={(e) => patchSettings({ speech: { ...settings.speech, ttsVoice: e.target.value } })} placeholder="nova or browser voice name" />
          </div>
          <div className="grid gap-2">
            <Label>Browser TTS speed</Label>
            <Input type="number" min="0.5" max="1.5" step="0.05" value={settings.speech.ttsRate} onChange={(e) => patchSettings({ speech: { ...settings.speech, ttsRate: Number(e.target.value) || 0.95 } })} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2"><Mic className="mr-1 inline h-3 w-3" />AI STT/TTS uses the STT/TTS model fields configured on the default writing integration. Copilot/M365 does not provide STT/TTS.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Github className="h-4 w-4" />{t("settings.github")}</CardTitle>
          <CardDescription>{t("settings.githubDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="default-token">{t("settings.defaultGithubToken")}</Label>
            <Input id="default-token" type="password" placeholder="github_pat_..." value={defaultToken} onChange={(e) => setDefaultToken(e.target.value)} autoComplete="off" />
            <p className="text-xs text-muted-foreground">PAT with Contents read/write and Metadata read permissions is recommended.</p>
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
              <Input placeholder="Label" value={newTokenLabel} onChange={(e) => setNewTokenLabel(e.target.value)} />
              <Input type="password" placeholder="github_pat_..." value={newToken} onChange={(e) => setNewToken(e.target.value)} autoComplete="off" />
              <Button variant="outline" size="icon" onClick={addExtraToken} disabled={!newTokenLabel || !newToken}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Bot className="h-4 w-4" />{t("settings.aiIntegrations")}</CardTitle>
          <CardDescription>{t("settings.aiDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
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
              <IntegrationEditor
                key={integration.id}
                integration={integration}
                onChange={(patch) => updateIntegration(integration.id, patch)}
                onRemove={() => removeIntegration(integration.id)}
              />
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
        </CardContent>
      </Card>
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

function IntegrationEditor({ integration, onChange, onRemove }: { integration: AIIntegration; onChange: (patch: Partial<AIIntegration>) => void; onRemove?: () => void }) {
  const { t } = useTranslation();
  const usesApiKey = integration.provider !== "m365_copilot";
  const usesEndpoint = integration.provider !== "m365_copilot";

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
            <Label>{t("settings.apiKey")}</Label>
            <Input type="password" value={integration.apiKey} onChange={(e) => onChange({ apiKey: e.target.value })} autoComplete="off" />
          </div>
        )}
        <div className="grid gap-2">
          <Label>{t("settings.chatModel")}</Label>
          <Input value={integration.modelWriting ?? ""} onChange={(e) => onChange({ modelWriting: e.target.value })} placeholder="gpt-4o" disabled={integration.provider === "m365_copilot"} />
        </div>
        {integration.provider !== "m365_copilot" && (
          <>
            <div className="grid gap-2">
              <Label>STT model</Label>
              <Input value={integration.modelSpeechToText ?? ""} onChange={(e) => onChange({ modelSpeechToText: e.target.value })} placeholder="whisper-1 or deployment" />
            </div>
            <div className="grid gap-2">
              <Label>TTS model</Label>
              <Input value={integration.modelTextToSpeech ?? ""} onChange={(e) => onChange({ modelTextToSpeech: e.target.value })} placeholder="tts-1 or deployment" />
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
      <Badge variant="secondary" className="mt-3 text-xs">{PROVIDERS.find((provider) => provider.value === integration.provider)?.label}</Badge>
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
    modelWriting: "gpt-4o",
    modelReview: "gpt-4o",
    modelSpeechToText: "",
    modelTextToSpeech: "",
    apiVersion: "2024-10-21",
  };
}

function normalizeIntegration(integration: AIIntegration): AIIntegration {
  if (integration.provider === "m365_copilot") {
    return { ...integration, endpoint: "", apiKey: "", modelWriting: "", modelReview: "", apiVersion: "" };
  }
  if (integration.provider === "openai") {
    return { ...integration, apiVersion: "" };
  }
  return { ...integration, apiVersion: integration.apiVersion || "2024-10-21" };
}

function integrationToAzureCompat(integrations: AIIntegration[]): AppSettings["azureOpenAI"] | null {
  const azure = integrations.find((integration) => integration.provider === "azure_openai");
  if (!azure) return null;
  return {
    endpoint: azure.endpoint ?? "",
    apiKey: azure.apiKey,
    model: azure.modelWriting || "gpt-4o",
    apiVersion: azure.apiVersion || "2024-10-21",
  };
}
