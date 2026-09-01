import { useEffect, useState } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { Cloud, Github, HardDrive, Loader2, RefreshCw, Trash2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GOOGLE_DRIVE_SCOPES } from "@/config/googleAuth";
import { ensureMsalInitialized, MICROSOFT_SCOPES, microsoftMsalInstance, microsoftSilentRequest, setMicrosoftRememberMe } from "@/config/msal";
import { useConnectionStore } from "@/account/connectionStore";
import { deleteRemoteAccountData, resolveAccountReconciliation, syncAllAccountReplicas, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import { createGitHubOAuthAuthorizationUrl, GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED } from "@/github/githubOAuth";
import { connectGitHubCredential } from "@/github/githubConnection";
import { loadLocalAccountSnapshot } from "@/account/accountLocalStore";
import type { AccountSyncBackendKind } from "@/account/types";
import { useSettingsStore } from "@/store/settingsStore";
import { deleteAllNarrariumLocalData, getFullDeviceSafetyReport } from "@/account/dataSafety";
import { useAuthStore } from "@/store/authStore";
import { migrateConnectedProviderRepositories } from "@/auth/accountScope";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";
import { applyLegacyGoogleChatImport, prepareLegacyGoogleChatImport } from "@/account/legacyGoogleChatImport";

export function AccountSyncPage() {
  const italian = useSettingsStore((state) => state.settings.ui.language) === "it";
  const configuration = useConnectionStore((state) => state.configuration);
  const hydrated = useConnectionStore((state) => state.hydrated);
  const hydrate = useConnectionStore((state) => state.hydrate);
  const syncing = useAccountSyncStore((state) => state.syncing);
  const [rememberMe, setRememberMe] = useState(true);
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localSummary, setLocalSummary] = useState<{ modifiedAtUtc: string; books: number; chats: number; dirty: boolean } | null>(null);

  const refreshLocalSummary = async () => {
    const snapshot = await loadLocalAccountSnapshot();
    setLocalSummary(snapshot ? { modifiedAtUtc: snapshot.manifest.modifiedAtUtc, books: snapshot.data.settings.books.length, chats: snapshot.data.chats.length, dirty: snapshot.dirty } : null);
  };

  useEffect(() => { void hydrate(); void refreshLocalSummary(); }, [hydrate]);

  const googleLogin = useGoogleLogin({
    scope: GOOGLE_DRIVE_SCOPES,
    onSuccess: async (response) => {
      setBusy("google");
      setError(null);
      try {
        const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${response.access_token}` } });
        if (!profileResponse.ok) throw new Error(`Google profile failed (${profileResponse.status}).`);
        const profile = await profileResponse.json() as { sub?: string; name?: string; email?: string; picture?: string };
        if (!profile.sub) throw new Error("Google did not return an immutable account ID.");
        await useConnectionStore.getState().connectGoogle({
          identity: { provider: "google", providerAccountId: profile.sub, displayName: profile.name || profile.email || "Google", email: profile.email, avatarUrl: profile.picture },
          accessToken: response.access_token,
          accessTokenExpiry: Date.now() + (("expires_in" in response ? Number(response.expires_in) : 3_600) - 60) * 1_000,
          rememberMe,
        });
        useAuthStore.getState().setInteractiveAuth(response.access_token, { provider: "google", providerAccountId: profile.sub, name: profile.name || profile.email || "Google", email: profile.email ?? "", picture: profile.picture ?? "" }, "expires_in" in response ? Number(response.expires_in) : 3_600, rememberMe);
        const migration = await migrateConnectedProviderRepositories();
        if (migration.error) throw migration.error;
        await syncOneAccountReplica("google-drive");
        await refreshLocalSummary();
      } catch (cause) { setError(String(cause)); }
      finally { setBusy(null); }
    },
    onError: (cause) => setError(cause.error_description ?? "Google connection failed."),
  });

  async function connectMicrosoft() {
    setBusy("microsoft");
    setError(null);
    try {
      setMicrosoftRememberMe(rememberMe);
      const client = microsoftMsalInstance(rememberMe);
      await ensureMsalInitialized(client);
      const login = await client.loginPopup({ scopes: MICROSOFT_SCOPES, prompt: "select_account" });
      if (!login.account?.homeAccountId || !login.account.localAccountId) throw new Error("Microsoft did not return immutable account IDs.");
      const result = await client.acquireTokenSilent(microsoftSilentRequest(login.account)).catch(() => login);
      const profileResponse = await fetchMicrosoftGraph("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${result.accessToken}` } });
      if (!profileResponse.ok) throw new Error(`Microsoft profile failed (${profileResponse.status}).`);
      const profile = await profileResponse.json() as { displayName?: string; mail?: string; userPrincipalName?: string };
      await useConnectionStore.getState().connectMicrosoft({
        identity: { provider: "microsoft", providerAccountId: login.account.homeAccountId, displayName: profile.displayName || profile.mail || "Microsoft", email: profile.mail ?? profile.userPrincipalName },
        accessToken: result.accessToken,
        accessTokenExpiry: result.expiresOn?.getTime(),
        homeAccountId: login.account.homeAccountId,
        localAccountId: login.account.localAccountId,
        rememberMe,
      });
      useAuthStore.getState().setInteractiveAuth(result.accessToken, { provider: "microsoft", providerAccountId: login.account.homeAccountId, name: profile.displayName || profile.mail || "Microsoft", email: profile.mail ?? profile.userPrincipalName ?? "", picture: "", homeAccountId: login.account.homeAccountId, localAccountId: login.account.localAccountId }, Math.max(120, Math.round(((result.expiresOn?.getTime() ?? Date.now() + 3_600_000) - Date.now()) / 1_000)), rememberMe);
      const migration = await migrateConnectedProviderRepositories();
      if (migration.error) throw migration.error;
      await syncOneAccountReplica("onedrive");
      await refreshLocalSummary();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }

  async function connectPat() {
    setBusy("github");
    setError(null);
    try { await connectGitHubCredential({ token: pat, kind: "pat", rememberMe, accountSyncEnabled: true }); setPat(""); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }

  async function connectOAuth() {
    setError(null);
    try { window.location.assign(await createGitHubOAuthAuthorizationUrl({ rememberMe, returnTo: "/app/account-sync" })); }
    catch (cause) { setError(String(cause)); }
  }

  async function runSync(kind?: AccountSyncBackendKind) {
    setBusy(kind ?? "all");
    setError(null);
    try { if (kind) await syncOneAccountReplica(kind); else await syncAllAccountReplicas(); await refreshLocalSummary(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }

  async function importLegacyGoogleChats() {
    setBusy("google-legacy-chats");
    setError(null);
    setNotice(null);
    try {
      const plan = await prepareLegacyGoogleChatImport();
      if (!plan.total) {
        setNotice(italian ? "Nessuna chat legacy trovata su Google Drive." : "No legacy chats were found on Google Drive.");
        return;
      }
      if (plan.conflicts.length) throw new Error(`${italian ? "Le chat legacy sono in conflitto con chat locali correnti" : "Legacy chats conflict with current local chats"}: ${plan.conflicts.join(", ")}.`);
      if (!plan.importableSessions.length) {
        setNotice(italian ? `Tutte le ${plan.unchanged} chat legacy sono già presenti nel workspace locale.` : `All ${plan.unchanged} legacy chats are already present in the local workspace.`);
        return;
      }
      const confirmed = window.confirm(italian
        ? `Importare ${plan.importableSessions.length} chat legacy da Google Drive nel workspace locale? I file originali non verranno modificati. Dopo l'importazione il nuovo snapshot verrà sincronizzato con tutte le repliche abilitate.`
        : `Import ${plan.importableSessions.length} legacy Google Drive chat${plan.importableSessions.length === 1 ? "" : "s"} into the local workspace? The original files will not be changed. The new snapshot will then sync to every enabled replica.`);
      if (!confirmed) return;
      const imported = await applyLegacyGoogleChatImport(plan);
      const syncResult = await syncAllAccountReplicas();
      await refreshLocalSummary();
      setNotice(syncResult.reconciliation
        ? (italian ? `${imported} chat legacy importate localmente. Scegli la copia autorevole per completare la riconciliazione delle repliche.` : `${imported} legacy chat${imported === 1 ? "" : "s"} imported locally. Choose the authoritative copy to finish replica reconciliation.`)
        : (italian ? `${imported} chat legacy importate localmente. Sync completato per ${syncResult.synced.length} repliche.` : `${imported} legacy chat${imported === 1 ? "" : "s"} imported locally. Sync completed for ${syncResult.synced.length} replica${syncResult.synced.length === 1 ? "" : "s"}.`));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(kind: AccountSyncBackendKind) {
    if (!window.confirm(italian ? "Scollegare il servizio? I dati locali e remoti rimarranno invariati." : "Disconnect this service? Local and remote data will remain unchanged.")) return;
    await useConnectionStore.getState().disconnect(kind);
    const legacy = useAuthStore.getState();
    if ((kind === "google-drive" && legacy.user?.provider === "google") || (kind === "onedrive" && legacy.user?.provider === "microsoft")) legacy.clearAuth();
  }

  async function disconnectAll() {
    const report = await getFullDeviceSafetyReport();
    const detail = report.destructiveWarnings.length ? `\n\n${report.destructiveWarnings.join("\n")}` : "";
    if (!window.confirm(`${italian ? "Disconnettere tutti i provider? Il workspace locale resterà disponibile." : "Disconnect every provider? The local workspace will remain available."}${detail}`)) return;
    for (const backend of ["google-drive", "onedrive", "github"] as const) await useConnectionStore.getState().disconnect(backend);
    useAuthStore.getState().clearAuth();
  }

  async function removeRemote(kind: AccountSyncBackendKind) {
    const expected = kind === "github" ? "DELETE NARRARIUM.SETTINGS" : "DELETE";
    if (window.prompt(`${italian ? "Digita" : "Type"} ${expected}`) !== expected) return;
    setBusy(`delete-${kind}`);
    try { await deleteRemoteAccountData(kind); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }

  async function deleteLocalData() {
    const report = await getFullDeviceSafetyReport();
    const warnings = report.destructiveWarnings.length ? `\n\n${report.destructiveWarnings.map((warning) => `• ${warning}`).join("\n")}` : "";
    const typed = window.prompt(`${italian ? "Questa operazione elimina tutti i dati locali e non può essere annullata." : "This deletes all local data and cannot be undone."}${warnings}\n\n${italian ? "Digita DELETE per continuare" : "Type DELETE to continue"}`);
    if (typed !== "DELETE") return;
    await deleteAllNarrariumLocalData(typed);
    window.location.assign(new URL("app/books", new URL(import.meta.env.BASE_URL, window.location.origin)).toString());
  }

  if (!hydrated) return <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading local connections...</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">{italian ? "Account e sincronizzazione" : "Account & Sync"}</h1>
        <p className="mt-2 text-muted-foreground">{italian ? "Narrarium salva sempre prima su questo dispositivo. Ogni servizio è una replica opzionale indipendente." : "Narrarium always saves to this device first. Every service is an independent optional replica."}</p>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {notice && <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">{notice}</div>}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5" />{italian ? "Workspace locale" : "Local workspace"}</CardTitle><CardDescription>{italian ? "Disponibile senza login e senza connessione." : "Available without login or network access."}</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <span>{localSummary ? `${localSummary.books} books · ${localSummary.chats} chats` : "Initializing..."}</span>
          {localSummary && <span className="text-muted-foreground">{localSummary.modifiedAtUtc}</span>}
          <span className="font-medium">{localSummary?.dirty ? (italian ? "Salvato localmente · sync in attesa" : "Saved locally · sync pending") : (italian ? "Salvato localmente" : "Saved locally")}</span>
          <Button className="ml-auto" onClick={() => void runSync()} disabled={syncing || busy !== null}><RefreshCw className="mr-2 h-4 w-4" />{italian ? "Sincronizza ora" : "Sync now"}</Button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch checked={rememberMe} onCheckedChange={setRememberMe} />
        <div><Label>{italian ? "Ricorda la connessione su questo dispositivo" : "Remember connection on this device"}</Label><p className="text-xs text-muted-foreground">{italian ? "Le credenziali vengono controllate solo durante operazioni remote." : "Credentials are checked only during remote operations."}</p></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ConnectionCard title="Google Drive" icon={<Cloud className="h-5 w-5" />} connected={Boolean(configuration.google)} enabled={configuration.google?.replica.enabled} status={configuration.google?.replica.status} errorKind={configuration.google?.replica.errorKind} lastSync={configuration.google?.replica.lastSuccessfulSyncAtUtc} busy={syncing || busy === "google" || busy === "google-drive" || busy === "google-legacy-chats"} onToggle={(enabled) => useConnectionStore.getState().setEnabled("google-drive", enabled)} onConnect={() => googleLogin()} onSync={() => runSync("google-drive")} onDisconnect={() => disconnect("google-drive")} onDelete={() => removeRemote("google-drive")}>
          {configuration.google && <div className="space-y-2 border-t pt-3"><p className="text-xs text-muted-foreground">{italian ? "Recupera le conversazioni conservate nella vecchia cartella Google Drive/Narrarium/chats. L'importazione non modifica i file originali." : "Recover conversations stored in the old Google Drive/Narrarium/chats folder. Importing does not modify the original files."}</p><Button size="sm" variant="outline" onClick={() => void importLegacyGoogleChats()} disabled={syncing || busy !== null}>{busy === "google-legacy-chats" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{italian ? "Importa chat legacy" : "Import legacy chats"}</Button></div>}
        </ConnectionCard>
        <ConnectionCard title="OneDrive" icon={<Cloud className="h-5 w-5" />} connected={Boolean(configuration.microsoft)} enabled={configuration.microsoft?.replica.enabled} status={configuration.microsoft?.replica.status} errorKind={configuration.microsoft?.replica.errorKind} lastSync={configuration.microsoft?.replica.lastSuccessfulSyncAtUtc} busy={syncing || busy === "microsoft" || busy === "onedrive"} onToggle={(enabled) => useConnectionStore.getState().setEnabled("onedrive", enabled)} onConnect={connectMicrosoft} onSync={() => runSync("onedrive")} onDisconnect={() => disconnect("onedrive")} onDelete={() => removeRemote("onedrive")} />
        <ConnectionCard title="GitHub" icon={<Github className="h-5 w-5" />} connected={Boolean(configuration.github)} enabled={configuration.github?.replica.enabled} status={configuration.github?.replica.status} errorKind={configuration.github?.replica.errorKind} lastSync={configuration.github?.replica.lastSuccessfulSyncAtUtc} detail={configuration.github ? `${configuration.github.identity?.username ?? "GitHub"} · ${configuration.github.credentialKind.toUpperCase()}` : undefined} busy={syncing || busy === "github"} connectDisabled={!GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED} onToggle={(enabled) => useConnectionStore.getState().setEnabled("github", enabled)} onConnect={connectOAuth} onSync={() => runSync("github")} onDisconnect={() => disconnect("github")} onDelete={() => removeRemote("github")}>
          {(!configuration.github || configuration.github.replica.status === "needs-auth") && <div className="space-y-2 border-t pt-3">{!GITHUB_OAUTH_BROWSER_EXCHANGE_SUPPORTED && <p className="text-xs text-amber-700 dark:text-amber-300">{italian ? "OAuth GitHub è predisposto con PKCE ma il token endpoint GitHub non consente al browser di leggere la risposta CORS. Usa un PAT finché GitHub non abilita questo flusso per client statici." : "GitHub OAuth is implemented with PKCE, but GitHub's token endpoint does not let a browser read the CORS response. Use a PAT until GitHub supports this static-client flow."}</p>}<Label htmlFor="github-pat">Personal Access Token</Label><div className="flex gap-2"><Input id="github-pat" type="password" value={pat} onChange={(event) => setPat(event.target.value)} placeholder="github_pat_..." /><Button variant="outline" onClick={() => void connectPat()} disabled={!pat.trim()}>PAT</Button></div></div>}
        </ConnectionCard>
      </div>

      {(configuration.google || configuration.microsoft || configuration.github) && <Button variant="outline" onClick={() => void disconnectAll()}>{italian ? "Disconnetti tutti gli account e continua in locale" : "Disconnect all accounts and continue locally"}</Button>}

      <Card className="border-destructive/40"><CardHeader><CardTitle>{italian ? "Zona pericolosa" : "Danger zone"}</CardTitle><CardDescription>{italian ? "Logout e disconnessione non eliminano i dati. Questa è l'unica azione che rimuove l'intero workspace locale." : "Logout and disconnect keep local data. This is the explicit action that removes the entire local workspace."}</CardDescription></CardHeader><CardContent><Button variant="destructive" onClick={() => void deleteLocalData()}>{italian ? "Elimina tutti i dati locali" : "Delete all local data"}</Button></CardContent></Card>

      <ReconciliationDialog italian={italian} />
    </div>
  );
}

function ConnectionCard(props: { title: string; icon: React.ReactNode; connected: boolean; enabled?: boolean; status?: string; errorKind?: string; lastSync?: string; detail?: string; busy: boolean; connectDisabled?: boolean; onToggle?: (enabled: boolean) => void | Promise<void>; onConnect: () => void | Promise<void>; onSync: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onDelete: () => void | Promise<void>; children?: React.ReactNode }) {
  const status = `Status: ${props.status ?? "idle"}${props.errorKind ? ` · ${props.errorKind}` : ""}`;
  return <Card><CardHeader><CardTitle className="flex items-center gap-2">{props.icon}{props.title}</CardTitle><CardDescription>{props.detail ?? (props.connected ? status : "Not connected")}</CardDescription></CardHeader><CardContent className="space-y-3">{props.lastSync && <p className="text-xs text-muted-foreground">Last sync: {props.lastSync}</p>}{props.connected ? <><div className="flex items-center justify-between rounded-md border p-2"><Label>Account data sync</Label><Switch checked={Boolean(props.enabled)} onCheckedChange={(enabled) => void props.onToggle?.(enabled)} /></div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void props.onSync()} disabled={props.busy || !props.enabled}><RefreshCw className="mr-1 h-4 w-4" />Sync</Button>{props.status === "needs-auth" && <Button size="sm" variant="outline" onClick={() => void props.onConnect()} disabled={props.connectDisabled}>Reconnect</Button>}<Button size="sm" variant="outline" onClick={() => void props.onDisconnect()}><Unplug className="mr-1 h-4 w-4" />Disconnect</Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => void props.onDelete()}><Trash2 className="mr-1 h-4 w-4" />Delete remote</Button></div></> : <Button onClick={() => void props.onConnect()} disabled={props.busy || props.connectDisabled}>{props.busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{props.title === "GitHub" ? "Connect OAuth" : "Connect"}</Button>}{props.children}</CardContent></Card>;
}

function ReconciliationDialog({ italian }: { italian: boolean }) {
  const reconciliation = useAccountSyncStore((state) => state.reconciliation);
  const setReconciliation = useAccountSyncStore((state) => state.setReconciliation);
  const [resolving, setResolving] = useState(false);
  return <Dialog open={Boolean(reconciliation)} onOpenChange={(open) => { if (!open && !resolving) setReconciliation(null); }}><DialogContent><DialogHeader><DialogTitle>{italian ? "Copie account differenti" : "Different account copies found"}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">{italian ? "Nessuna copia verrà sovrascritta finché non scegli quella autorevole." : "No copy will be overwritten until you choose the authoritative version."}</p><div className="space-y-2">{reconciliation?.candidates.map((candidate) => <button key={candidate.id} type="button" className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-accent" disabled={resolving} onClick={() => { setResolving(true); void resolveAccountReconciliation(candidate.id).finally(() => setResolving(false)); }}><span><strong>{candidate.label}</strong><br /><span className="text-xs text-muted-foreground">{candidate.snapshot.manifest.modifiedAtUtc} UTC · {candidate.snapshot.manifest.modifiedByDeviceId} · {candidate.snapshot.data.settings.books.length} books · {candidate.snapshot.data.chats.length} chats</span></span><span className="text-xs font-semibold uppercase">{candidate.comparison}</span></button>)}</div><DialogFooter><Button variant="outline" onClick={() => setReconciliation(null)} disabled={resolving}>Cancel</Button></DialogFooter></DialogContent></Dialog>;
}
