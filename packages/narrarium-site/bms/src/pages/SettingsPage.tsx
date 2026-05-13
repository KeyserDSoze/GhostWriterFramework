import { useState, useEffect, useRef } from "react";
import { Loader2, Plus, Trash2, Cloud, CloudOff, Github, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSettingsStore } from "@/store/settingsStore";
import { useSettings } from "@/drive/useSettings";

export function SettingsPage() {
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus, lastSynced, load } = useSettings();

  // Auto-load from Drive on first mount if we have no recent sync
  const didAutoLoad = useRef(false);
  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    void load();
  }, [load]);

  // Local form state (mirrors store)
  const [defaultToken, setDefaultToken] = useState(settings.defaultGitHubToken);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newToken, setNewToken] = useState("");

  const [azEndpoint, setAzEndpoint] = useState(settings.azureOpenAI.endpoint);
  const [azKey, setAzKey] = useState(settings.azureOpenAI.apiKey);
  const [azModel, setAzModel] = useState(settings.azureOpenAI.model);
  const [azApiVersion, setAzApiVersion] = useState(settings.azureOpenAI.apiVersion);

  // Sync form fields when Drive load completes (syncStatus transitions to "idle")
  const prevSyncStatus = useRef(syncStatus);
  useEffect(() => {
    if (prevSyncStatus.current !== syncStatus) {
      prevSyncStatus.current = syncStatus;
      if (syncStatus === "idle") {
        const s = useSettingsStore.getState().settings;
        setDefaultToken(s.defaultGitHubToken);
        setAzEndpoint(s.azureOpenAI.endpoint);
        setAzKey(s.azureOpenAI.apiKey);
        setAzModel(s.azureOpenAI.model);
        setAzApiVersion(s.azureOpenAI.apiVersion);
      }
    }
  }, [syncStatus]);

  const isSaving = syncStatus === "saving";
  const isLoading = syncStatus === "loading";

  async function handleSave() {
    patchSettings({
      defaultGitHubToken: defaultToken,
      azureOpenAI: {
        endpoint: azEndpoint,
        apiKey: azKey,
        model: azModel,
        apiVersion: azApiVersion,
      },
    });
    await save();
  }

  function addExtraToken() {
    if (!newTokenLabel || !newToken) return;
    const next = [
      ...settings.extraGitHubTokens,
      { label: newTokenLabel, token: newToken },
    ];
    patchSettings({ extraGitHubTokens: next });
    setNewTokenLabel("");
    setNewToken("");
  }

  function removeExtraToken(index: number) {
    const next = settings.extraGitHubTokens.filter((_, i) => i !== index);
    patchSettings({ extraGitHubTokens: next });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">
            All settings are stored in your Google Drive.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Cloud className="mr-1 h-3 w-3" />
            )}
            Sync from Drive
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>
      </div>

      {syncStatus === "error" && (
        <Alert variant="destructive">
          <CloudOff className="h-4 w-4" />
          <AlertDescription>
            Failed to sync with Google Drive. Check your connection and try
            again.
          </AlertDescription>
        </Alert>
      )}

      {lastSynced && (
        <p className="text-xs text-muted-foreground">
          Last synced:{" "}
          {new Date(lastSynced).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      )}

      {/* ── GitHub ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" />
            GitHub
          </CardTitle>
          <CardDescription>
            Tokens are stored encrypted in your Drive and never leave your
            browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="default-token">Default GitHub token</Label>
            <Input
              id="default-token"
              type="password"
              placeholder="ghp_…"
              value={defaultToken}
              onChange={(e) => setDefaultToken(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Used for all books that don't specify their own token. Requires
              at least <code>repo</code> (read) scope.
            </p>
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">How to create a token</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>
                  Go to{" "}
                  <a
                    href="https://github.com/settings/tokens?type=beta"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-foreground"
                  >
                    github.com/settings/tokens
                  </a>{" "}
                  → <strong>Generate new token (fine-grained)</strong>
                </li>
                <li>Name it (e.g. <em>Narrarium BMS</em>), set expiration</li>
                <li>
                  Under <strong>Repository access</strong> choose{" "}
                  <strong className="text-foreground">All repositories</strong>{" "}
                  — required to see private repos in the Add screen
                </li>
                <li>
                  Under <strong>Repository permissions</strong> set{" "}
                  <em>Contents</em> → <strong>Read &amp; write</strong>{" "}
                  and <em>Metadata</em> → <strong>Read-only</strong> (auto-set)
                </li>
                <li>Click <strong>Generate token</strong> and paste it here</li>
              </ol>
              <p className="pt-1">
                <strong>Classic PAT</strong>: needs the{" "}
                <code className="bg-muted px-1 rounded">repo</code> scope (not just{" "}
                <code className="bg-muted px-1 rounded">public_repo</code>) to access
                private repositories.
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-sm font-medium">Additional tokens</p>
            {settings.extraGitHubTokens.map((t, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">
                    …{t.token.slice(-4)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeExtraToken(i)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}

            <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <Input
                placeholder="Label"
                value={newTokenLabel}
                onChange={(e) => setNewTokenLabel(e.target.value)}
              />
              <Input
                type="password"
                placeholder="ghp_…"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                autoComplete="off"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={addExtraToken}
                disabled={!newTokenLabel || !newToken}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Azure OpenAI ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Azure OpenAI
          </CardTitle>
          <CardDescription>
            Used for AI-assisted writing features. Keys are stored in your
            Drive only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="az-endpoint">Endpoint</Label>
            <Input
              id="az-endpoint"
              placeholder="https://your-resource.openai.azure.com"
              value={azEndpoint}
              onChange={(e) => setAzEndpoint(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="az-key">API Key</Label>
            <Input
              id="az-key"
              type="password"
              placeholder="••••••••••••••••"
              value={azKey}
              onChange={(e) => setAzKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="az-model">Deployment / Model</Label>
              <Input
                id="az-model"
                placeholder="gpt-4o"
                value={azModel}
                onChange={(e) => setAzModel(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="az-api-version">API Version</Label>
              <Input
                id="az-api-version"
                placeholder="2024-10-21"
                value={azApiVersion}
                onChange={(e) => setAzApiVersion(e.target.value)}
              />
            </div>
          </div>
          {azEndpoint && azKey && (
            <Badge variant="secondary" className="text-xs">
              Azure OpenAI configured
            </Badge>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
