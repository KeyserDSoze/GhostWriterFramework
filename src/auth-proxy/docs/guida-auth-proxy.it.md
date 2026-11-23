# Guida: creare e mettere in servizio il proxy di autenticazione (`auth-proxy`), da riga di comando

Guida passo passo per il proprietario. Il Worker che prima si chiamava `models-github-proxy` (serviva a GitHub Models) ora serve soprattutto l'**autenticazione**: tiene i client secret di Google, Microsoft e GitHub perché il sito resti collegato a Google Drive, OneDrive e (con un rilascio successivo del sito) a GitHub. Per questo si chiama **`auth-proxy`**, vive in `src/auth-proxy/` e resta su Cloudflare. Dentro c'è ancora il proxy per GitHub Models, **in dismissione**: si può togliere quando GitHub Models non servirà più.

Versione inglese breve: [`auth-proxy-setup.en.md`](auth-proxy-setup.en.md). Riferimento tecnico del Worker: [`../README.md`](../README.md).

Come leggerla: ogni passo ha il **comando verificato** e una riga **Verifica** (cosa devi vedere). Se non la vedi, fermati. «Verificato» vuol dire che ho letto l'aiuto del comando (`--help`, `cf cli search`, `cf schema`) o che l'ho provato con `--dry-run` senza credenziali; ciò che non ho potuto verificare è elencato in fondo (sezione 8). Fonti ufficiali con data di consultazione (23 novembre 2026) nella sezione 9.

**Regola d'oro:** nessun segreto (token API, client secret, refresh token) in una riga di comando, in una issue, in una chat, in un commit o in `wrangler.toml`. Ogni comando che usa un tuo segreto lo legge da input nascosto o da stdin.

---

## 0. Cosa è già fatto e cosa no

**Già fatto (in questa modifica):**

- Il codice è passato da `infra/models-github-proxy` a `src/auth-proxy`; `wrangler.toml` ha `name = "auth-proxy"`: sarà un Worker **nuovo** su `https://auth-proxy.alessandro-rapiti44.workers.dev`. Il vecchio `models-github-proxy` non viene toccato e il sito continua a usarlo finché non cambia la variabile `VITE_GITHUB_MODELS_BASE`.
- Il workflow è `.github/workflows/deploy-auth-proxy.yml` («Deploy auth proxy»): test, carica i client secret che esistono, `wrangler deploy` (Wrangler 4), poi scrive nel riepilogo una tabella Google/Microsoft/GitHub «configurato / non configurato» leggendo lo stato del Worker **appena pubblicato** (l'URL è l'output `deployment-url` dello step di deploy; la variabile `VITE_GITHUB_MODELS_BASE` è solo il ripiego).
- Il Worker non è più un workspace npm e non dipende da Wrangler (lo porta `wrangler-action`; in locale si usa `npx wrangler`).
- Script: `scripts/set-secrets.sh` (carica i segreti con input nascosto), `scripts/check-status.mjs` (stato a parole), `scripts/check-microsoft-app.sh` (controllo di sola lettura dell'app Microsoft con `az`).
- Sul repository esistono già i secret `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`.

**Non ancora fatto (tocca a te, in quest'ordine):** sezione 1 (strumenti) → sezione 2 (spostamento del Worker) con 3 e 4 (Microsoft e Google) → 5 (rafforzare Cloudflare, facoltativo) → 6 (GitHub App, più avanti).

---

## 1. Installare gli strumenti e accedere

| Strumento | A cosa serve | Obbligatorio |
| --- | --- | --- |
| `gh` | secret, variabili, workflow | sì (è già autenticato) |
| `cf` | amministrare Cloudflare (elenco Worker, segreti per nome, token, cancellazione) | consigliato |
| `npx wrangler` | log in diretta, versioni, deploy locale di prova | consigliato |
| `az` | app Microsoft | per la sezione 3 |
| `gcloud` | abilitare l'API Drive | facoltativo |

### 1.1 `gh`

```bash
gh auth status
```

**Verifica:** «Logged in to github.com» e, tra gli *scopes*, `repo` e `workflow` (serve a lanciare i workflow). Se manca `workflow`: `gh auth refresh -s workflow`.

### 1.2 `cf` (la nuova CLI di Cloudflare, 1.0 release candidate)

```bash
npm install --global cf
cf --version                  # verificato: 1.0.0-rc.4
cf auth login                 # apre il browser; su un server senza browser: cf auth login --no-browser
cf auth whoami
export CLOUDFLARE_ACCOUNT_ID=<id account>   # in uno script serve; l'ID si copia con Ctrl+K "Copy account ID" nel dashboard
```

- `cf auth login` usa per default il flusso a codice («device»); `--no-browser` stampa il link invece di aprirlo. Verificato con `cf auth login --help`.
- **`cf` non riusa il login di Wrangler** (e viceversa): sono due accessi separati, ognuno con le sue credenziali. `cf auth logout` toglie quello di `cf`.
- Se nell'ambiente c'è `CLOUDFLARE_API_TOKEN`, `cf` usa **quello** al posto del login (è la prima fonte di credenziali, dal README di `cf`): non esportarlo se vuoi usare il login.
- `cf auth scopes` mostra cosa può fare il login.

**Verifica:** `cf auth whoami` stampa il tuo utente (JSON) e `cf workers list` elenca i Worker dell'account, tra cui `models-github-proxy`.

### 1.3 Wrangler (solo per i comandi che `cf` non sostituisce bene)

Non è più una dipendenza del repository: si usa `npx wrangler`.

```bash
cd src/auth-proxy
npx wrangler login            # una volta; apre il browser (--device per un server senza browser)
npx wrangler whoami
```

**Verifica:** `npx wrangler whoami` mostra il tuo account. (Verificato: Wrangler 4.167.0 `--help`.)

### 1.4 `az` (Azure CLI)

```bash
az login --allow-no-subscriptions     # --use-device-code se non c'è un browser
az ad app show --id a80b2024-b9e3-4cb1-8480-aac7f164a6eb --query displayName -o tsv
```

`--allow-no-subscriptions` serve perché basta il tenant (non ci sono sottoscrizioni Azure). **Verifica:** l'ultimo comando stampa il nome dell'app registrata.

### 1.5 `gcloud` (facoltativo)

```bash
gcloud auth login
gcloud config set project <ID del progetto Google Cloud>
```

**Verifica:** `gcloud config get project` stampa il progetto che contiene il client OAuth.

---

## 2. Spostare il Worker: da `models-github-proxy` ad `auth-proxy`

L'ordine conta: **il sito deve poter funzionare in ogni momento**, quindi il Worker vecchio si cancella per ultimo.

### 2.0 Prima di cominciare: i client ID devono coincidere

Gli ID pubblici sono già nel repository (non servono nuovi). Controlla solo che il Worker e il sito usino gli stessi:

```bash
grep -ho '91477716497-[a-z0-9]*\.apps\.googleusercontent\.com' src/auth-proxy/wrangler.toml src/narrarium-site/src/config/publicClients.ts
grep -ho 'a80b2024-[0-9a-f-]*' src/auth-proxy/wrangler.toml src/narrarium-site/src/config/publicClients.ts
```

**Verifica:** ogni comando stampa **due righe uguali** (una per file). Se differiscono, cambiali insieme (come dice il commento in `wrangler.toml`).

### 2.a Unire questa modifica in `main`

Il workflow `deploy-auth-proxy.yml` esiste solo dopo il merge. Il merge fa partire da solo il deploy del Worker **nuovo** (cambia `src/auth-proxy/**`), senza segreti: va bene, la tabella dirà «non configurato». Parte anche «Deploy Narrarium Site» perché cambia il `package.json` radice: ripubblica lo stesso sito, senza altre modifiche.

```bash
gh run list --workflow deploy-auth-proxy.yml --limit 3
gh run watch <id> --exit-status
```

**Verifica:** l'esecuzione è verde e nel riepilogo (pagina dell'esecuzione) c'è la tabella «Worker sign-in status» con l'indirizzo `https://auth-proxy.<sottodominio>.workers.dev`. Poi `cf workers list` mostra **due** Worker: `models-github-proxy` e `auth-proxy`.

### 2.b Pubblicare il Worker nuovo (se non è già partito)

```bash
gh workflow run deploy-auth-proxy.yml
gh run watch --exit-status        # sceglie l'esecuzione appena avviata
```

Il Worker nuovo viene **creato** dal token Cloudflare che hai già (quello che creò il vecchio). Non stringere il token prima di questo passo: per creare un Worker nuovo Cloudflare chiede un permesso più alto di quello per aggiornarne uno esistente (sezione 5.1).

**Verifica:** `cf workers deployments list --worker auth-proxy` mostra un deploy attivo.

### 2.c Caricare i client secret (input nascosto)

Hai già il client secret di Google (di solito inizia con `GOCSPX-`) e il **Valore** di quello Microsoft (non l'«ID del segreto»).

```bash
src/auth-proxy/scripts/set-secrets.sh --dry-run     # cosa farebbe, senza chiedere nulla
src/auth-proxy/scripts/set-secrets.sh               # chiede Google, Microsoft, GitHub (Invio = salta); poi, se vuoi, lancia il deploy
```

Lo script usa `read -rs` (non mostra nulla) e passa il valore a `gh secret set` da stdin: non finisce né nella lista dei processi né nella cronologia. Salta GitHub con Invio (la App si registra più avanti, sezione 6). Se rifiuta il valore di Microsoft perché «sembra l'ID del segreto», hai copiato la colonna sbagliata.

**Verifica:** `gh secret list` mostra `GOOGLE_OAUTH_CLIENT_SECRET` e `MICROSOFT_OAUTH_CLIENT_SECRET` (solo i nomi). Dopo il deploy, `cf workers secrets list --worker auth-proxy` mostra `GOOGLE_CLIENT_SECRET` e `MICROSOFT_CLIENT_SECRET` (solo i nomi: i valori non si leggono mai).

### 2.d Controllare lo stato del Worker nuovo

```bash
node src/auth-proxy/scripts/check-status.mjs https://auth-proxy.alessandro-rapiti44.workers.dev
curl -s https://auth-proxy.alessandro-rapiti44.workers.dev/oauth/status
```

(`check-status.mjs` prende l'indirizzo come argomento; la variabile del repository la usa solo come ripiego, ed ora punta ancora al Worker vecchio.)

**Verifica:** `{"google":true,"microsoft":true,"github":false}` (GitHub resta `false` finché non c'è la App). Prova con un token inventato che id e segreto siano accettati:

```bash
curl -s -X POST https://auth-proxy.alessandro-rapiti44.workers.dev/oauth/google/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"prova"}'
```

Risposta giusta: `{"error":"invalid_grant",...}`. Se è `upstream_error` con `invalid_client`: segreto o ID sbagliati.

### 2.e Far usare il Worker nuovo al sito

```bash
gh variable set VITE_GITHUB_MODELS_BASE --body https://auth-proxy.alessandro-rapiti44.workers.dev
gh workflow run book-management-system.yml        # «Deploy Narrarium Site»: ripubblica il sito con la variabile nuova
gh run watch --exit-status
```

(L'indirizzo non è un segreto: `--body` va bene. Il nome della variabile resta quello vecchio, per ora.)

**Verifica:** a sito ripubblicato, negli strumenti di sviluppo del browser (scheda *Network*) le richieste `/oauth/status` vanno a `auth-proxy.alessandro-rapiti44.workers.dev`.

### 2.f Provare un collegamento vero

1. *Account e sincronizzazione* → ricollega **Google Drive** (serve riautorizzare una volta, per avere il refresh token). Attendi più di un'ora e riapri il sito: non deve chiedere un nuovo accesso.
2. Lo stesso con **OneDrive**; il collegamento deve restare oltre le 24 ore.
3. Se Google dà `redirect_uri_mismatch` al primo collegamento, vedi 4.3 (caso noto, non provato dal vivo).

### 2.g Solo ora: cancellare il Worker vecchio

Aspetta qualche giorno dopo il passo f: chi ha ancora in cache la versione vecchia del sito parla con il Worker vecchio finché non ricarica. Poi:

```bash
cf workers delete models-github-proxy --dry-run      # mostra la richiesta DELETE senza eseguirla (verificato)
cf workers delete models-github-proxy                # chiede conferma (-f per non chiederla)
# oppure, equivalente con Wrangler:
npx wrangler delete models-github-proxy --dry-run
npx wrangler delete models-github-proxy
```

I suoi segreti spariscono con lui. Se il vecchio token API non serve più, vedi 5.1.

**Verifica:** `cf workers list` non elenca più `models-github-proxy`, e `curl -s -o /dev/null -w '%{http_code}\n' https://models-github-proxy.alessandro-rapiti44.workers.dev/oauth/status` non risponde `200`.

---

## 3. Microsoft con `az`

L'app esiste già (`a80b2024-b9e3-4cb1-8480-aac7f164a6eb`, usata da MSAL). Si **aggiunge** la piattaforma Web per il Worker senza toccare quella a pagina singola.

### 3.1 Guardare com'è oggi (sola lettura)

```bash
src/auth-proxy/scripts/check-microsoft-app.sh
```

Stampa: tipi di account supportati, URI «Web» (con OK / MANCA per ognuno dei quattro attesi, presi da `wrangler.toml`), URI «Single-page application» (non vengono toccati: servono a MSAL), permessi delegati di Graph e **scadenza** dei client secret (mai il valore). Non cambia nulla: se manca qualcosa, **stampa il comando** da lanciare. Esce con 0 se tutto è come previsto, 3 se manca qualcosa.

**Verifica:** leggi l'elenco; ogni riga `MANCA` / `SBAGLIATA` è un lavoro dei passi seguenti.

### 3.2 Tipi di account

Il Worker usa l'authority `common`: l'app deve accettare anche gli account personali.

```bash
az ad app update --id a80b2024-b9e3-4cb1-8480-aac7f164a6eb --sign-in-audience AzureADandPersonalMicrosoftAccount
```

(Valori ammessi verificati con `az ad app update --help`: `AzureADMultipleOrgs`, `AzureADMyOrg`, `AzureADandPersonalMicrosoftAccount`, `PersonalMicrosoftAccount`.) Fallo solo se lo script dice «DA CORREGGERE». **Verifica:** il controllo dice «OK: include gli account Microsoft personali».

### 3.3 URI di ritorno «Web», **unendo** quelli esistenti

`--web-redirect-uris` **sostituisce l'intera lista** (verificato nell'aiuto: «Space-separated values»): se ne passi quattro, quelli già presenti spariscono. Perciò il comando va costruito unendo. Lo script lo stampa già pronto; a mano:

```bash
APP=a80b2024-b9e3-4cb1-8480-aac7f164a6eb
az ad app show --id $APP --query "web.redirectUris" -o tsv       # gli URI Web di oggi
az ad app update --id $APP --web-redirect-uris \
  <quelli di oggi, separati da spazio> \
  https://narrarium.net/auth/microsoft-callback.html \
  https://www.narrarium.net/auth/microsoft-callback.html \
  http://localhost:5173/auth/microsoft-callback.html \
  http://localhost:4173/auth/microsoft-callback.html
```

Gli URI «Single-page application» (`…/msal-popup.html`) stanno in un'altra proprietà (`spa.redirectUris`) e non vengono toccati da questo comando. **Non** mettere i quattro nuovi sotto «Single-page application»: lì il refresh token dura al massimo 24 ore e lo scambio con il segreto fallisce (`AADSTS9002327`).

**Verifica:** rilancia `check-microsoft-app.sh`: i quattro URI sono `OK` e quelli MSAL ci sono ancora.

### 3.4 Permessi delegati (senza consenso amministratore)

Si dichiarano `User.Read`, `Files.ReadWrite`, `offline_access`, `openid`, `profile` di Microsoft Graph. Gli ID dei permessi **non si copiano a mano**: si ricavano.

```bash
APP=a80b2024-b9e3-4cb1-8480-aac7f164a6eb
GRAPH=00000003-0000-0000-c000-000000000000
for p in User.Read Files.ReadWrite offline_access openid profile; do
  id=$(az ad sp show --id $GRAPH --query "oauth2PermissionScopes[?value=='$p'].id | [0]" -o tsv)
  az ad app permission add --id $APP --api $GRAPH --api-permissions "$id=Scope"
done
```

`Scope` = permesso *delegato* (verificato in `az ad app permission add --help`). **Non** lanciare `az ad app permission admin-consent` né `grant`: servirebbe un amministratore e non serve qui, gli utenti danno il consenso al primo collegamento (quelli già collegati con MSAL lo hanno già dato per gli stessi permessi). Aggiungi solo quelli che lo script dice mancanti.

**Verifica:** `check-microsoft-app.sh` elenca i cinque permessi e dice «OK: User.Read, Files.ReadWrite e offline_access ci sono».

### 3.5 Il client secret: scadenza e rotazione

Il secret ha una scadenza (massimo 24 mesi): lo script la mostra. Metti la data in un promemoria (30 giorni prima). Quando scade, il Worker non rinnova più i token Microsoft (`invalid_client`).

**Rotazione senza interruzioni** (i refresh token già emessi restano validi):

1. Crea un **secondo** secret e lascia il vecchio. Dal portale (Entra → App registrations → l'app → Certificates & secrets → New client secret; copia il **Valore**), oppure da CLI **con `--append`** (senza, `az ad app credential reset` **cancella tutti** i secret esistenti) facendo passare il valore da una pipe, senza mostrarlo:

   ```bash
   az ad app credential reset --id $APP --append --display-name narrarium-worker --years 2 --query password -o tsv \
     | tr -d '\r\n' | gh secret set MICROSOFT_OAUTH_CLIENT_SECRET
   ```

   (`--append`, `--display-name`, `--years` verificati in `az ad app credential reset --help`; il comando completo non l'ho potuto provare senza accesso.)
2. `gh workflow run deploy-auth-proxy.yml`, poi `check-status.mjs`, poi collega un account di prova.
3. Solo ora elimina il vecchio: `az ad app credential list --id $APP --query "[].[keyId,displayName,endDateTime]" -o tsv` (solo metadati) e `az ad app credential delete --id $APP --key-id <keyId>`.

**Verifica:** `check-microsoft-app.sh` mostra la nuova data di scadenza.

---

## 4. Google: lista di controllo (non esiste una CLI per il client OAuth)

Il client OAuth «Web» del progetto si gestisce solo dalla console. L'ID è già nel repository (`91477716497-k7n97b2q9ic3nc75jpjmb0d3f73s1vgu.apps.googleusercontent.com`): **non serve fornirlo, serve controllare che coincida** (passo 2.0).

### 4.1 Console (Google Cloud → **Google Auth Platform**)

1. **Audience:** tipo utente *External*; stato di pubblicazione **In production** (se è *Testing*, premi **Publish app**). In *Testing* i refresh token scadono dopo 7 giorni.
2. **Clients** → il client «Web application» `91477716497-…`:
   - **Authorized JavaScript origins** (esatte, senza `/` finale): `https://narrarium.net`, `https://www.narrarium.net`, `http://localhost:5173`, `http://localhost:4173`.
   - **Authorized redirect URIs:** nessuno (flusso a popup).
   - **Client secrets:** il segreto che hai già vale; se vuoi uno nuovo, **Add secret** e copialo subito.
3. **Data Access:** il sito chiede `drive.appdata`, `drive`, `openid`, `profile`, `email` (`src/narrarium-site/src/config/googleAuth.ts`). `drive` è un ambito **restricted**: finché l'app non è verificata, gli utenti vedono l'avviso «app non verificata». Per uso personale si può proseguire; le alternative (chiedere la verifica o far chiedere al sito solo ambiti non sensibili) sono decisioni del prodotto.

**Verifica:** *Publishing status: In production*; le quattro origini nell'elenco.

### 4.2 API Drive (probabilmente già abilitata)

```bash
gcloud services enable drive.googleapis.com --project <ID progetto>
gcloud services list --enabled --project <ID progetto> --filter="name:drive.googleapis.com"
```

(Sintassi verificata sulla documentazione di `gcloud services enable` / `list`; `gcloud` non è installato in questa macchina, quindi non l'ho eseguita.) **Verifica:** il secondo comando elenca `drive.googleapis.com`.

### 4.3 Caso noto, non provato dal vivo

Se il primo collegamento di Google dà `502 upstream_error` con `redirect_uri_mismatch`: la documentazione di Google (aggiornata il 29 ottobre 2026) dice che nel flusso a popup il `redirect_uri` dello scambio è **l'origine della pagina**, mentre il Worker invia `postmessage` (valore non documentato, che molti sviluppatori riportano funzionante). In quel caso la correzione è nel Worker: segnalalo, non cambiare nulla nella console.

---

## 5. Rafforzare Cloudflare (facoltativo, dopo che tutto funziona)

### 5.1 Token API con il minimo dei privilegi

Oggi `CLOUDFLARE_API_TOKEN` è quello che hai già creato (probabilmente il modello «Edit Cloudflare Workers», più largo del necessario). Per stringerlo, **dopo** aver pubblicato il Worker nuovo (2.b):

1. Cerca l'ID del gruppo di permessi **senza scriverlo a mano** (cambia tra account e versioni):

   ```bash
   cf accounts tokens permission-groups list --name Workers%20Scripts%20Write     # il nome va codificato (verificato nell'aiuto)
   ```

2. Crea il token (`cf accounts tokens create`; verificato: `--name`, `--expires-on`, `--policies @file`). Serve un chiamante con il permesso di creare token: il login di `cf` può non bastare; in quel caso usa **una volta** un token amministratore preso dal dashboard, letto da input nascosto (`read -rs CLOUDFLARE_API_TOKEN; export CLOUDFLARE_API_TOKEN`) e poi `unset CLOUDFLARE_API_TOKEN`.

   ```bash
   GROUP_ID=$(cf accounts tokens permission-groups list --name Workers%20Scripts%20Write | jq -r '[.. | objects | select(.name? == "Workers Scripts Write") | .id][0]')
   printf '[{"effect":"allow","permission_groups":[{"id":"%s"}],"resources":{"com.cloudflare.api.account.%s":"*"}}]' "$GROUP_ID" "$CLOUDFLARE_ACCOUNT_ID" > /tmp/auth-proxy-policy.json
   cf accounts tokens create --name narrarium-auth-proxy-deploy --expires-on 2027-11-23T00:00:00Z --policies @/tmp/auth-proxy-policy.json --dry-run   # prima guarda la richiesta
   ```

   Togli `--dry-run` per crearlo. Il valore del token compare **una sola volta**: non lasciarlo sullo schermo, passalo a `gh secret set CLOUDFLARE_API_TOKEN` da una pipe (la forma esatta del JSON di risposta non l'ho potuta vedere: guarda prima l'uscita di `--dry-run` e adatta il filtro `jq`), oppure copialo dal dashboard (*Manage Account → Account API Tokens → Create Token*).
3. **Cosa dà e cosa no:** «Workers Scripts Write» vale per **tutti i Worker dell'account** (è *account-wide*). Più stretto: il ruolo **Editor limitato a un solo Worker** (documentazione «Workers roles and permissions»), che dal dashboard si assegna a `auth-proxy`; non ho verificato come scriverlo nella `--policies` da CLI, quindi per quella strada usa il dashboard. Attenzione: un token «Editor» **non può creare** Worker nuovi (serve Admin di prodotto) né cancellarli: va bene per i deploy successivi, non per la creazione.
4. `gh workflow run deploy-auth-proxy.yml` e `gh run watch --exit-status`. **Solo se è verde**, elimina il vecchio: `cf accounts tokens list` (se il vecchio è un token di account; trovi l'`id`) e `cf accounts tokens delete <id>`. Un token «personale» (My Profile → API Tokens) si elimina dal dashboard.
5. Scadenza e rotazione: promemoria 2 settimane prima; `cf accounts tokens roll <id>` genera un nuovo valore e invalida il vecchio **subito** (verificato nell'aiuto): subito dopo `gh secret set CLOUDFLARE_API_TOKEN`, poi un deploy.

**Verifica:** il deploy con il token nuovo è verde. Se fallisce con un errore di autenticazione (codice 10000), aggiungi *Account Settings → Read* al token e riprova.

### 5.2 Guardare cosa c'è sul Worker

```bash
cf workers get auth-proxy
cf workers deployments list --worker auth-proxy          # il primo è quello attivo
cf workers versions list --worker auth-proxy
cf workers secrets list --worker auth-proxy              # solo i nomi
npx wrangler deployments list --name auth-proxy          # equivalenti Wrangler
npx wrangler versions list --name auth-proxy
npx wrangler secret list --name auth-proxy
cd src/auth-proxy && npx wrangler deploy --dry-run --outdir /tmp/auth-proxy-out   # nessun accesso: controlla il file e mostra i binding
```

**Verifica:** `wrangler deploy --dry-run` elenca `env.OAUTH_RATE_LIMITER (30 requests/60s) Rate Limit` e le variabili (verificato con Wrangler 4.167.0).

### 5.3 Log in diretta, **senza** cambiare le impostazioni del Worker

Il Worker non scrive nulla nei log. **Non cambiare l'impostazione `observability`** (non è nel `wrangler.toml`: resta com'è, qualunque sia). Per vedere le richieste:

```bash
npx wrangler tail auth-proxy --status error --format pretty
```

Funziona senza Workers Logs (usa i log in tempo reale). L'equivalente `cf observability tail --worker auth-proxy` (verificato nell'aiuto) **richiede Workers Logs attivi** («Worker events require Workers logs»): funziona solo se Workers Logs sono attivi per questo Worker (Cloudflare li abilita di default sui Worker nuovi, ma `wrangler.toml` non li dichiara e non ho potuto vedere lo stato reale: controllalo nel dashboard). Non cambiare l'impostazione solo per questo. Non incollare l'output da nessuna parte (può contenere indirizzi IP e intestazioni).

### 5.4 Limiti di richieste

- Nel codice: 30 `POST` al minuto per indirizzo, **per istanza** (debole).
- **Già presente**: il binding `OAUTH_RATE_LIMITER` (30 ogni 60 s per indirizzo, per sede Cloudflare; approssimato; non visibile nel dashboard; serve Wrangler ≥ 4.36, e il workflow ne installa uno recente). Non va aggiunto: c'è già in `wrangler.toml` (`namespace_id = "7301"` deve essere unico nell'account).
- Le regole WAF di rate limiting **non si applicano a `workers.dev`**: servono un dominio tuo (5.7). Piano Free: 1 regola, finestra 10 s, per IP, filtro sul percorso.

Prova (nessun segreto serve):

```bash
for i in $(seq 1 35); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://auth-proxy.alessandro-rapiti44.workers.dev/oauth/microsoft/revoke -H 'Content-Type: application/json' -d '{"token":"x"}'; done; echo
```

**Verifica:** circa 30 risposte `204` e poi `429` (il conteggio esatto può variare: i limiti sono approssimati).

### 5.5 Cosa NON fare

- Non incollare segreti in issue, chat, commit, schermate o log; non metterli in `wrangler.toml`.
- Non dare al token privilegi di amministratore dell'account né «All accounts/zones»; non usare la Global API Key.
- **Non usare `cf workers secrets update <nome> --text <valore>`**: passa il segreto come argomento (resta nella cronologia e nella lista dei processi). I segreti si caricano con `set-secrets.sh` / `gh secret set` (stdin).
- Non modificare le variabili del Worker dal dashboard: il prossimo deploy le riporta ai valori di `wrangler.toml`.
- Non attivare `[observability]` senza motivo.

### 5.6 `cf deploy` al posto di Wrangler? No (per ora)

`cf deploy` **non** sostituisce Wrangler in un progetto che ha ancora `wrangler.toml`: la documentazione di Cloudflare dice di **non lanciare `cf dev`, `cf build` o `cf deploy` in un progetto Wrangler non migrato** (scrivono una loro configurazione o falliscono). I deploy restano con Wrangler, tramite il workflow. `cf migrate` è un passo facoltativo **per dopo**: converte `wrangler.toml` in `cloudflare.config.ts` e aggiunge `cf` come dipendenza.

```bash
cd src/auth-proxy && cf migrate --dry-run --force        # anteprima: non scrive nulla
```

Provato su una copia (fuori dal repository): «Would update 3 file(s): cloudflare.config.ts, package.json, package-lock.json», senza lavori da fare a mano. Non lo consiglio ora: il deploy funziona, la migrazione cambierebbe il workflow e il Worker tornerebbe ad avere una dipendenza.

### 5.7 Dominio personalizzato `auth.narrarium.net` (facoltativo)

Non serve. Dà un indirizzo tuo e abilita le regole WAF, ma obbliga a spostare **il DNS di tutto `narrarium.net`** da GoDaddy a Cloudflare (un record sbagliato rompe sito o posta).

1. Dashboard → **Domains** → **Onboard a domain** → `narrarium.net` → piano Free. Rivedi **tutti** i record importati e confrontali con GoDaddy (sito su GitHub Pages: `@` e `www`, posta: `MX`/`TXT`); per i record del sito lascia la nuvola **grigia (DNS only)**.
2. Se il DNSSEC è attivo su GoDaddy, **spegnilo prima** di cambiare i nameserver.
3. Su GoDaddy cambia i nameserver con i due assegnati da Cloudflare (guida di GoDaddy nelle fonti; i nomi dei suoi menu non li ho verificati). Aspetta lo stato **Active**.
4. In `src/auth-proxy/wrangler.toml` aggiungi (tenendo `workers_dev = true` finché non hai finito: con le rotte diventerebbe `false`) `[[routes]]` con `pattern = "auth.narrarium.net"` e `custom_domain = true`; il token deve poter modificare le rotte (*Zone → Workers Routes → Edit* sulla sola zona `narrarium.net`).
5. Deploy; `gh variable set VITE_GITHUB_MODELS_BASE --body https://auth.narrarium.net`; ripubblica il sito. `ALLOWED_ORIGINS_EXTRA` **non cambia** (elenca le origini del *sito*) e nelle console Google/Microsoft/GitHub non va toccato nulla. Infine `workers_dev = false`.

**Verifica:** `curl https://auth.narrarium.net/oauth/status` risponde con i tre booleani.

---

## 6. GitHub App (più avanti: il sito la userà con un rilascio successivo)

GitHub non ha una CLI per registrare una App: si fa dal sito. Una *GitHub App* (non una *OAuth App*) dà un token solo per i repository dove è installata, che scade dopo 8 ore con refresh token (6 mesi, a rotazione).

1. GitHub → foto del profilo → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. **Name** `Narrarium` (unico, ≤ 34 caratteri); **Homepage URL** `https://narrarium.net`.
3. **Callback URL** (4): `https://narrarium.net/auth/github/callback`, `https://www.narrarium.net/auth/github/callback`, `http://localhost:5173/auth/github/callback`, `http://localhost:4173/auth/github/callback`. **Wildcard matching spenta** (se compare la casella).
4. **Expire user authorization tokens: attiva.** **Request user authorization (OAuth) during installation: attiva.** **Enable Device Flow: spenta.** **Setup URL:** vuoto. **Webhook → Active:** tolta.
5. **Repository permissions:** *Contents* Read and write; *Pull requests* Read and write; *Workflows* Read and write; *Repository creation* Write (novità del 13 ottobre 2026: creare repository senza il permesso «Administration»; se non la trovi **non** sostituirla con *Administration*, dillo allo sviluppatore); *Metadata* Read-only (automatico). **Niente** Administration, Pages, permessi di organizzazione o di account.
6. **Where can this GitHub App be installed?** *Any account* → **Create GitHub App**.
7. Nella pagina dell'App copia il **Client ID** (non l'App ID), controlla in **Optional features** che «User-to-server token expiration» sia attivo, **Generate a new client secret** (compare una volta sola).
8. Dove vanno i valori: il Client ID in `GITHUB_APP_CLIENT_ID` di `src/auth-proxy/wrangler.toml` (commit + deploy; il sito userà lo stesso, in un rilascio successivo); il secret con `src/auth-proxy/scripts/set-secrets.sh` (terzo prompt, `GH_APP_CLIENT_SECRET`: GitHub vieta i nomi che iniziano con `GITHUB_`; il deploy lo carica nel Worker come `GITHUB_APP_CLIENT_SECRET`).
9. **Installa** l'App: pagina dell'App → **Install App** → il tuo account → **Only select repositories** (i libri). Cambi i repository in **Settings → Applications → Installed GitHub Apps → Configure**.
10. **Revoca:** l'utente da **Settings → Applications → Authorized GitHub Apps → Revoke**; tu da **Installed GitHub Apps → Configure → Suspend/Uninstall**; la disconnessione dal sito chiama il Worker, che cancella la *grant* dell'App per quell'utente.

**Verifica:** dopo il deploy, `check-status.mjs` dice «GitHub: configurato»; `curl -s -X POST <worker>/oauth/github/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"prova"}'` risponde `invalid_grant` (GitHub ha accettato id e secret e ha rifiutato il token inventato).

---

## 7. Controllo finale e «cosa imporre»

```bash
gh secret list                                       # solo nomi
src/auth-proxy/scripts/set-secrets.sh --dry-run      # cosa farebbe
gh workflow run deploy-auth-proxy.yml && gh run watch --exit-status
node src/auth-proxy/scripts/check-status.mjs https://auth-proxy.alessandro-rapiti44.workers.dev
src/auth-proxy/scripts/check-microsoft-app.sh        # sola lettura
cf workers list
```

| Risposta | Significato |
| --- | --- |
| `{"google":true,"microsoft":true,"github":false}` | Google e Microsoft pronti; GitHub dopo la sezione 6 |
| un `false` | manca il segreto (per GitHub anche `GITHUB_APP_CLIENT_ID` vuoto): `check-status.mjs` e il riepilogo del workflow dicono quale |
| risposta senza la chiave `github` | in linea c'è ancora una versione vecchia del Worker: attendi e rilancia |
| `curl` non risponde | il Worker non è pubblicato o l'indirizzo è sbagliato |

| Cosa imporre | Dove | Perché |
| --- | --- | --- |
| Token Cloudflare con solo «Workers Scripts Write» (o Editor sul solo Worker), solo il tuo account, con scadenza e promemoria | Cloudflare | se trapela, si può solo ripubblicare quel Worker |
| Il token stretto si crea **dopo** il primo deploy del Worker nuovo | Cloudflare | creare un Worker chiede più di aggiornarlo |
| Segreti solo nei secret di GitHub, caricati con `set-secrets.sh` (stdin), mai come argomento | GitHub / Worker | niente cronologia, niente lista dei processi |
| Il Worker vecchio si cancella per ultimo, dopo prove vere e qualche giorno | Cloudflare | i browser con il sito in cache lo usano ancora |
| Schermata di consenso Google **In production**; origini JavaScript esatte | Google Auth Platform | in *Testing* i refresh token durano 7 giorni |
| URI Microsoft sotto la piattaforma **Web**, **uniti** ai precedenti; nessun consenso amministratore | Entra | il segreto è accettato; non si perdono gli URI di MSAL |
| Secret Microsoft ≤ 24 mesi, con data in calendario e rotazione con un secondo secret | Entra | evita il blocco di OneDrive alla scadenza |
| «Expire user authorization tokens» attivo, wildcard spenta, webhook spento, niente Administration/Pages | GitHub App | token a vita breve, nessun furto del codice, consenso minimo |
| Installare la App solo sui repository dei libri | GitHub | il token vede solo quelli |
| Nessun PAT né token della App nei dati sincronizzati | sito | un token in chiaro su Drive o in un repository pubblico è perso |
| Non toccare `observability`; variabili solo da `wrangler.toml` | Worker | niente tracce, niente differenze tra file e dashboard |
| Limiti: nel codice + `OAUTH_RATE_LIMITER`; regola WAF su `/oauth/` solo con dominio proprio | Worker / Cloudflare | `workers.dev` non accetta regole WAF |
| Permessi del workflow: solo `contents: read` | `deploy-auth-proxy.yml` | il workflow non scrive nel repository |

---

## 8. Procedura proposta: cosa ho corretto e cosa non ho potuto verificare

Una procedura era stata preparata da un altro assistente. Ho tenuto ciò che è giusto per **questo** repository e corretto il resto:

| Nella procedura | Come l'ho trattato |
| --- | --- |
| Chiede l'ID client Google | già in `wrangler.toml` e in `publicClients.ts`: **si controlla che coincidano** (2.0), non si chiede |
| Propone di disattivare `observability` nel Worker | **non si cambia** l'impostazione del Worker (5.3) |
| Propone di aggiungere il binding di rate limit | **c'è già** (`OAUTH_RATE_LIMITER`); si verifica con `wrangler deploy --dry-run` e con la prova del 429 (5.4) |
| `Workers Scripts Write` | è **account-wide**; l'alternativa più stretta è Editor su un solo Worker; e va creato **dopo** il primo deploy (5.1) |
| `cf deploy` può sostituire Wrangler | **no** in un progetto con `wrangler.toml`: serve `cf migrate`, e la documentazione vieta `cf dev|build|deploy` su un progetto non migrato; i deploy restano con Wrangler (5.6) |
| `cf` e Wrangler condividono il login | **no**: due login separati (1.2) |
| ID del gruppo di permessi scritto nel testo | si **ricava** con `cf accounts tokens permission-groups list` (5.1) |
| `az ad app update --web-redirect-uris` con i soli quattro URI | **sostituisce** la lista: va **unita** a quella esistente; lo script stampa il comando giusto (3.3) |
| `az ad app permission add` e consenso | dichiara i permessi, **senza** `admin-consent` (3.4); gli ID si ricavano da `az ad sp show` |
| `az ad app credential reset` | senza `--append` cancella tutti i secret (3.5) |
| `cf observability tail` per i log | richiede Workers Logs attivi: si usa `npx wrangler tail` (5.3) |
| `cf workers secrets update … --text` | passa il segreto come **argomento**: vietato (5.5); si usa `set-secrets.sh` |
| Il token «account» si crea con il login di `cf` | serve un chiamante con il permesso di creare token: il login di `cf` può non bastare (5.1) |

**Comandi verificati (come):**

- `cf`: `--version`; `auth login|whoami|scopes` (`--help`); `workers list|get|delete|deployments list|versions list|secrets list|secrets update` (`--help`, e `--dry-run` con un ID account finto: `list`, `delete`, `secrets list`, `deployments list`, `observability tail`, `permission-groups list`); `observability tail` (`--help`); `accounts tokens create|list|delete|roll|verify` e `permission-groups list` (`--help`, `cf schema accounts tokens create`, e `--dry-run` con un ID account finto per `create`, `roll`, `delete`, `list`); `migrate --dry-run --force` (eseguito su una copia).
- `az` 2.93.0: `ad app update` (`--sign-in-audience`, `--web-redirect-uris`), `ad app show`, `ad app permission add|list|admin-consent`, `ad sp show`, `ad app credential list|reset|delete` (tutti con `--help`); `login --allow-no-subscriptions --use-device-code`.
- Wrangler 4.167.0: `login`, `whoami`, `tail`, `deployments list`, `versions list`, `secret list`, `delete` (`--help`); `deploy --dry-run` (eseguito, senza accesso).
- `gh`: `secret set`, `variable set`, `workflow run`, `run watch` (`--help`).
- `gcloud services enable|list`: dalla documentazione ufficiale (`gcloud` non è installato qui).

**Non verificato** (serve il tuo accesso o non c'è un modo offline): l'effetto reale di `cf accounts tokens create` (permessi necessari al chiamante e forma della risposta); il nome esatto del gruppo di permessi «Workers Scripts Write» e se esiste un gruppo per il ruolo Editor per-Worker; se il token «Editor» non può davvero creare il Worker nuovo (lo dice la documentazione dei ruoli); la proprietà `oauth2PermissionScopes` di `az ad sp show` (l'aiuto di `permission add` cita `oauth2Permissions`: se la prima è vuota, guarda `az ad sp show --id 00000003-0000-0000-c000-000000000000` e usa quella che c'è); `az ad app credential reset … --query password` con la pipe; i moduli e i nomi dei menu di GitHub, Google ed Entra; lo scambio del codice di Google con `postmessage` (4.3); il permesso «Repository creation» su un'installazione a repository selezionati; la revoca GitHub con un access token scaduto; i menu di GoDaddy.

---

## 9. Fonti (consultate il 23 novembre 2026)

Cloudflare: [`cf` (README del pacchetto e aiuto dei comandi)](https://developers.cloudflare.com/cf/), [Migrate a Wrangler project](https://developers.cloudflare.com/cf/wrangler/migrate/), [progetti non migrati](https://developers.cloudflare.com/cf/wrangler/#unmigrated-projects), [wrangler-action (output `deployment-url`)](https://github.com/cloudflare/wrangler-action), [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), [create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [permessi](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [roll a token](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [log in tempo reale](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [regole WAF di rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/), [onboard a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/), [nameserver](https://developers.cloudflare.com/dns/nameservers/update-nameservers/), [GoDaddy](https://www.godaddy.com/help/change-nameservers-for-your-domain-names-664).

GitHub: [registrare una GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [URL di callback e wildcard](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url), [token utente](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [rinnovo](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [revoca della grant](https://docs.github.com/en/rest/apps/oauth-applications), [installare la propria App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), [revocare](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps), [changelog 2026-10-13](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/), [nomi dei secret](https://docs.github.com/en/actions/reference/security/secrets), [variabili predefinite](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).

Google: [Audience](https://support.google.com/cloud/answer/15549945), [Google Auth Platform](https://support.google.com/cloud/answer/15544987), [ambiti di Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [modello a codice](https://developers.google.com/identity/oauth2/web/guides/use-code-model), [`gcloud services enable`](https://cloud.google.com/sdk/gcloud/reference/services/enable), [`gcloud services list`](https://cloud.google.com/sdk/gcloud/reference/services/list).

Microsoft: [registrare un'app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [URI di reindirizzamento](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri), [credenziali (massimo 24 mesi)](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials?tabs=client-secret), [Azure CLI `az ad app`](https://learn.microsoft.com/en-us/cli/azure/ad/app).
