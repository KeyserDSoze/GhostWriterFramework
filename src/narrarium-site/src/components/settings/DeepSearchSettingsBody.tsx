import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, PlugZap, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import type { AppSettings, ResearchProviderId, ResearchRoutableIntent } from "@/types/settings";
import { allResearchProviders, providersForIntent } from "@/research/providers";

export function DeepSearchSettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [testing, setTesting] = useState<string | null>(null);

  const providerStatus = useMemo(() => allResearchProviders().map((provider) => {
    const apiKey = provider.id === "brave" ? settings.deepSearch.braveApiKey : provider.id === "tavily" ? settings.deepSearch.tavilyApiKey : "";
    return { provider, configured: provider.isConfigured({ apiKey }) };
  }), [settings.deepSearch.braveApiKey, settings.deepSearch.tavilyApiKey]);

  function patchDeepSearch(patch: Partial<AppSettings["deepSearch"]>) {
    patchSettings({ deepSearch: { ...settings.deepSearch, ...patch } });
  }

  function updateIntentRoute(intent: ResearchRoutableIntent, patch: Partial<AppSettings["deepSearch"]["routes"][ResearchRoutableIntent]>) {
    patchDeepSearch({
      routes: {
        ...settings.deepSearch.routes,
        [intent]: { ...settings.deepSearch.routes[intent], ...patch },
      },
    });
  }

  function toggleFallback(intent: ResearchRoutableIntent, providerId: ResearchProviderId) {
    const current = settings.deepSearch.routes[intent].fallbacks;
    const next = current.includes(providerId) ? current.filter((id) => id !== providerId) : [...current, providerId];
    updateIntentRoute(intent, { fallbacks: next });
  }

  async function testProvider(providerId: ResearchProviderId) {
    const entry = providerStatus.find((row) => row.provider.id === providerId);
    if (!entry) return;
    setTesting(providerId);
    try {
      const apiKey = providerId === "brave" ? settings.deepSearch.braveApiKey : providerId === "tavily" ? settings.deepSearch.tavilyApiKey : undefined;
      const result = await entry.provider.search("Babylon history", { depth: "low", language: settings.ui.language, intent: entry.provider.intent, apiKey });
      if (result.error) throw new Error(result.error);
      toast({ title: t("deepSearch.testSuccess"), description: `${entry.provider.label}: ${result.results.length}` });
    } catch (err) {
      toast({ title: t("deepSearch.testFailed"), description: String(err), variant: "destructive" });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>{t("deepSearch.braveApiKey")}</Label>
          <Input type="password" value={settings.deepSearch.braveApiKey} onChange={(e) => patchDeepSearch({ braveApiKey: e.target.value })} placeholder="BSA..." autoComplete="off" />
        </div>
        <div className="grid gap-2">
          <Label>{t("deepSearch.tavilyApiKey")}</Label>
          <Input type="password" value={settings.deepSearch.tavilyApiKey} onChange={(e) => patchDeepSearch({ tavilyApiKey: e.target.value })} placeholder="tvly-..." autoComplete="off" />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label>{t("deepSearch.contentProxy")}</Label>
          <Input value={settings.deepSearch.contentProxyBaseUrl} onChange={(e) => patchDeepSearch({ contentProxyBaseUrl: e.target.value })} placeholder="https://your-worker.example.workers.dev/fetch" />
          <p className="text-xs text-muted-foreground">{t("deepSearch.contentProxyHint")}</p>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <p className="text-sm font-medium">{t("deepSearch.providersTitle")}</p>
        <div className="space-y-3">
          {providerStatus.map(({ provider, configured }) => (
            <div key={provider.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{provider.label}</p>
                    <Badge variant={configured || !provider.requiresApiKey ? "secondary" : "outline"}>
                      {configured || !provider.requiresApiKey ? t("deepSearch.providerReady") : t("deepSearch.providerNeedsConfig")}
                    </Badge>
                    <Badge variant="outline">{t(`deepSearch.intent.${provider.intent}`)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{provider.id}{provider.requiresApiKey ? ` · ${t("deepSearch.requiresApiKey")}` : ` · ${t("deepSearch.noApiKey")}`}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void testProvider(provider.id)} disabled={testing === provider.id || (provider.requiresApiKey && !configured)}>
                  {testing === provider.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PlugZap className="mr-1 h-4 w-4" />}
                  {t("deepSearch.testConnection")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      <div className="space-y-5">
        <p className="text-sm font-medium">{t("deepSearch.routingTitle")}</p>
        {(["news", "encyclopedia", "internet"] as ResearchRoutableIntent[]).map((intent) => {
          const options = providersForIntent(intent);
          const route = settings.deepSearch.routes[intent];
          return (
            <div key={intent} className="rounded-xl border p-4">
              <p className="mb-3 flex items-center gap-2 font-medium"><Search className="h-4 w-4 text-primary" />{t(`deepSearch.intent.${intent}`)}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>{t("deepSearch.primaryProvider")}</Label>
                  <Select value={route.primary ?? options[0]?.id ?? ""} onValueChange={(value) => updateIntentRoute(intent, { primary: value as ResearchProviderId })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {options.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>{t("deepSearch.fallbackProviders")}</Label>
                  <div className="flex flex-wrap gap-2 rounded-lg border p-2">
                    {options.map((provider) => (
                      <Button key={provider.id} type="button" size="sm" variant={route.fallbacks.includes(provider.id) ? "default" : "outline"} onClick={() => toggleFallback(intent, provider.id)} disabled={route.primary === provider.id}>
                        {provider.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground"><CheckCircle2 className="h-4 w-4 text-primary" />{t("deepSearch.defaultMapTitle")}</p>
        <p className="mt-1">{t("deepSearch.defaultMapBody")}</p>
      </div>
    </div>
  );
}
