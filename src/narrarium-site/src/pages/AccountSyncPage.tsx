import { Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGoogleLogin } from "@react-oauth/google";
import { Clock, Cloud, Github, HardDrive, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { LocalTime } from "@/components/ui/local-time";
import { Switch } from "@/components/ui/switch";
import { GOOGLE_SIGN_IN_SCOPES } from "@/config/googleAuth";
import "@/i18n/googleAccess";
import { GoogleFullAccessNotice } from "@/components/auth/GoogleFullAccessNotice";
import { ensureMsalInitialized, MICROSOFT_SCOPES, microsoftMsalInstance, microsoftSilentRequest, setMicrosoftRememberMe } from "@/config/msal";
import { useConnectionStore } from "@/account/connectionStore";
import { completeGoogleCodeConnection, completeMicrosoftBrokerConnection } from "@/account/brokerConnect";
import { ConnectFlowError, describeConnectError, describeSignInFailure } from "@/account/connectErrors";
import { beginMicrosoftSignIn, type MicrosoftSignInSession } from "@/account/microsoftSignIn";
import { useBrokerAvailability } from "@/hooks/useBrokerAvailability";
import { deleteRemoteAccountData, syncAllAccountReplicas, syncOneAccountReplica, useAccountSyncStore } from "@/account/accountSync";
import "@/i18n/githubApp";
import { connectGitHubCredential } from "@/github/githubConnection";
import { ReconciliationDialog } from "@/components/account/ReconciliationDialog";
import { ConnectionCard } from "@/components/account/ConnectionCard";
import "@/i18n/accountSyncStatus";
import { autoSyncAll, replicaAutoMode } from "@/account/autoSync";
import { credentialMode } from "@/account/credentialMode";
import { loadLocalAccountSnapshot } from "@/account/accountLocalStore";
import type { AccountSyncBackendKind, LocalGoogleConnection, LocalMicrosoftConnection } from "@/account/types";
import { describeSyncFailure } from "@/account/syncFailure";
import { upgradedReplica } from "@/account/brokerConnect";
import { useSettingsStore } from "@/store/settingsStore";
import { deleteAllNarrariumLocalData, getFullDeviceSafetyReport } from "@/account/dataSafety";
import { useAuthStore } from "@/store/authStore";
import { migrateConnectedProviderRepositories } from "@/auth/accountScope";
import { fetchMicrosoftGraph } from "@/drive/microsoftGraph";
import { applyLegacyGoogleChatImport, prepareLegacyGoogleChatImport } from "@/account/legacyGoogleChatImport";

// The check of the Google configuration is read on this page only, and only when it is opened.
const GoogleConfigCheck = lazy(() => import("@/components/account/GoogleConfigCheck").then((module) => ({ default: module.GoogleConfigCheck })));

// The GitHub card's inside (sign-in, installation, the token each book uses) is a chunk of its own: it is read only on this page.
const GitHubAccessSection = lazy(() => import("@/components/account/GitHubAccessSection").then((module) => ({ default: module.GitHubAccessSection })));

export function AccountSyncPage() {
  const { t } = useTranslation();
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
  const [legacyNeedsFullAccess, setLegacyNeedsFullAccess] = useState(false);
  const [googleCheckOpen, setGoogleCheckOpen] = useState(false);
  const [localSummary, setLocalSummary] = useState<{ modifiedAtUtc: string; books: number; chats: number; dirty: boolean } | null>(null);
  const brokerGoogle = useBrokerAvailability("google");
  const brokerMicrosoft = useBrokerAvailability("microsoft");
  const googleIntent = useRef<{ upgrade?: boolean; expectedAccountId?: string; rememberMe?: boolean }>({});
  const microsoftSession = useRef<MicrosoftSignInSession | null>(null);
  const [githubStarting, setGithubStarting] = useState(false);
  const [githubRemember, setGithubRemember] = useState(true);
  const [githubStartError, setGithubStartError] = useState<string | null>(null);
  const [microsoftPending, setMicrosoftPending] = useState(false);
  const rememberId = useId();
  const autoAllId = useId();
  const autoAll = autoSyncAll(configuration);

  const refreshLocalSummary = async () => {
    const snapshot = await loadLocalAccountSnapshot();
    setLocalSummary(snapshot ? { modifiedAtUtc: snapshot.manifest.modifiedAtUtc, books: snapshot.data.settings.books.length, chats: snapshot.data.chats.length, dirty: snapshot.dirty } : null);
  };

  useEffect(() => { void hydrate(); void refreshLocalSummary(); }, [hydrate]);
  useEffect(() => () => microsoftSession.current?.cancel(), []);

  /** What follows every kind of connection: the repositories move to the account, then the replica syncs (if it is on). */
  async function finishConnection(kind: "google-drive" | "onedrive") {
    const migration = await migrateConnectedProviderRepositories();
    if (migration.error) throw migration.error;
    const connection = kind === "google-drive" ? useConnectionStore.getState().configuration.google : useConnectionStore.getState().configuration.microsoft;
    if (connection?.replica.enabled) await syncOneAccountReplica(kind);
    await refreshLocalSummary();
  }

  const googleCodeLogin = useGoogleLogin({
    flow: "auth-code",
    ux_mode: "popup",
    scope: GOOGLE_SIGN_IN_SCOPES,
    onSuccess: async (response) => {
      setBusy("google");
      setError(null);
      setNotice(null);
      const intent = googleIntent.current;
      googleIntent.current = {};
      try {
        const { longLived } = await completeGoogleCodeConnection({ code: response.code, rememberMe: intent.rememberMe ?? rememberMe, expectedAccountId: intent.expectedAccountId, preserveReplica: intent.upgrade });
        await finishConnection("google-drive");
        if (!longLived) setNotice(t("accountSync.credentials.googleNoRefresh"));
      } catch (cause) { setError(describeConnectError(cause, t) ?? String(cause)); }
      finally { setBusy(null); }
    },
    onError: (cause) => setError(describeSignInFailure(cause, "google-drive", t) ?? cause.error_description ?? "Google connection failed."),
    onNonOAuthError: (cause) => { setError(cause.type === "popup_failed_to_open" ? t("accountSync.connectError.popupBlocked") : describeSignInFailure(cause, "google-drive", t) ?? t("accountSync.connectError.renewGoogle", { code: cause.type })); },
  });

  const googleLogin = useGoogleLogin({
    scope: GOOGLE_SIGN_IN_SCOPES,
    onSuccess: async (response) => {
      setBusy("google");
      setError(null);
      const intent = googleIntent.current;
      googleIntent.current = {};
      try {
        const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${response.access_token}` } });
        if (!profileResponse.ok) throw new Error(`Google profile failed (${profileResponse.status}).`);
        const profile = await profileResponse.json() as { sub?: string; name?: string; email?: string; picture?: string };
        if (!profile.sub) throw new Error("Google did not return an immutable account ID.");
        if (intent.expectedAccountId && profile.sub !== intent.expectedAccountId) throw new ConnectFlowError("wrong_account");
        // A long-lived credential already held for this same account is not lost by signing in again with a session token.
        const existing = useConnectionStore.getState().configuration.google;
        const carriedRefreshToken = existing?.identity.providerAccountId === profile.sub ? existing.refreshToken : undefined;
        await useConnectionStore.getState().connectGoogle({
          identity: { provider: "google", providerAccountId: profile.sub, displayName: profile.name || profile.email || "Google", email: profile.email, avatarUrl: profile.picture },
          accessToken: response.access_token,
          accessTokenExpiry: Date.now() + (("expires_in" in response ? Number(response.expires_in) : 3_600) - 60) * 1_000,
          rememberMe: intent.rememberMe ?? rememberMe,
          ...(carriedRefreshToken ? { refreshToken: carriedRefreshToken } : {}),
          // Signing in again after the login lapsed keeps the replica: the changes waiting to sync are not lost.
          ...(intent.upgrade && existing?.identity.providerAccountId === profile.sub ? { replica: upgradedReplica(existing.replica) } : {}),
        });
        useAuthStore.getState().setInteractiveAuth(response.access_token, { provider: "google", providerAccountId: profile.sub, name: profile.name || profile.email || "Google", email: profile.email ?? "", picture: profile.picture ?? "" }, "expires_in" in response ? Number(response.expires_in) : 3_600, intent.rememberMe ?? rememberMe);
        const migration = await migrateConnectedProviderRepositories();
        if (migration.error) throw migration.error;
        await syncOneAccountReplica("google-drive");
        await refreshLocalSummary();
      } catch (cause) { setError(describeConnectError(cause, t) ?? describeSyncFailure(cause, t)); }
      finally { setBusy(null); }
    },
    onError: (cause) => setError(describeSignInFailure(cause, "google-drive", t) ?? cause.error_description ?? "Google connection failed."),
  });

  /** Google: the authorization code flow when the broker serves it, the implicit flow as ever when it does not. */
  function connectGoogleAccount(upgrade = false) {
    const existing = configuration.google;
    googleIntent.current = upgrade && existing ? { upgrade: true, expectedAccountId: existing.identity.providerAccountId, rememberMe: existing.rememberMe } : {};
    setNotice(null);
    if (brokerGoogle === true) googleCodeLogin();
    else googleLogin();
  }

  /** Microsoft: the sign-in window with PKCE when the broker serves it, MSAL as ever when it does not. */
  function connectMicrosoft(upgrade = false) {
    if (brokerMicrosoft === true) connectMicrosoftLongLived(upgrade);
    else void connectMicrosoftWithMsal(upgrade);
  }

  function connectMicrosoftLongLived(upgrade: boolean) {
    setError(null);
    setNotice(null);
    const existing = configuration.microsoft;
    let session: MicrosoftSignInSession;
    try { session = beginMicrosoftSignIn(); } // opens the window here, in the click itself
    catch (cause) { setError(describeConnectError(cause, t) ?? String(cause)); return; }
    microsoftSession.current = session;
    setMicrosoftPending(true);
    void (async () => {
      try {
        const authorization = await session.result;
        setMicrosoftPending(false);
        setBusy("microsoft");
        await completeMicrosoftBrokerConnection({ authorization, rememberMe: upgrade && existing ? existing.rememberMe : rememberMe, expectedHomeAccountId: upgrade ? existing?.homeAccountId : undefined, preserveReplica: upgrade });
        await finishConnection("onedrive");
      } catch (cause) {
        if (!(cause instanceof ConnectFlowError && cause.code === "cancelled")) setError(describeConnectError(cause, t) ?? String(cause));
      } finally {
        if (microsoftSession.current === session) { microsoftSession.current = null; setMicrosoftPending(false); }
        setBusy((current) => (current === "microsoft" ? null : current));
      }
    })();
  }

  function cancelMicrosoftSignIn() {
    microsoftSession.current?.cancel();
    setMicrosoftPending(false);
  }

  async function connectMicrosoftWithMsal(reconnect = false) {
    // Signing in again after the login lapsed keeps the replica (its last sync, its enabled state): the data waiting to sync is not lost.
    const reconnecting = reconnect ? useConnectionStore.getState().configuration.microsoft : undefined;
    setBusy("microsoft");
    setError(null);
    try {
      const keepSignedIn = reconnecting ? reconnecting.rememberMe : rememberMe;
      setMicrosoftRememberMe(keepSignedIn);
      const client = microsoftMsalInstance(keepSignedIn);
      await ensureMsalInitialized(client);
      const login = await client.loginPopup({ scopes: MICROSOFT_SCOPES, prompt: "select_account", ...(reconnecting?.identity.email ? { loginHint: reconnecting.identity.email } : {}) });
      if (!login.account?.homeAccountId || !login.account.localAccountId) throw new Error("Microsoft did not return immutable account IDs.");
      if (reconnecting && login.account.homeAccountId !== reconnecting.homeAccountId) throw new ConnectFlowError("wrong_account");
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
        rememberMe: keepSignedIn,
        ...(reconnecting ? { replica: upgradedReplica(reconnecting.replica) } : {}),
      });
      useAuthStore.getState().setInteractiveAuth(result.accessToken, { provider: "microsoft", providerAccountId: login.account.homeAccountId, name: profile.displayName || profile.mail || "Microsoft", email: profile.mail ?? profile.userPrincipalName ?? "", picture: "", homeAccountId: login.account.homeAccountId, localAccountId: login.account.localAccountId }, Math.max(120, Math.round(((result.expiresOn?.getTime() ?? Date.now() + 3_600_000) - Date.now()) / 1_000)), keepSignedIn);
      const migration = await migrateConnectedProviderRepositories();
      if (migration.error) throw migration.error;
      await syncOneAccountReplica("onedrive");
      await refreshLocalSummary();
    } catch (cause) { setError(describeConnectError(cause, t) ?? describeSignInFailure(cause, "onedrive", t) ?? describeSyncFailure(cause, t)); }
    finally { setBusy(null); }
  }

  async function connectPat() {
    setBusy("github");
    setError(null);
    try { await connectGitHubCredential({ token: pat, kind: "pat", rememberMe }); setPat(""); }
    catch (cause) { setError(String(cause)); setBusy(null); return; }
    // The first sync follows the connection, as with the other services; a failure is shown and stays on the card.
    try {
      if (useConnectionStore.getState().configuration.github?.replica.enabled) await syncOneAccountReplica("github");
      await refreshLocalSummary();
    } catch (cause) { setError(describeSyncFailure(cause, t)); }
    finally { setBusy(null); }
  }

  /** «Connect with GitHub»: the whole page goes to GitHub and comes back to /auth/github/callback, which finishes the connection through the broker. */
  async function connectGitHubApp() {
    setGithubStartError(null);
    setGithubStarting(true);
    try {
      const { createGitHubAppAuthorizationUrl } = await import("@/github/githubOAuth");
      window.location.assign(await createGitHubAppAuthorizationUrl({ rememberMe: githubRemember, returnTo: "/app/account-sync" }));
    } catch (cause) {
      setGithubStartError(t("accountSync.github.startFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
      setGithubStarting(false);
    }
  }

  async function runSync(kind?: AccountSyncBackendKind) {
    setBusy(kind ?? "all");
    setError(null);
    try { if (kind) await syncOneAccountReplica(kind); else await syncAllAccountReplicas(); await refreshLocalSummary(); }
    catch (cause) { setError(describeSyncFailure(cause, t)); }
    finally { setBusy(null); }
  }

  async function importLegacyGoogleChats(fullAccessToken?: string) {
    setBusy("google-legacy-chats");
    setError(null);
    setNotice(null);
    try {
      const plan = await prepareLegacyGoogleChatImport({ token: fullAccessToken });
      setLegacyNeedsFullAccess(false);
      if (!plan.total) {
        setNotice(italian ? "Nessuna chat legacy trovata su Google Drive." : "No legacy chats were found on Google Drive.");
        // Not found with the access Narrarium has: an older version may have kept them where Google hides them. Full access is offered, never assumed.
        if (!fullAccessToken) setLegacyNeedsFullAccess(true);
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
    const connection = kind === "google-drive" ? configuration.google : kind === "onedrive" ? configuration.microsoft : undefined;
    // Google revokes long-lived credentials; Microsoft has no way to, and the question says so.
    const revocation = !connection?.refreshToken ? "" : ` ${t(kind === "google-drive" ? "accountSync.credentials.googleRevokes" : "accountSync.credentials.microsoftNoRevoke")}`;
    if (!window.confirm(`${italian ? "Scollegare il servizio? I dati locali e remoti rimarranno invariati." : "Disconnect this service? Local and remote data will remain unchanged."}${revocation}`)) return;
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

  if (!hydrated) return <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t("accountSync.loading")}</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">{italian ? "Account e sincronizzazione" : "Account & Sync"}</h1>
        <p className="mt-2 text-muted-foreground">{italian ? "Narrarium salva sempre prima su questo dispositivo. Ogni servizio è una replica opzionale indipendente." : "Narrarium always saves to this device first. Every service is an independent optional replica."}</p>
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">{notice}</div>}

      <div className="space-y-1 rounded-lg border p-4" data-testid="auto-sync-all">
        <div className="flex items-center gap-3">
          <Switch id={autoAllId} checked={autoAll} onCheckedChange={(enabled) => void useConnectionStore.getState().setAutoSyncAll(enabled)} aria-describedby={`${autoAllId}-help`} />
          <Label htmlFor={autoAllId} className="font-medium">{t("accountSyncStatus.auto.allTitle")}</Label>
          <span className="text-sm text-muted-foreground">{t(autoAll ? "accountSyncStatus.auto.allOn" : "accountSyncStatus.auto.allOff")}</span>
        </div>
        <p id={`${autoAllId}-help`} className="text-xs text-muted-foreground">{t("accountSyncStatus.auto.allHelp")}</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5" />{italian ? "Workspace locale" : "Local workspace"}</CardTitle><CardDescription>{italian ? "Disponibile senza login e senza connessione." : "Available without login or network access."}</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <span>{localSummary ? `${t("accountSync.local.books", { count: localSummary.books })} · ${t("accountSync.local.chats", { count: localSummary.chats })}` : t("accountSync.local.initializing")}</span>
          {localSummary && <LocalTime value={localSummary.modifiedAtUtc} className="text-muted-foreground" />}
          <span className="font-medium">{localSummary?.dirty ? (italian ? "Salvato localmente · sync in attesa" : "Saved locally · sync pending") : (italian ? "Salvato localmente" : "Saved locally")}</span>
          {localSummary?.dirty
            ? <Button className="ml-auto" onClick={() => void runSync()} disabled={syncing || busy !== null}><RefreshCw className="mr-2 h-4 w-4" />{italian ? "Sincronizza ora" : "Sync now"}</Button>
            : <Button className="ml-auto" variant="ghost" size="sm" onClick={() => void runSync()} disabled={syncing || busy !== null}>{t("accountSyncStatus.sync.checkNow")}</Button>}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch id={rememberId} checked={rememberMe} onCheckedChange={setRememberMe} aria-describedby={`${rememberId}-hint`} />
        <div><Label htmlFor={rememberId}>{italian ? "Ricorda la connessione su questo dispositivo" : "Remember connection on this device"}</Label><p id={`${rememberId}-hint`} className="text-xs text-muted-foreground">{italian ? "Le credenziali vengono controllate solo durante operazioni remote." : "Credentials are checked only during remote operations."}{(brokerGoogle === true || brokerMicrosoft === true) && ` ${t("accountSync.credentials.rememberHint")}`}</p></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ConnectionCard title="Google Drive" icon={<Cloud className="h-5 w-5" />} localDirty={Boolean(localSummary?.dirty)} autoSyncAll={autoAll} autoMode={configuration.google ? replicaAutoMode(configuration.google.replica) : undefined} onFollowGeneral={() => useConnectionStore.getState().setAutoMode("google-drive", "inherit")} connected={Boolean(configuration.google)} credentialMode={configuration.google ? credentialMode(configuration.google) : null} brokerAvailable={brokerGoogle} onUpgrade={() => connectGoogleAccount(true)} enabled={configuration.google?.replica.enabled} status={configuration.google?.replica.status} errorKind={configuration.google?.replica.errorKind} errorMessage={configuration.google?.replica.lastErrorMessage} lastSync={configuration.google?.replica.lastSuccessfulSyncAtUtc} busy={syncing || busy === "google" || busy === "google-drive" || busy === "google-legacy-chats"} onToggle={(enabled) => useConnectionStore.getState().setEnabled("google-drive", enabled)} credentials={configuration.google && <CredentialStatus provider="google" connection={configuration.google} brokerAvailable={brokerGoogle} busy={syncing || busy !== null} onUpgrade={() => connectGoogleAccount(true)} />} onConnect={() => connectGoogleAccount()} onReconnect={() => connectGoogleAccount(true)} onSync={() => runSync("google-drive")} onDisconnect={() => disconnect("google-drive")} onDelete={() => removeRemote("google-drive")}>
          <div className="space-y-2 border-t pt-3"><Button size="sm" variant="ghost" aria-expanded={googleCheckOpen} onClick={() => setGoogleCheckOpen((open) => !open)}>{googleCheckOpen ? t("googleAccess.check.close") : t("googleAccess.check.open")}</Button>{googleCheckOpen && <Suspense fallback={<p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("accountSync.loading")}</p>}><GoogleConfigCheck /></Suspense>}</div>
          {configuration.google && <div className="space-y-2 border-t pt-3"><p className="text-xs text-muted-foreground">{italian ? "Recupera le conversazioni conservate nella vecchia cartella Google Drive/Narrarium/chats. L'importazione non modifica i file originali." : "Recover conversations stored in the old Google Drive/Narrarium/chats folder. Importing does not modify the original files."}</p><Button size="sm" variant="outline" onClick={() => void importLegacyGoogleChats()} disabled={syncing || busy !== null}>{busy === "google-legacy-chats" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{italian ? "Importa chat legacy" : "Import legacy chats"}</Button>{legacyNeedsFullAccess && <><p className="text-xs text-muted-foreground">{t("googleAccess.legacy.notFound")}</p><GoogleFullAccessNotice reason="legacy" hint={configuration.google.identity.email} onDismiss={() => setLegacyNeedsFullAccess(false)} onGranted={(grant) => void importLegacyGoogleChats(grant.accessToken)} /></>}</div>}
        </ConnectionCard>
        <ConnectionCard title="OneDrive" icon={<Cloud className="h-5 w-5" />} localDirty={Boolean(localSummary?.dirty)} autoSyncAll={autoAll} autoMode={configuration.microsoft ? replicaAutoMode(configuration.microsoft.replica) : undefined} onFollowGeneral={() => useConnectionStore.getState().setAutoMode("onedrive", "inherit")} connected={Boolean(configuration.microsoft)} credentialMode={configuration.microsoft ? credentialMode(configuration.microsoft) : null} brokerAvailable={brokerMicrosoft} onUpgrade={() => connectMicrosoft(true)} enabled={configuration.microsoft?.replica.enabled} status={configuration.microsoft?.replica.status} errorKind={configuration.microsoft?.replica.errorKind} errorMessage={configuration.microsoft?.replica.lastErrorMessage} lastSync={configuration.microsoft?.replica.lastSuccessfulSyncAtUtc} busy={syncing || busy === "microsoft" || busy === "onedrive"} credentials={configuration.microsoft && <CredentialStatus provider="microsoft" connection={configuration.microsoft} brokerAvailable={brokerMicrosoft} busy={syncing || busy !== null} onUpgrade={() => connectMicrosoft(true)} />} onToggle={(enabled) => useConnectionStore.getState().setEnabled("onedrive", enabled)} onConnect={() => connectMicrosoft()} onReconnect={() => connectMicrosoft(true)} onSync={() => runSync("onedrive")} onDisconnect={() => disconnect("onedrive")} onDelete={() => removeRemote("onedrive")}>
          <div role="status" className={microsoftPending ? "space-y-1 border-t pt-3 text-xs" : undefined}>{microsoftPending && <><p className="flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /><span>{t("accountSync.microsoftSignIn.waiting")}</span></p><p className="text-muted-foreground">{t("accountSync.microsoftSignIn.hint")}</p></>}</div>
          {microsoftPending && <Button size="sm" variant="outline" onClick={cancelMicrosoftSignIn}>{t("common.cancel")}</Button>}
        </ConnectionCard>
        <ConnectionCard title="GitHub" icon={<Github className="h-5 w-5" />} localDirty={Boolean(localSummary?.dirty)} autoSyncAll={autoAll} autoMode={configuration.github ? replicaAutoMode(configuration.github.replica) : undefined} onFollowGeneral={() => useConnectionStore.getState().setAutoMode("github", "inherit")} connected={Boolean(configuration.github)} enabled={configuration.github?.replica.enabled} status={configuration.github?.replica.status} errorKind={configuration.github?.replica.errorKind} errorMessage={configuration.github?.replica.lastErrorMessage} lastSync={configuration.github?.replica.lastSuccessfulSyncAtUtc} detail={configuration.github ? `${configuration.github.identity?.username ?? "GitHub"} · ${configuration.github.credentialKind === "app" ? "GitHub App" : "PAT"}` : undefined} busy={syncing || busy === "github"} hideConnect onToggle={(enabled) => useConnectionStore.getState().setEnabled("github", enabled)} onConnect={() => void connectGitHubApp()} onReconnect={() => (configuration.github?.credentialKind === "app" ? void connectGitHubApp() : document.getElementById("github-pat")?.focus())} onSync={() => runSync("github")} onDisconnect={() => disconnect("github")} onDelete={() => removeRemote("github")}>
          <Suspense fallback={<p className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("accountSync.loading")}</p>}>
            <GitHubAccessSection connection={configuration.github} rememberMe={githubRemember} onRememberChange={setGithubRemember} onConnect={() => void connectGitHubApp()} starting={githubStarting} startError={githubStartError} pat={pat} onPatChange={setPat} onConnectPat={() => void connectPat()} onRetrySync={() => void runSync("github")} busy={busy !== null} />
          </Suspense>
        </ConnectionCard>
      </div>

      {(configuration.google || configuration.microsoft || configuration.github) && <Button variant="outline" className="h-auto min-h-9 whitespace-normal text-left" onClick={() => void disconnectAll()}>{italian ? "Disconnetti tutti gli account e continua in locale" : "Disconnect all accounts and continue locally"}</Button>}

      <Card className="border-destructive/40"><CardHeader><CardTitle>{italian ? "Zona pericolosa" : "Danger zone"}</CardTitle><CardDescription>{italian ? "Logout e disconnessione non eliminano i dati. Questa è l'unica azione che rimuove l'intero workspace locale." : "Logout and disconnect keep local data. This is the explicit action that removes the entire local workspace."}</CardDescription></CardHeader><CardContent><Button variant="destructive" onClick={() => void deleteLocalData()}>{italian ? "Elimina tutti i dati locali" : "Delete all local data"}</Button></CardContent></Card>

      <ReconciliationDialog />
    </div>
  );
}

/**
 * How this connection stays signed in. A session connection is only described, and long-lived credentials offered,
 * where the broker serves the provider: without it nothing here changes and nothing is offered. The state is said in
 * words; the icon only decorates.
 */
function CredentialStatus(props: { provider: "google" | "microsoft"; connection: LocalGoogleConnection | LocalMicrosoftConnection; brokerAvailable: boolean | null; busy: boolean; onUpgrade: () => void }) {
  const { t } = useTranslation();
  const mode = credentialMode(props.connection);
  const offer = mode === "session" && props.brokerAvailable === true;
  // Where the broker does not serve the provider, a session connection is all there is: say so, and why it ends.
  if (mode === "session" && props.brokerAvailable === false) {
    return (
      <p className="flex items-start gap-2 rounded-md border p-2 text-xs text-muted-foreground">
        <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t(props.provider === "google" ? "accountSync.credentials.sessionNoLongLivedGoogle" : "accountSync.credentials.sessionNoLongLivedMicrosoft")}</span>
      </p>
    );
  }
  if (mode === "session" && !offer) return null;
  const Icon = mode === "session" ? Clock : ShieldCheck;
  const label = mode === "long-lived" ? t("accountSync.credentials.longLived") : mode === "long-lived-memory" ? t("accountSync.credentials.longLivedMemory") : t(props.provider === "google" ? "accountSync.credentials.sessionGoogle" : "accountSync.credentials.sessionMicrosoft");
  return (
    <div className="space-y-2 rounded-md border p-2">
      <p className="flex items-start gap-2 text-sm font-medium"><Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span>{label}</span></p>
      {offer && <p className="text-xs text-muted-foreground">{t("accountSync.credentials.explain")}</p>}
      {mode !== "session" && <p className="text-xs text-muted-foreground">{t(props.provider === "google" ? "accountSync.credentials.googleRevokes" : "accountSync.credentials.microsoftNoRevoke")}</p>}
      {offer && <Button size="sm" variant="outline" onClick={props.onUpgrade} disabled={props.busy}>{t("accountSync.credentials.upgrade")}</Button>}
    </div>
  );
}
