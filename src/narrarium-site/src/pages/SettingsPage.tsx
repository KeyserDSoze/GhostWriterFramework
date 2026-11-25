import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Bot, ChevronRight, Cloud, CloudOff, Download, Github, Loader2, Mic, Plug, Plus, Route, Search, Server, Trash2, Volume2, Wand2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { PersonalServerSettingsBody } from "@/components/settings/PersonalServerSettingsBody";
import { IntegrationRequestFields } from "@/components/settings/IntegrationRequestFields";
import { ReasoningParameterField } from "@/components/settings/ReasoningParameterField";
import { EndpointTools } from "@/components/settings/endpoint/EndpointTools";
import { integrationAnchor } from "@/components/settings/endpoint/anchor";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { fetchGitHubModelsCatalog, type GitHubCatalogModel } from "@/github/githubModelsCatalog";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModel } from "@/ai/openaiModelsCatalog";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { CHAT_CAPABILITIES, DEFAULT_SETTINGS, type AIIntegration, type AIProviderType, type AppSettings, type ChatCapability, type ChatModel } from "@/types/settings";
import { reconcileTaskRouting, routingIssues } from "@/assistant/router";
import { DeepSearchSettingsBody } from "@/components/settings/DeepSearchSettingsBody";
import { CopilotToolsSettingsBody } from "@/components/settings/CopilotToolsSettingsBody";
import { useNavigationHistoryStore } from "@/store/navigationHistoryStore";
import { clearFallbackAcknowledgements } from "@/assistant/fallbackDisclosure";
import { RouterRunNote } from "@/components/settings/router/RouterRunNote";
import { RouterSections } from "@/components/settings/router/RouterSections";
import { ToolsOnlyField } from "@/components/settings/router/ToolsOnlyField";
import { SettingsSaveBar } from "@/components/settings/SettingsSaveBar";

/** How long the bar of the settings says that a save is done before it goes away. */
const SAVED_NOTICE_MS = 4000;

const PROVIDERS: Array<{ value: AIProviderType; labelKey: string; fallback: string }> = [
  { value: "azure_openai", labelKey: "settings.providers.azure_openai", fallback: "Azure OpenAI" },
  { value: "openai", labelKey: "settings.providers.openai", fallback: "OpenAI / compatible" },
  { value: "github_models", labelKey: "settings.providers.github_models", fallback: "GitHub Models" },
  { value: "m365_copilot", labelKey: "settings.providers.m365_copilot", fallback: "Microsoft 365 Copilot" },
];

const COST_CURRENCIES = [
  { value: "USD", labelKey: "settings.currencies.USD", fallback: "USD — US Dollar" },
  { value: "EUR", labelKey: "settings.currencies.EUR", fallback: "EUR — Euro" },
  { value: "GBP", labelKey: "settings.currencies.GBP", fallback: "GBP — British Pound" },
  { value: "JPY", labelKey: "settings.currencies.JPY", fallback: "JPY — Japanese Yen" },
  { value: "CHF", labelKey: "settings.currencies.CHF", fallback: "CHF — Swiss Franc" },
  { value: "CAD", labelKey: "settings.currencies.CAD", fallback: "CAD — Canadian Dollar" },
  { value: "AUD", labelKey: "settings.currencies.AUD", fallback: "AUD — Australian Dollar" },
] as const;

function providerLabel(t: ReturnType<typeof useTranslation>["t"], value: AIProviderType): string {
  const provider = PROVIDERS.find((entry) => entry.value === value);
  return provider ? t(provider.labelKey, { defaultValue: provider.fallback }) : value;
}

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
function Section({ title, description, icon, defaultOpen, contentClassName = "px-6 pb-6", children }: { title: string; description?: string; icon?: ReactNode; defaultOpen?: boolean; contentClassName?: string; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-xl border border-layer bg-card text-card-foreground shadow-sm [&[open]>summary_.chev]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="chev h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
        {icon}
        <div className="min-w-0">
          <p className="font-semibold leading-none">{title}</p>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
      </summary>
      <div className={contentClassName}>{children}</div>
    </details>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const location = useLocation();
  const previousPath = useNavigationHistoryStore((s) => s.previous?.pathname);
  const { settings, patchSettings, offlineConflict } = useSettingsStore();
  const { save, syncStatus, lastSynced, load, resolveOfflineConflict } = useSettings();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  const section = currentSettingsSection(location.pathname);
  useEffect(() => {
    // The app's <main> keeps its scroll offset between pages, and the AI pages link to each other from their bottom.
    document.querySelector("main")?.scrollTo?.({ top: 0 });
  }, [section]);

  // What is saved, to tell the changes from it: the settings as they were last loaded from the disk or saved.
  const current = useMemo(() => JSON.stringify(settings), [settings]);
  const [savedSettings, setSavedSettings] = useState(current);
  const markSaved = useCallback(() => setSavedSettings(JSON.stringify(useSettingsStore.getState().settings)), []);
  const reload = useCallback(() => Promise.resolve(load()).then(markSaved), [load, markSaved]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const changed = current !== savedSettings;
  useEffect(() => { setSaveError(null); }, [current]);
  useEffect(() => {
    if (!justSaved) return undefined;
    const timer = window.setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);
  const [column, setColumn] = useState<HTMLDivElement | null>(null);

  const didAutoLoad = useRef(false);
  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    void reload();
  }, [reload]);

  const [defaultToken, setDefaultToken] = useState(settings.defaultGitHubToken);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [newIntegration, setNewIntegration] = useState<AIIntegration>(() => createBlankIntegration());
  const currencyId = useId();

  useEffect(() => {
    setDefaultToken(settings.defaultGitHubToken);
  }, [settings.defaultGitHubToken]);

  const isSaving = syncStatus === "saving";
  const isLoading = syncStatus === "loading";
  const aiIntegrations = settings.aiIntegrations ?? [];
  const defaultWriting = settings.defaultWritingIntegrationId ?? aiIntegrations[0]?.id;
  const defaultReview = settings.defaultReviewIntegrationId ?? aiIntegrations[0]?.id;
  const brokenRoutes = routingIssues(settings.taskRouting, aiIntegrations);

  async function handleSave() {
    if (offlineConflict) return;
    if (brokenRoutes.length) {
      toast({ title: t("routing.invalidSave"), variant: "destructive" });
      return;
    }
    const azureOpenAI = integrationToAzureCompat(aiIntegrations) ?? settings.azureOpenAI;
    patchSettings({ defaultGitHubToken: defaultToken, azureOpenAI });
    setSaving(true);
    setJustSaved(false);
    try {
      await save();
      markSaved();
      setSaveError(null);
      setJustSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      setSaving(false);
    }
  }

  function patchAi(patch: Partial<AppSettings>) { patchSettings(patch); }
  function addExtraToken() {
    if (!newTokenLabel || !newToken) return;
    patchSettings({ extraGitHubTokens: [...settings.extraGitHubTokens, { label: newTokenLabel, token: newToken }] });
    setNewTokenLabel("");
    setNewToken("");
  }
  function removeExtraToken(index: number) {
    if (!window.confirm(t("settings.confirmRemoveToken"))) return;
    patchSettings({ extraGitHubTokens: settings.extraGitHubTokens.filter((_, i) => i !== index) });
  }
  function addIntegration() {
    const candidate = normalizeIntegration(newIntegration);
    if (!candidate.name.trim()) return;
    const next = [...aiIntegrations, candidate];
    patchAi({ aiIntegrations: next, defaultWritingIntegrationId: defaultWriting ?? candidate.id, defaultReviewIntegrationId: defaultReview ?? candidate.id, azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI });
    setNewIntegration(createBlankIntegration());
  }
  function updateIntegration(id: string, patch: Partial<AIIntegration>) {
    const next = aiIntegrations.map((integration) => integration.id === id ? normalizeIntegration({ ...integration, ...patch }) : integration);
    patchAi({ aiIntegrations: next, taskRouting: reconcileTaskRouting(settings.taskRouting, aiIntegrations, next), azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI });
  }
  function removeIntegration(id: string) {
    if (!window.confirm(t("settings.confirmRemoveIntegration"))) return;
    const next = aiIntegrations.filter((integration) => integration.id !== id);
    patchAi({
      aiIntegrations: next,
      taskRouting: reconcileTaskRouting(settings.taskRouting, aiIntegrations, next),
      defaultWritingIntegrationId: settings.defaultWritingIntegrationId === id ? next[0]?.id : settings.defaultWritingIntegrationId,
      defaultReviewIntegrationId: settings.defaultReviewIntegrationId === id ? next[0]?.id : settings.defaultReviewIntegrationId,
      azureOpenAI: integrationToAzureCompat(next) ?? settings.azureOpenAI,
    });
  }

  const sectionMeta = settingsSectionMeta(t, section);
  const busy = saving || isSaving;
  const barState = busy ? "saving" : saveError ? "failed" : changed ? "unsaved" : "saved";
  const showBar = section !== "home" && (changed || busy || Boolean(saveError) || justSaved);

  return (
    <div ref={setColumn} className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            {section !== "home" && (
              <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to="/app/settings">{t("common.back")}</Link></Button>
            )}
            {section !== "home" && previousPath && previousPath !== location.pathname && (
              <Button asChild variant="outline" size="sm"><Link to={previousPath}>{t("quickSwitch.backToPrevious")}</Link></Button>
            )}
          </div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{sectionMeta.title}</h1>
          <p className="text-muted-foreground">{sectionMeta.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Cloud className="mr-1 h-3 w-3" />}
            {t("settings.syncFromDrive")}
          </Button>
          <Button asChild variant="outline" size="sm"><Link to="/app/account-sync">{t("nav.accountSync")}</Link></Button>
          {section !== "home" && (
            <Button size="sm" onClick={() => void handleSave()} disabled={isSaving || brokenRoutes.length > 0 || Boolean(offlineConflict)}>
              {isSaving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {t("settings.save")}
            </Button>
          )}
        </div>
      </div>

      {syncStatus === "error" && <Alert variant="destructive"><CloudOff className="h-4 w-4" /><AlertDescription>{t("settings.syncError")}</AlertDescription></Alert>}
      {offline && <Alert><CloudOff className="h-4 w-4" /><AlertDescription id="offline-settings-explanation">{t("settings.offlineExplanation")}</AlertDescription></Alert>}
      {offlineConflict && <Alert variant="destructive"><CloudOff className="h-4 w-4" /><AlertDescription className="space-y-3"><p>{t("settings.offlineConflict", { fields: offlineConflict.changedKeys.join(", ") })}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="destructive" onClick={() => void resolveOfflineConflict("local")}>{t("settings.keepOfflineChanges")}</Button><Button size="sm" variant="outline" onClick={() => void resolveOfflineConflict("cloud")}>{t("settings.useCloudSettings")}</Button></div></AlertDescription></Alert>}
      {brokenRoutes.length > 0 && (
        <Alert variant="destructive">
          <Route className="h-4 w-4" />
          <AlertDescription>
            <p>{t("routing.invalidSave")}</p>
            {brokenRoutes.map((issue, index) => <p key={`${issue.task}-${issue.target.integrationId}-${issue.target.model}-${index}`} className="mt-1 text-xs">{t(`routing.task.${issue.task}`)}: {issue.message}</p>)}
          </AlertDescription>
        </Alert>
      )}
      {lastSynced && <p className="text-xs text-muted-foreground">{t("settings.lastSynced")}: {new Date(lastSynced).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>}

      {section === "home" ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <SettingsCard href="/app/settings/ai-integrations" title={t("settingsSection.aiIntegrationsTitle")} description={t("settingsSection.aiIntegrationsDescription")} icon={<Plug className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/ai-router" title={t("settingsSection.aiRouterTitle")} description={t("settingsSection.aiRouterDescription")} icon={<Bot className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/deep-search" title={t("settingsSection.deepSearchTitle")} description={t("settingsSection.deepSearchDescription")} icon={<Search className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/tools" title={t("settingsSection.copilotToolsTitle")} description={t("settingsSection.copilotToolsDescription")} icon={<Wand2 className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/github" title={t("settings.github")} description={t("settings.githubDescription")} icon={<Github className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/speech" title={t("speech.title")} description={t("speech.browserOnlyDescription")} icon={<Volume2 className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/repository" title={t("repoSettings.title")} description={t("repoSettings.description")} icon={<Route className="h-5 w-5" />} />
          <SettingsCard href="/app/settings/server" title={t("personalServer.title")} description={t("personalServer.description")} icon={<Server className="h-5 w-5" />} />
        </div>
      ) : section === "ai-integrations" ? (
        // The two AI pages share one mounted SettingsPage (router.tsx): keyed, so nothing of one carries over to the other.
        <fieldset className="min-w-0 space-y-3" aria-describedby={offline ? "offline-settings-explanation" : undefined} key="ai-integrations">
          <Section title={t("settings.aiIntegrations")} description={t("settings.aiDescription")} icon={<Plug className="h-4 w-4 shrink-0" />} defaultOpen>
            <div className="space-y-5">
              <DefaultIntegrationSelectors integrations={aiIntegrations} defaultWriting={defaultWriting} defaultReview={defaultReview} onWritingChange={(id) => patchAi({ defaultWritingIntegrationId: id })} onReviewChange={(id) => patchAi({ defaultReviewIntegrationId: id })} />
              <div className="grid gap-2 sm:max-w-xs">
                <Label htmlFor={currencyId}>{t("settings.costCurrency")}</Label>
                <Select value={settings.costCurrency || "USD"} onValueChange={(value) => patchSettings({ costCurrency: value })}>
                  <SelectTrigger id={currencyId} aria-describedby={`${currencyId}-hint`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COST_CURRENCIES.map((currency) => (
                      <SelectItem key={currency.value} value={currency.value}>
                        {t(currency.labelKey, { defaultValue: currency.fallback })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id={`${currencyId}-hint`} className="text-xs text-muted-foreground">{t("settings.costCurrencyHint")}</p>
              </div>
              {aiIntegrations.length === 0 && <p className="text-sm text-muted-foreground">{t("settings.noIntegrations")}</p>}
              <div className="grid gap-3">{aiIntegrations.map((integration) => <IntegrationAccordion key={integration.id} integration={integration}><IntegrationEditor integration={integration} onChange={(patch) => updateIntegration(integration.id, patch)} onRemove={() => removeIntegration(integration.id)} credentialsDisabled={false} /></IntegrationAccordion>)}</div>
              <Separator />
              <div className="rounded-2xl border border-dashed p-4">
                <p className="mb-3 text-sm font-medium">{t("settings.addIntegration")}</p>
                <IntegrationEditor integration={newIntegration} onChange={(patch) => setNewIntegration((current) => normalizeIntegration({ ...current, ...patch }))} credentialsDisabled={false} />
                <Button className="mt-3" variant="outline" onClick={addIntegration} disabled={!newIntegration.name.trim()}><Plus className="mr-2 h-4 w-4" />{t("settings.addIntegration")}</Button>
              </div>
            </div>
          </Section>
          {aiIntegrations.length > 0 && (
            <div className="flex justify-end pb-12">
              <Button asChild variant="outline" className="h-auto whitespace-normal py-2 text-left"><Link to="/app/settings/ai-router">{t("settings.nextRouteTasks")}<ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
            </div>
          )}
        </fieldset>
      ) : section === "ai-router" ? (
        <fieldset className="min-w-0 space-y-3" aria-describedby={offline ? "offline-settings-explanation" : undefined} key="ai-router">
          {aiIntegrations.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">{t("routing.modelsFromIntegrations")} <Link to="/app/settings/ai-integrations" className="font-medium text-primary underline underline-offset-2">{t("settingsSection.aiIntegrationsTitle")}</Link>.</p>
              <Section title={t("routing.title")} description={t("routing.description")} icon={<Route className="h-4 w-4 shrink-0" />} defaultOpen contentClassName="px-3 pb-4 sm:px-4"><TaskRoutingBody settings={settings} patchSettings={patchSettings} /></Section>
            </>
          ) : (
            <RoutingEmptyState />
          )}
        </fieldset>
      ) : section === "deep-search" ? (
        <Section title={t("settingsSection.deepSearchTitle")} description={t("settingsSection.deepSearchDescription")} icon={<Search className="h-4 w-4 shrink-0" />} defaultOpen>
          <fieldset aria-describedby={offline ? "offline-settings-explanation" : undefined}><DeepSearchSettingsBody settings={settings} patchSettings={patchSettings} credentialsDisabled={false} /></fieldset>
        </Section>
      ) : section === "tools" ? (
        <Section title={t("settingsSection.copilotToolsTitle")} description={t("settingsSection.copilotToolsDescription")} icon={<Wand2 className="h-4 w-4 shrink-0" />} defaultOpen>
          <CopilotToolsSettingsBody settings={settings} patchSettings={patchSettings} />
        </Section>
      ) : section === "github" ? (
        <Section title={t("settings.github")} description={t("settings.githubDescription")} icon={<Github className="h-4 w-4 shrink-0" />} defaultOpen>
          <fieldset className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="default-token">{t("settings.defaultGithubToken")}</Label>
              <Input id="default-token" type="password" placeholder="github_pat_..." value={defaultToken} onChange={(e) => { setDefaultToken(e.target.value); patchSettings({ defaultGitHubToken: e.target.value }); }} autoComplete="off" />
              <p className="text-xs text-muted-foreground">{t("settingsExtra.patRecommended")}</p>
            </div>
            <Separator />
            <div className="space-y-3">
              <p className="text-sm font-medium">{t("settings.additionalTokens")}</p>
              {settings.extraGitHubTokens.map((token, index) => <div key={`${token.label}-${index}`} className="flex items-center justify-between rounded-md border px-3 py-2"><div><p className="text-sm font-medium">{token.label}</p><p className="text-xs text-muted-foreground">...{token.token.slice(-4)}</p></div><Button variant="ghost" size="icon" onClick={() => removeExtraToken(index)} aria-label={t("settings.removeToken", { name: token.label })}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>)}
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]"><Input placeholder={t("settingsExtra.label")} value={newTokenLabel} onChange={(e) => setNewTokenLabel(e.target.value)} /><Input type="password" placeholder="github_pat_..." value={newToken} onChange={(e) => setNewToken(e.target.value)} autoComplete="off" /><Button variant="outline" size="icon" onClick={addExtraToken} disabled={!newTokenLabel || !newToken}><Plus className="h-4 w-4" /></Button></div>
            </div>
          </fieldset>
        </Section>
      ) : section === "speech" ? (
        <Section title={t("speech.title")} description={t("speech.browserOnlyDescription")} icon={<Volume2 className="h-4 w-4 shrink-0" />} defaultOpen><SpeechCardBody settings={settings} patchSettings={patchSettings} /></Section>
      ) : section === "server" ? (
        <Section title={t("personalServer.title")} description={t("personalServer.description")} icon={<Server className="h-4 w-4 shrink-0" />} defaultOpen><PersonalServerSettingsBody settings={settings} patchSettings={patchSettings} onSave={handleSave} /></Section>
      ) : (
        <Section title={t("repoSettings.title")} description={t("repoSettings.description")} icon={<Route className="h-4 w-4 shrink-0" />} defaultOpen><RepositorySettingsBody settings={settings} patchSettings={patchSettings} /></Section>
      )}
      {showBar && (
        <SettingsSaveBar
          anchor={column}
          state={barState}
          reason={saveError ?? undefined}
          canSave={changed && !busy && brokenRoutes.length === 0 && !offlineConflict}
          onSave={() => void handleSave()}
        />
      )}
    </div>
  );
}

function currentSettingsSection(pathname: string): "home" | "ai-integrations" | "ai-router" | "deep-search" | "tools" | "github" | "speech" | "repository" | "server" {
  if (/\/app\/settings\/ai-integrations$/.test(pathname)) return "ai-integrations";
  if (/\/app\/settings\/ai-router$/.test(pathname)) return "ai-router";
  if (/\/app\/settings\/deep-search$/.test(pathname)) return "deep-search";
  if (/\/app\/settings\/tools$/.test(pathname)) return "tools";
  if (/\/app\/settings\/github$/.test(pathname)) return "github";
  if (/\/app\/settings\/speech$/.test(pathname)) return "speech";
  if (/\/app\/settings\/repository$/.test(pathname)) return "repository";
  if (/\/app\/settings\/server$/.test(pathname)) return "server";
  return "home";
}

function settingsSectionMeta(t: ReturnType<typeof useTranslation>["t"], section: ReturnType<typeof currentSettingsSection>) {
  if (section === "ai-integrations") return { title: t("settingsSection.aiIntegrationsTitle"), description: t("settingsSection.aiIntegrationsDescription") };
  if (section === "ai-router") return { title: t("settingsSection.aiRouterTitle"), description: t("settingsSection.aiRouterDescription") };
  if (section === "deep-search") return { title: t("settingsSection.deepSearchTitle"), description: t("settingsSection.deepSearchDescription") };
  if (section === "tools") return { title: t("settingsSection.copilotToolsTitle"), description: t("settingsSection.copilotToolsDescription") };
  if (section === "github") return { title: t("settings.github"), description: t("settings.githubDescription") };
  if (section === "speech") return { title: t("speech.title"), description: t("speech.browserOnlyDescription") };
  if (section === "repository") return { title: t("repoSettings.title"), description: t("repoSettings.description") };
  if (section === "server") return { title: t("personalServer.title"), description: t("personalServer.description") };
  return { title: t("settings.title"), description: t("settings.description") };
}

function SettingsCard({ href, title, description, icon }: { href: string; title: string; description: string; icon: ReactNode }) {
  return (
    <Link to={href} className="rounded-2xl border border-layer bg-card p-5 shadow-sm transition hover:border-primary/40 hover:bg-accent/30">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-primary/10 p-2 text-primary">{icon}</div>
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </Link>
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
  const id = useId();
  const options = useMemo(() => integrations.map((integration) => ({ id: integration.id, label: integration.name || integration.provider })), [integrations]);
  if (options.length === 0) return null;

  return (
    <div className="grid gap-4 rounded-2xl border bg-muted/20 p-4 sm:grid-cols-2">
      <div className="grid gap-2">
        <Label htmlFor={`${id}-writing`}>{t("settings.defaultWriting")}</Label>
        <Select value={defaultWriting} onValueChange={onWritingChange}>
          <SelectTrigger id={`${id}-writing`}><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-review`}>{t("settings.defaultReview")}</Label>
        <Select value={defaultReview} onValueChange={onReviewChange}>
          <SelectTrigger id={`${id}-review`}><SelectValue /></SelectTrigger>
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

/** The text after the `#` of an address, as it was written; an address with a broken escape names nothing. */
function hashName(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

function IntegrationAccordion({ integration, children }: { integration: AIIntegration; children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const card = useRef<HTMLDetailsElement>(null);
  const providerText = providerLabel(t, integration.provider);
  const modelCount = integration.chatModels?.length ?? 0;
  const anchor = integrationAnchor(integration.id);
  // A link to `#integration-<id>` does not scroll by itself in the app: the card it names opens, comes into view and gives the focus to its title, where a keyboard or a screen reader starts reading.
  // A link is followed once: coming back to the same entry of the history (after the menu of a phone, for one) does not scroll the page again.
  const followed = useRef("");
  useEffect(() => {
    const element = card.current;
    if (!element || hashName(location.hash) !== anchor || followed.current === location.key) return;
    followed.current = location.key;
    element.open = true;
    element.scrollIntoView?.({ block: "center" });
    element.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  }, [location.hash, location.key, anchor]);
  return (
    <details ref={card} id={anchor} className="group min-w-0 rounded-2xl border border-layer bg-card shadow-sm [&[open]>summary_.chev]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="chev h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{integration.name || t("settings.unnamedIntegration")}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {providerText} · {t("settings.modelCount", { count: modelCount })}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-xs">{providerText}</Badge>
      </summary>
      <div className="border-t p-4">{children}</div>
    </details>
  );
}

function IntegrationEditor({ integration, onChange, onRemove, credentialsDisabled = false }: { integration: AIIntegration; onChange: (patch: Partial<AIIntegration>) => void; onRemove?: () => void; credentialsDisabled?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const id = useId();
  const isGithub = integration.provider === "github_models";
  const usesApiKey = integration.provider !== "m365_copilot";
  const usesEndpoint = integration.provider !== "m365_copilot" && !isGithub;
  const usesMedia = integration.provider !== "m365_copilot" && !isGithub;

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-name`}>{t("settings.integrationName")}</Label>
            <Input id={`${id}-name`} value={integration.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Azure OpenAI" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-provider`}>{t("settings.provider")}</Label>
            <Select value={integration.provider} onValueChange={(value) => onChange({ provider: value as AIProviderType })}>
              <SelectTrigger id={`${id}-provider`}><SelectValue /></SelectTrigger>
              <SelectContent>{PROVIDERS.map((provider) => <SelectItem key={provider.value} value={provider.value}>{t(provider.labelKey, { defaultValue: provider.fallback })}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {onRemove && (
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t("settings.removeIntegration", { name: integration.name })}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>

      <div className="grid items-start gap-3 sm:grid-cols-2">
        {usesEndpoint && (
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor={`${id}-endpoint`}>{t("settings.endpoint")}</Label>
            <Input id={`${id}-endpoint`} value={integration.endpoint ?? ""} onChange={(e) => onChange({ endpoint: e.target.value })} placeholder={integration.provider === "azure_openai" ? "https://resource.openai.azure.com" : "https://api.openai.com/v1"} />
          </div>
        )}
        {usesApiKey && (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-key`}>{isGithub ? t("settings.githubPat") : t("settings.apiKey")}</Label>
            <SecretInput
              id={`${id}-key`}
              aria-describedby={isGithub ? `${id}-key-hint` : undefined}
              value={integration.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              placeholder={isGithub ? "ghp_… (GitHub PAT)" : undefined}
              disabled={credentialsDisabled}
              onCopyResult={(copied) => toast(copied ? { title: t("secretInput.copiedToast") } : { title: t("secretInput.copyFailed"), variant: "destructive" })}
            />
            {isGithub && <p id={`${id}-key-hint`} className="text-xs text-muted-foreground">{t("settings.githubModelsHint")}</p>}
          </div>
        )}
        {integration.provider === "openai" && <EndpointTools integration={integration} onChange={onChange} disabled={credentialsDisabled} />}
        {integration.provider !== "m365_copilot" && (
          <IntegrationRequestFields integration={integration} onChange={onChange} />
        )}
        {usesMedia && (
          <>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-stt`}>{t("speech.sttModel")}</Label>
              <Input id={`${id}-stt`} value={integration.modelSpeechToText ?? ""} onChange={(e) => onChange({ modelSpeechToText: e.target.value })} placeholder={t("settings.modelOrDeployment", { model: "whisper-1" })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-tts`}>{t("speech.ttsModel")}</Label>
              <Input id={`${id}-tts`} value={integration.modelTextToSpeech ?? ""} onChange={(e) => onChange({ modelTextToSpeech: e.target.value })} placeholder={t("settings.modelOrDeployment", { model: "tts-1" })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-image`}>{t("images.imageModel")}</Label>
              <Input id={`${id}-image`} value={integration.modelImageGeneration ?? ""} onChange={(e) => onChange({ modelImageGeneration: e.target.value })} placeholder={t("settings.modelOrDeployment", { model: "gpt-image-1" })} />
            </div>
          </>
        )}
        {integration.provider === "azure_openai" && (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-version`}>{t("settings.apiVersion")}</Label>
            <Input id={`${id}-version`} value={integration.apiVersion ?? ""} onChange={(e) => onChange({ apiVersion: e.target.value })} placeholder="2024-10-21" />
          </div>
        )}
      </div>

      {integration.provider !== "m365_copilot" && (
        <ChatModelsEditor
          provider={integration.provider}
          endpoint={integration.endpoint ?? ""}
          apiKey={integration.apiKey}
          models={integration.chatModels ?? []}
          onChange={(chatModels) => onChange({ chatModels })}
          networkDisabled={credentialsDisabled}
        />
      )}

      {usesMedia && (
        <details className="mt-3 rounded-lg border bg-muted/20 p-3">
          <summary className="cursor-pointer py-1 text-sm font-medium [@media(pointer:coarse)]:py-3">{t("costs.mediaPricingTitle")}</summary>
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
      <Badge variant="secondary" className="mt-3 text-xs">{providerLabel(t, integration.provider)}</Badge>
    </div>
  );
}

function ChatModelsEditor({ provider, endpoint, apiKey, models, onChange, networkDisabled = false }: { provider: AIProviderType; endpoint: string; apiKey: string; models: ChatModel[]; onChange: (models: ChatModel[]) => void; networkDisabled?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const id = useId();
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [remoteModels, setRemoteModels] = useState<OpenAICompatibleModel[]>([]);
  const [selectedRemoteModel, setSelectedRemoteModel] = useState("");

  useEffect(() => {
    setRemoteModels([]);
    setSelectedRemoteModel("");
  }, [endpoint]);

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
    if (!window.confirm(t("settings.confirmRemoveModel"))) return;
    onChange(models.filter((m) => m.id !== id));
  }

  async function loadOpenAIModels() {
    if (!endpoint.trim()) { toast({ title: t("settings.openaiEndpointMissing"), variant: "destructive" }); return; }
    setLoadingCatalog(true);
    try {
      const catalog = await fetchOpenAICompatibleModels(endpoint, apiKey);
      setRemoteModels(catalog);
      setSelectedRemoteModel((current) => current || catalog[0]?.id || "");
      if (!catalog.length) toast({ title: t("settings.openaiCatalogEmpty") });
    } catch (err) {
      toast({ title: t("settings.openaiCatalogFailed"), description: String(err), variant: "destructive" });
    } finally {
      setLoadingCatalog(false);
    }
  }

  function addSelectedOpenAIModel() {
    const selected = remoteModels.find((model) => model.id === selectedRemoteModel);
    if (!selected || models.some((model) => model.name === selected.id)) return;
    const added: ChatModel = {
      id: crypto.randomUUID(),
      name: selected.id,
      capabilities: models.length === 0 ? ["default", "copilot", "simple-tasks", "review"] : [],
    };
    onChange([...models, added]);
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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-[12rem] flex-1 break-words">
          <p className="text-sm font-medium">{t("settings.chatModels")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.chatModelsHint")}</p>
          <p id={`${id}-tools-hint`} className="mt-1 text-xs text-muted-foreground">{t("settings.forcedToolCallsHint")}</p>
          <p id={`${id}-thinking-parameter-hint`} className="mt-1 text-xs text-muted-foreground">{t("settings.thinkingParameterHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {provider === "github_models" && (
            <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" disabled={networkDisabled || loadingCatalog} onClick={() => void loadCatalog()}>
              {loadingCatalog ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
              {t("settings.loadCatalogModels")}
            </Button>
          )}
          {provider === "openai" && (
            <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" disabled={networkDisabled || loadingCatalog} onClick={() => void loadOpenAIModels()}>
              {loadingCatalog ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
              {t("settings.loadApiModels")}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={addModel}>
            <Plus className="mr-1 h-3.5 w-3.5" />{t("settings.addChatModel")}
          </Button>
        </div>
      </div>
      {provider === "openai" && remoteModels.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1">
            <Label htmlFor={`${id}-remote`} className="text-xs">{t("settings.apiModelChoice")}</Label>
            <Select value={selectedRemoteModel} onValueChange={setSelectedRemoteModel}>
              <SelectTrigger id={`${id}-remote`} className="h-8 text-sm"><SelectValue placeholder={t("settings.chooseApiModel")} /></SelectTrigger>
              <SelectContent>
                {remoteModels.map((model) => <SelectItem key={model.id} value={model.id}>{model.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" size="sm" disabled={!selectedRemoteModel || models.some((model) => model.name === selectedRemoteModel)} onClick={addSelectedOpenAIModel}>
            <Plus className="mr-1 h-3.5 w-3.5" />{t("settings.addSelectedApiModel")}
          </Button>
        </div>
      )}
      {models.length === 0 && <p className="text-xs text-muted-foreground">{t("settings.noChatModels")}</p>}
      <div className="space-y-3">
        {models.map((model) => (
          <div key={model.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <Label htmlFor={`${id}-${model.id}-name`} className="text-xs">{t("settings.chatModelName")}</Label>
                <Input id={`${id}-${model.id}-name`} value={model.name} onChange={(e) => patchModel(model.id, { name: e.target.value })} placeholder="gpt-4o" className="h-8 text-sm" />
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeModel(model.id)} aria-label={t("settings.removeModel", { name: model.name })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {provider === "azure_openai" && (
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-${model.id}-underlying`} className="text-xs">{t("settings.underlyingModel")}</Label>
                  <Input id={`${id}-${model.id}-underlying`} value={model.underlyingModel ?? ""} onChange={(e) => patchModel(model.id, { underlyingModel: e.target.value.trim() || undefined })} placeholder="o3-mini / gpt-4o" className="h-8 text-sm" />
                </div>
              )}
              {provider === "github_models" && (
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-${model.id}-tier`} className="text-xs">{t("settings.modelTier")}</Label>
                  <Input id={`${id}-${model.id}-tier`} value={model.tier ?? ""} onChange={(e) => patchModel(model.id, { tier: e.target.value.trim() || undefined })} placeholder="low / standard / high" className="h-8 text-sm" />
                </div>
              )}
              <TokenLimitField label={t("settings.maxInputTokens")} value={model.maxInputTokens} onChange={(v) => patchModel(model.id, { maxInputTokens: v })} />
              <TokenLimitField label={t("settings.maxOutputTokens")} value={model.maxOutputTokens} onChange={(v) => patchModel(model.id, { maxOutputTokens: v })} />
              <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <Label htmlFor={`${id}-${model.id}-tools`} className="text-xs">{t("settings.forcedToolCalls")}</Label>
                <Switch id={`${id}-${model.id}-tools`} aria-describedby={`${id}-tools-hint`} checked={model.supportsToolCalls !== false} onCheckedChange={(supportsToolCalls) => patchModel(model.id, { supportsToolCalls })} />
              </div>
              <ReasoningParameterField model={model} hintId={`${id}-thinking-parameter-hint`} onChange={(reasoningParameter) => patchModel(model.id, { reasoningParameter })} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHAT_CAPABILITIES.map((capability) => {
                const active = model.capabilities?.includes(capability);
                return (
                  <button
                    key={capability}
                    type="button"
                    aria-pressed={Boolean(active)}
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
              <summary className="cursor-pointer py-1 text-xs font-medium [@media(pointer:coarse)]:py-3">{t("costs.chatPricingTitle")}</summary>
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
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
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
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
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

function RoutingEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="rounded-3xl border border-dashed p-6 text-center sm:p-8">
      <Plug className="mx-auto h-10 w-10 text-primary" />
      <h2 className="mt-4 font-serif text-xl font-semibold">{t("routing.noIntegrationsTitle")}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t("routing.noIntegrationsBody")}</p>
      <Button asChild className="mt-5"><Link to="/app/settings/ai-integrations">{t("routing.noIntegrationsAction")}</Link></Button>
    </div>
  );
}

function TaskRoutingBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const execution = settings.routingExecution ?? DEFAULT_SETTINGS.routingExecution;

  return (
    <div className="space-y-4">
      <RouterRunNote settings={settings} />
      <ToolsOnlyField settings={settings} patchSettings={patchSettings} />
      <details className="rounded-lg border border-layer bg-card [&[open]>summary_.chev]:rotate-90">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-3 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="chev h-4 w-4 shrink-0 text-muted-foreground transition-transform" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("routing.options.title")}</p>
            <p className="text-xs text-muted-foreground">{t("routing.options.description")}</p>
          </div>
        </summary>
        <div className="space-y-4 border-t border-layer p-3">
          <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-4">
              <div><Label htmlFor={`${id}-boundary`}>{t("routing.sameBoundaryOnly")}</Label><p id={`${id}-boundary-hint`} className="text-xs text-muted-foreground">{t("routing.sameBoundaryOnlyHint")}</p></div>
              <Switch id={`${id}-boundary`} aria-describedby={`${id}-boundary-hint`} checked={settings.fallbackDisclosure?.sameBoundaryOnly ?? false} onCheckedChange={(sameBoundaryOnly) => patchSettings({ fallbackDisclosure: { ...settings.fallbackDisclosure, sameBoundaryOnly } })} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div><Label htmlFor={`${id}-acknowledge`}>{t("routing.requireAcknowledgement")}</Label><p id={`${id}-acknowledge-hint`} className="text-xs text-muted-foreground">{t("routing.requireAcknowledgementHint")}</p></div>
              <Switch id={`${id}-acknowledge`} aria-describedby={`${id}-acknowledge-hint`} checked={settings.fallbackDisclosure?.requireAcknowledgement ?? false} onCheckedChange={(requireAcknowledgement) => { clearFallbackAcknowledgements(); patchSettings({ fallbackDisclosure: { ...settings.fallbackDisclosure, requireAcknowledgement } }); }} />
            </div>
          </div>
          <div className="grid gap-3 rounded-lg border bg-muted/10 p-3 sm:grid-cols-2">
            <TokenLimitField label={t("routing.maxCandidates")} value={execution.maxCandidates} onChange={(value) => patchSettings({ routingExecution: { ...execution, maxCandidates: Math.min(8, Math.max(1, value ?? 4)) } })} />
            <TokenLimitField label={t("routing.maxTotalDuration")} value={execution.maxTotalDurationMs} onChange={(value) => patchSettings({ routingExecution: { ...execution, maxTotalDurationMs: Math.min(600_000, Math.max(1_000, value ?? 180_000)) } })} />
            <TokenLimitField label={t("routing.maxTokenAttempts")} value={execution.maxTokenAttempts} onChange={(value) => patchSettings({ routingExecution: { ...execution, maxTokenAttempts: Math.min(2_000_000, Math.max(1_000, value ?? 200_000)) } })} />
            <PriceField label={t("routing.maxEstimatedCost")} value={execution.maxEstimatedCost} onChange={(value) => patchSettings({ routingExecution: { ...execution, maxEstimatedCost: Math.min(1_000, Math.max(0.01, value ?? 5)) } })} />
          </div>
        </div>
      </details>
      <RouterSections settings={settings} patchSettings={patchSettings} />
    </div>
  );
}
