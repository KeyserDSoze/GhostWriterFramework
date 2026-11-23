# Guida: Cloudflare e accessi (Google, Microsoft, GitHub)

Guida passo passo per il proprietario. Spiega cosa devi fare a mano su Cloudflare, su Google, su Microsoft e su GitHub perché il Worker `models-github-proxy` permetta al sito di restare collegato a Google Drive, OneDrive e (con un rilascio successivo del sito) a GitHub, e cosa **imporre** perché resti sicuro. Versione breve in inglese: [`cloudflare-and-sign-in-setup.en.md`](cloudflare-and-sign-in-setup.en.md). Riferimento tecnico del Worker: [`infra/models-github-proxy/README.md`](../infra/models-github-proxy/README.md).

Come leggerla: ogni passo ha una riga **Verifica** che dice cosa devi vedere. Se non lo vedi, fermati e non andare avanti. I nomi dei menu sono quelli inglesi delle console (le traduzioni italiane cambiano spesso; dove ne conosco una probabile la metto tra parentesi). Le fonti ufficiali, con data di consultazione (23 novembre 2026), sono in fondo, insieme a ciò che **non ho potuto verificare**.

Regola d'oro: **non incollare mai un segreto** (token API, client secret, refresh token) in una issue, in una chat, in un commit o nel file `wrangler.toml`. I segreti entrano solo nei *secret* del repository GitHub (con `set-secrets.sh` o `gh secret set`) e, da lì, nei *secret* del Worker.

---

## 0. Cosa è già fatto e cosa no

**Già fatto (in codice o già attivo):**

- Il Worker è pubblicato su `https://models-github-proxy.alessandro-rapiti44.workers.dev`.
- I secret del repository `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` esistono.
- Il workflow `.github/workflows/deploy-worker.yml` pubblica il Worker, carica i secret OAuth che esistono e, alla fine, scrive nel riepilogo dell'esecuzione una tabella «configurato / non configurato» per Google, Microsoft e GitHub.
- Il Worker ha il provider `github` (`/oauth/github/token`, `/refresh`, `/revoke`), un limite di richieste in più (se il binding Cloudflare è presente) e `GET /oauth/status` dice anche `github`.
- Gli script `infra/models-github-proxy/scripts/set-secrets.sh` (carica i secret con input nascosto) e `check-status.mjs` (stampa lo stato a parole).

**Non ancora fatto (tocca a te):**

- Oggi `GET /oauth/status` risponde `{"google":false,"microsoft":false}` (dopo il deploy di questa modifica: `{"google":false,"microsoft":false,"github":false}`) perché i client secret non sono nel Worker.
- Controllare/rifare il token API di Cloudflare con i permessi minimi (sezione 1).
- Google: schermata di consenso «In production», client web, segreto (sezione 3).
- Microsoft: URI di reindirizzamento, segreto, permessi (sezione 4).
- GitHub: registrare la GitHub App (sezione 2). Il pulsante «Accedi con GitHub» nel sito arriva con un rilascio successivo: fino ad allora la App serve solo a preparare il Worker.

**Ordine consigliato:** 0) unisci questa modifica in `main` (il workflow che parte è quello di `main`) → 1.3–1.4 token Cloudflare → 3 Google → 4 Microsoft → `set-secrets.sh` → controllo → 2 GitHub (può aspettare il rilascio del sito) → 1.7 limiti.

---

## 1. Cloudflare

### 1.1 Dove trovare l'ID account

1. Apri il [dashboard Cloudflare](https://dash.cloudflare.com/).
2. Premi `Ctrl+K` (o `Cmd+K`), scrivi `Copy account ID` e scegli il risultato. In alternativa: **Workers & Pages** → sezione **Account Details** → pulsante di copia accanto a **Account ID**.

**Verifica:** hai in mano una stringa di 32 caratteri esadecimali. È il valore del secret `CLOUDFLARE_ACCOUNT_ID`. GitHub non mostra mai il valore di un secret: la prova che quello salvato è giusto è che il passo «Deploy to Cloudflare» del workflow riesce.

### 1.2 Il sottodominio `workers.dev`

1. **Workers & Pages** → accanto a **Your subdomain** premi **Change** solo se vuoi cambiarlo (di norma no: cambiarlo cambia l'indirizzo del Worker e obbliga a rifare il sito).
2. L'indirizzo del Worker è `https://<nome Worker>.<sottodominio>.workers.dev`, cioè `https://models-github-proxy.alessandro-rapiti44.workers.dev`.

**Verifica:** `gh variable get VITE_GITHUB_MODELS_BASE` stampa quell'indirizzo (la variabile che il sito usa per raggiungere il Worker; è pubblica).

### 1.3 Controllare il token API che c'è già

Il token vive in due posti: su Cloudflare (la definizione dei permessi) e nel secret `CLOUDFLARE_API_TOKEN` del repository (il valore, che non puoi rileggere).

1. Dashboard → **Manage Account** → **Account API Tokens** (se il token è «personale»: icona del profilo → **My Profile** → **API Tokens**).
2. Trova il token usato per il deploy e aprilo (o premi **View**).
3. Guarda i permessi. Un token creato con il modello **Edit Cloudflare Workers** ha *Account → Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Workers R2 Storage: Edit*, *Workers Tail: Read*, *Account Settings: Read*, *Workers Routes: Edit* (zona), *User Details: Read* e *Memberships: Read*. È **più largo del necessario** per questo Worker (non usa KV né R2 e non ha rotte): passa al punto 1.4.
4. Guarda **Account Resources**: deve includere solo il tuo account, non «All accounts». E guarda la data di scadenza: se non ne ha una, ne metti una al punto 1.4.

**Verifica:** l'ultima esecuzione di «Deploy Cloudflare Worker» è verde. Non serve (e non devi) incollare il token da nessuna parte per controllarlo.

### 1.4 Creare un token con il minimo dei privilegi

Il minimo documentato da Cloudflare per fare `wrangler deploy` di un Worker che esiste già è il ruolo **Editor su quel Worker** (stesso permesso per `wrangler secret put`, che il workflow usa per i segreti). Creare un Worker nuovo richiede invece **Admin** a livello di prodotto: non serve, il Worker esiste.

1. **Manage Account** → **Account API Tokens** → **Create Token** → in fondo **Create Custom Token** (*Get started*).
2. **Token name:** `narrarium-worker-deploy-github-actions`.
3. **Permissions** (un solo criterio, tipo *Account*):
   - Se il selettore offre i ruoli dei Worker: **Workers** → **Editor**, limitato al Worker `models-github-proxy` (non a tutti).
   - Altrimenti (selettore storico): **Account** → **Workers Scripts** → **Edit**.
   - Niente altro. In particolare **non** *Workers KV Storage*, *R2*, *Pages*, *Zone*, *DNS*, *Account Settings: Edit*, *Billing*, *User* e nessun permesso «Admin».
4. **Account Resources:** *Include* → *Specific account* → il tuo account.
5. **TTL / Token expiration:** imposta una scadenza (consiglio 12 mesi) e segnala la data in un promemoria del calendario (vedi 1.9).
6. **Client IP Address Filtering:** lascialo vuoto (gli indirizzi dei runner di GitHub cambiano di continuo).
7. **Continue to summary** → controlla il riepilogo → **Create Token** → copia il valore **una volta sola** (lo mostra solo adesso).
8. Metti il valore nel secret, senza incollarlo in una riga di comando: `gh secret set CLOUDFLARE_API_TOKEN` e incolla al prompt (oppure usa la pagina *Settings → Secrets and variables → Actions → New repository secret*).
9. Rilancia il deploy: `gh workflow run deploy-worker.yml` e `gh run watch`.
10. A deploy verde elimina il token vecchio (Account API Tokens → ⋮ → **Delete**).

**Verifica:** il deploy è verde. Se fallisce con un errore di autenticazione (`Authentication error [code: 10000]`), aggiungi al token *Account → Account Settings → Read* (serve a Wrangler per leggere l'account quando non basta l'ID) e riprova. *Non ho potuto provare il token minimo senza usare le tue credenziali: la prima esecuzione è la prova.*

Se un giorno aggiungerai il dominio personalizzato (1.8) il token avrà bisogno anche di **Zone → Workers Routes → Edit**, limitato alla sola zona `narrarium.net`.

### 1.5 Cosa guardare in Workers & Pages

Dashboard → **Workers & Pages** → `models-github-proxy`:

- **Metrics** (nella scheda *Overview*): richieste, errori, durata CPU. Un picco di richieste `429` dice che il limite di velocità sta lavorando.
- **Deployments**: le versioni pubblicate. Da qui puoi tornare a una versione precedente se un deploy rompe qualcosa.
- **Settings → Variables and Secrets**: due tipi di voce.
  - *Plaintext* (variabili): `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, `GITHUB_APP_CLIENT_ID`, `ALLOWED_REDIRECT_URIS`, `ALLOWED_ORIGINS_EXTRA`. Sono pubbliche e vengono da `wrangler.toml`: **modificale in `wrangler.toml`, non dal dashboard**, o il prossimo deploy le riporta al valore del file.
  - *Secret* (`GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, `GITHUB_APP_CLIENT_SECRET`): **i segreti sono cifrati e non vengono mai più mostrati**, né dal dashboard né da Wrangler. Per cambiarne uno si carica un valore nuovo; non lo si può rileggere.
- **Settings → Domains & Routes**: lì compare la rotta `workers.dev`.

**Verifica:** dopo un deploy con i segreti, in *Variables and Secrets* vedi i nomi dei secret con il valore nascosto. Se un nome non c'è, quel provider risponde `501 not_configured`.

### 1.6 Leggere i log in diretta senza far uscire segreti

Il Worker non scrive nulla nei log (nessun `console.*`): vedrai solo le righe di invocazione (metodo, indirizzo, esito). Due modi:

- Dashboard: **Workers & Pages** → `models-github-proxy` → **Logs** → **Live** (a volte la scheda si chiama **Observability**: nome non verificabile con certezza).
- Terminale: `npx wrangler login` (una volta, apre il browser; non serve nessun token incollato) poi `npx wrangler tail models-github-proxy --status error --format pretty`.

Regole: non incollare l'output in una issue o in chat (può contenere indirizzi IP e intestazioni di chi usa il sito); per un problema copia solo `status` e il percorso, non il resto. **Non attivare** `[observability]` in `wrangler.toml` (la conservazione dei log) senza un motivo: il Worker è fatto per non lasciare tracce.

**Verifica:** chiama `curl https://models-github-proxy.alessandro-rapiti44.workers.dev/oauth/status` e vedi comparire la richiesta nel log in diretta.

### 1.7 Cosa imporre su Cloudflare: i limiti di velocità

Su `workers.dev` hai già due livelli, e un terzo solo con un dominio tuo:

1. **Nel codice (sempre attivo):** 30 richieste `POST` al minuto per indirizzo (`cf-connecting-ip`), contate nella memoria di ogni istanza del Worker. È debole: ogni istanza ha il suo contatore e si azzera al riciclo.
2. **Binding Rate Limiting di Cloudflare (nuovo, opzionale):** `wrangler.toml` dichiara `OAUTH_RATE_LIMITER` (30 richieste ogni 60 secondi per indirizzo, condiviso dalle istanze della stessa sede Cloudflare). Se manca o dà errore, il Worker funziona lo stesso. Richiede Wrangler 4.36.0 o più recente (il workflow installa Wrangler 4 aggiornato). Il `namespace_id` (`7301`) deve essere unico nel tuo account: se lo usi già per un altro Worker, cambialo. È un limite **approssimato e per sede** (non globale) e **non compare nel dashboard**: per vederlo lavorare cerca le risposte `429`.
3. **Regole WAF di rate limiting** (dashboard della zona → **Security**): **non sono applicabili a `workers.dev`**, che è una zona gestita da Cloudflare e non tua. Servono un dominio personalizzato (1.8). Con il piano Free hai **1 regola**, periodo **10 secondi**, conteggio per IP, e puoi filtrare per percorso: per esempio *URI Path* che inizia con `/oauth/` → massimo 10 richieste in 10 s → azione *Block* per 10 s.

**Verifica:** per provare il limite del codice, 31 `curl -X POST .../oauth/microsoft/revoke -H 'Content-Type: application/json' -d '{"token":"x"}'` di fila dalla stessa rete: l'ultima risponde `429` con `Retry-After`. (Non serve nessun segreto per provarlo.)

### 1.8 Facoltativo: dominio personalizzato `auth.narrarium.net`

**Non è necessario.** Dà un indirizzo stabile tuo e abilita le regole WAF (1.7.3); in cambio sposti il DNS di tutto `narrarium.net` da GoDaddy a Cloudflare.

**Pro:** indirizzo tuo (non dipende da `workers.dev`, che Cloudflare considera «hobby»); regole WAF e analitiche di zona; certificati gestiti da Cloudflare. **Contro:** se sbagli un record DNS il sito o la posta di `narrarium.net` smettono di funzionare; Cloudflare diventa un punto critico anche per il sito; un po' di manutenzione in più. Consiglio: **rimandalo**, finché non ti serve il WAF.

Passi (documentazione Cloudflare, vedi fonti):

1. Dashboard → **Domains** → **Onboard a domain** → scrivi `narrarium.net` → scegli come aggiungere i record DNS (la scansione automatica) → **Continue** → piano **Free**.
2. **Rivedi tutti i record DNS** importati confrontandoli con quelli di GoDaddy: il sito su GitHub Pages (record `A`/`CNAME` di `@` e `www`), la posta (`MX`, `TXT`/SPF/DKIM) se la usi, ogni verifica di proprietà. Per i record del sito lascia la nuvola **grigia (DNS only)**: non farli passare dal proxy di Cloudflare, per non disturbare i certificati di GitHub Pages.
3. Se il DNSSEC è attivo su GoDaddy, **spegnilo prima** di cambiare i nameserver (altrimenti il dominio può diventare irraggiungibile); lo riattivi da Cloudflare a dominio attivo.
4. Su GoDaddy cambia i **nameserver** del dominio con i due che Cloudflare ti assegna (guida di GoDaddy citata nelle fonti: *Domini* → il dominio → *DNS* → *Nameserver* → *Cambia*; i nomi esatti dei menu di GoDaddy non li ho potuti verificare).
5. Aspetta lo stato **Active** del dominio su Cloudflare (di solito minuti, a volte fino a qualche ora; arriva anche un'email).
6. In `infra/models-github-proxy/wrangler.toml` aggiungi (tenendo `workers_dev = true` finché non hai finito la migrazione):

   ```toml
   [[routes]]
   pattern = "auth.narrarium.net"
   custom_domain = true
   ```

   Se non scrivi `workers_dev` esplicito, con le rotte diventerebbe `false`. Il token API deve poter modificare le rotte (1.4, *Workers Routes: Edit* sulla zona).
7. Fai il deploy (`gh workflow run deploy-worker.yml`). Cloudflare crea da solo il record DNS e il certificato.
8. Cambia la variabile del repository: `gh variable set VITE_GITHUB_MODELS_BASE --body https://auth.narrarium.net` e ripubblica il sito. Le origini consentite del Worker (`ALLOWED_ORIGINS_EXTRA`) **non cambiano**: sono le origini del *sito* (`narrarium.net`), non quella del Worker. Le console di Google, Microsoft e GitHub non vanno toccate: contano gli indirizzi di ritorno del sito, non quello del Worker.
9. Quando tutto funziona, metti `workers_dev = false` per spegnere il vecchio indirizzo.

**Verifica:** `curl https://auth.narrarium.net/oauth/status` risponde con i tre valori booleani, e il sito pubblicato dopo il passo 8 funziona.

### 1.9 Rotazione del token API

- Il token ha una scadenza (1.4.5): crea un promemoria nel calendario **due settimane prima**.
- Per ruotare: dashboard → **API Tokens** → ⋮ accanto al token → **Roll** → **Confirm** (il nuovo valore vale subito e il vecchio smette di funzionare; i permessi restano gli stessi). Per i token di account la voce può trovarsi altrove: se non la vedi, crea un token nuovo come in 1.4. Poi `gh secret set CLOUDFLARE_API_TOKEN` e `gh workflow run deploy-worker.yml`.
- Se sospetti che sia trapelato: **Roll** subito, poi ruota anche i client secret (sezioni 2–4).

**Verifica:** il deploy dopo la rotazione è verde.

### 1.10 Cosa NON fare

- Non incollare segreti in issue, chat, commit, schermate o log.
- Non metterli in `wrangler.toml` (`[vars]` è in chiaro; un test del repository lo impedisce).
- Non dare al token API privilegi di amministratore dell'intero account, né «All accounts», né «All zones».
- Non usare la *Global API Key* (non è un token limitabile).
- Non modificare le variabili del Worker dal dashboard (il prossimo deploy le sovrascrive).
- Non rendere pubblico `.dev.vars` (è ignorato da git: lascialo così).

---

## 2. GitHub: registrare la GitHub App

Perché una *GitHub App* e non una *OAuth App*: il token vale solo per i repository dove l'app è installata, scade dopo 8 ore (con un refresh token che dura 6 mesi e cambia a ogni uso) e le organizzazioni non devono approvarla come «app OAuth di terzi». Il token che arriva al sito ha **i permessi dell'app ∩ quelli dell'utente ∩ i repository scelti**.

### 2.1 Registrazione

1. GitHub → foto del profilo (in alto a destra) → **Settings** → nella barra a sinistra **Developer settings** → **GitHub Apps** → **New GitHub App**. (Per un'app di un'organizzazione: *Your organizations* → *Settings* dell'organizzazione → *Developer settings*.)
2. **GitHub App name:** `Narrarium` (deve essere unico su GitHub e al massimo 34 caratteri; se è occupato, `Narrarium Books`).
3. **Description:** facoltativa (per esempio «Narrarium: scrivi libri nei tuoi repository GitHub»).
4. **Homepage URL:** `https://narrarium.net`
5. **Identifying and authorizing users**:
   - **Callback URL:** premi **Add callback URL** e inserisci, uno per riga, esattamente questi quattro:
     - `https://narrarium.net/auth/github/callback`
     - `https://www.narrarium.net/auth/github/callback`
     - `http://localhost:5173/auth/github/callback`
     - `http://localhost:4173/auth/github/callback`
   - **Wildcard matching** (se accanto a ogni URL compare la casella): **spenta**. Con la corrispondenza a caratteri jolly un attaccante potrebbe ricevere il codice su un sottodominio o una sottocartella. Le app create prima del 3 agosto 2026 l'hanno attiva di default: la nostra è nuova, controlla comunque.
   - **Expire user authorization tokens:** **attiva** (token da 8 ore con rotazione).
   - **Request user authorization (OAuth) during installation:** **attiva**.
   - **Enable Device Flow:** **spenta**.
6. **Post installation → Setup URL:** vuoto (il campo è disattivato quando chiedi l'autorizzazione durante l'installazione).
7. **Webhook → Active:** **togli la spunta** (nessun webhook: niente URL né segreto da gestire).
8. **Permissions → Repository permissions:**

   | Permesso | Livello | Perché |
   | --- | --- | --- |
   | **Contents** | Read and write | leggere e scrivere i file del libro, rami e commit |
   | **Pull requests** | Read and write | proposte di modifica |
   | **Workflows** | Read and write | creare/aggiornare `.github/workflows/*` del libro |
   | **Repository creation** | Write | creare il repository del libro senza il permesso «Administration» (novità del 13 ottobre 2026; dà all'app l'accesso ai repository che crea) |
   | **Metadata** | Read-only | automatico |

   **Non** dare *Administration* (permette di cancellare e trasferire repository), né *Pages*, né permessi di organizzazione o account. Se nell'elenco non trovi «Repository creation» (la funzione è nuova e può comparire con un nome o in un punto diverso), non sostituirla con *Administration*: lascia perdere quella riga e dillo allo sviluppatore. *Non ho potuto aprire il modulo di registrazione (serve il tuo accesso): i nomi esatti dei permessi sono presi dalla documentazione e dal changelog di GitHub.*
9. **Where can this GitHub App be installed?** → **Any account**.
10. **Create GitHub App**.

**Verifica:** vedi la pagina dell'app con l'**App ID** e il **Client ID**. Attenzione: sono due cose diverse, serve il **Client ID**.

### 2.2 Il token a scadenza e il client secret

1. Nella barra a sinistra dell'app apri **Optional features**: accanto a **User-to-server token expiration** deve esserci l'opzione per disattivarlo (cioè è attivo). Se vedi **Opt-in**, premilo.
2. Nella pagina **General** (negli aggiornamenti recenti, scheda **Credentials**) premi **Generate a new client secret** e copia il valore **subito**: GitHub lo mostra una volta sola. Non incollarlo da nessuna parte tranne al prompt di `set-secrets.sh`.

**Verifica:** il client secret appare nell'elenco con le sole ultime cifre.

### 2.3 Dove va ogni valore

| Valore | Dove | Come |
| --- | --- | --- |
| **Client ID** (non segreto) | `GITHUB_APP_CLIENT_ID` in `infra/models-github-proxy/wrangler.toml`, sezione `[vars]` | modifica la riga, commit, deploy. Lo stesso valore andrà nella configurazione pubblica del sito nel rilascio che aggiunge «Accedi con GitHub». |
| **Client secret** | repository secret **`GH_APP_CLIENT_SECRET`** | `infra/models-github-proxy/scripts/set-secrets.sh` (input nascosto). Il nome non può iniziare con `GITHUB_` (regola di GitHub): il deploy lo carica nel Worker come `GITHUB_APP_CLIENT_SECRET`. |

Finché `GITHUB_APP_CLIENT_ID` è vuoto, `/oauth/status` dice `"github":false`, anche se il secret c'è.

**Verifica:** dopo deploy, `check-status.mjs` dice «GitHub: configurato». Prova di id+secret senza token veri: `curl -s -X POST <worker>/oauth/github/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"prova"}'` deve rispondere `{"error":"invalid_grant",...}` (GitHub ha accettato id e secret e ha rifiutato il token inventato). Se risponde `not_configured` con «wrong client id or secret», id o secret non corrispondono.

### 2.4 Installare l'app sul tuo account e scegliere i repository

1. Pagina dell'app (Developer settings → GitHub Apps → **Edit**) → **Install App**.
2. **Install** accanto al tuo account (o all'organizzazione).
3. Scegli **Only select repositories** e seleziona i libri, oppure **All repositories**. Consiglio: solo i repository dei libri. Con «Repository creation», i repository che l'app crea sono aggiunti da soli.
4. **Install**.

Per cambiare i repository in seguito: **Settings** → **Applications** → **Installed GitHub Apps** → **Configure**. Per un'organizzazione, l'installazione e i permessi sensibili (creazione repository) richiedono un proprietario dell'organizzazione.

### 2.5 Revocare

- **L'utente** toglie l'autorizzazione: **Settings** → **Applications** → scheda **Authorized GitHub Apps** → **Revoke**. I token smettono di funzionare.
- **Tu**, per bloccare l'accesso a un account o a un'organizzazione: **Settings** → **Applications** → **Installed GitHub Apps** → **Configure** → **Suspend** o **Uninstall**. I proprietari di un'organizzazione non possono revocare le autorizzazioni dei loro membri, ma possono disinstallare l'app.
- **Il sito**, quando l'utente si scollega, chiama il Worker (`/oauth/github/revoke`) che cancella la *grant* dell'app per quell'utente (`DELETE /applications/{client_id}/grant`): i token spariscono da tutti i dispositivi.
- **Segreto compromesso:** nella pagina dell'app genera un nuovo client secret, caricalo con `set-secrets.sh` e poi elimina quello vecchio.

---

## 3. Google

Il Worker ha bisogno del client OAuth **di tipo «Web application»** con ID che inizia con `91477716497-` (è lo stesso ID del sito: `src/narrarium-site/src/config/publicClients.ts` e `wrangler.toml`; se cambiano, cambiano insieme).

### 3.1 Schermata di consenso: «In production»

1. [Google Cloud Console](https://console.cloud.google.com/) → il progetto che contiene il client → menu **Google Auth Platform** (nella console più vecchia: *APIs & Services → OAuth consent screen*).
2. **Audience** («Pubblico»). *User type* **External**. **Publishing status** deve essere **In production**: se è *Testing* premi **Publish app** e conferma.

   Perché: con lo stato *Testing* le autorizzazioni (e quindi i refresh token) **scadono dopo 7 giorni**, e solo 100 utenti di prova possono entrare.

**Verifica:** *Publishing status: In production*.

### 3.2 Il client Web

1. **Google Auth Platform** → **Clients** → il client «Web application» `91477716497-…`.
2. **Authorized JavaScript origins** (esatti, senza `/` finale e senza percorso):
   - `https://narrarium.net`
   - `https://www.narrarium.net`
   - `http://localhost:5173`
   - `http://localhost:4173`
3. **Authorized redirect URIs:** nessuno. Il sito apre il popup di Google (`initCodeClient` con `ux_mode: "popup"`, vedi `AccountSyncPage.tsx`) e il Worker scambia il codice con il valore speciale `postmessage`: non serve un URI di ritorno. *(Vedi «Se qualcosa non funziona» sotto: è il punto che non ho potuto provare dal vivo.)*
4. **Client secrets**: premi **Add secret** e copia subito il nuovo valore (la console lo mostra una volta sola; il vecchio resta valido finché non lo disattivi).
5. Salva. La modifica può richiedere qualche minuto.

**Verifica:** l'elenco mostra le 4 origini e il nuovo segreto (le ultime cifre).

### 3.3 Ambiti (scopes)

**Google Auth Platform** → **Data Access**. Il sito chiede (`src/narrarium-site/src/config/googleAuth.ts`): `drive.appdata`, `drive`, `openid`, `profile`, `email`.

- `drive.appdata` (cartella privata dell'app) è **non sensibile**: nessuna verifica speciale oltre quella base.
- **`drive` (tutto Drive) è un ambito «restricted»**: Google lo permette solo ad app **verificate** (con una revisione di sicurezza per le app che salvano dati sui server). Finché l'app non è verificata, gli utenti vedono l'avviso «Google non ha verificato questa app» e (regola di Google da riconfermare nella console) l'app è limitata a 100 utenti nuovi. Per uso personale puoi proseguire con l'avviso. Non cambia la durata dei refresh token. Le strade, se vuoi evitare la verifica: (a) restare così (uso personale); (b) chiedere la verifica dell'ambito restricted; (c) far chiedere al sito solo ambiti non sensibili (`drive.file`, `drive.appdata`): è una modifica del sito, da decidere con lo sviluppatore.

### 3.4 Il segreto e la prova

1. `infra/models-github-proxy/scripts/set-secrets.sh` → primo prompt (**Google**): incolla il client secret (di solito inizia con `GOCSPX-`), Invio.
2. Lascia lanciare il deploy quando lo chiede.
3. Controllo: `curl -s -X POST <worker>/oauth/google/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"prova"}'` → `{"error":"invalid_grant",...}` = id e segreto accettati. `upstream_error` con `invalid_client` = segreto o id sbagliati.

### 3.5 Se qualcosa non funziona

- **`redirect_uri_mismatch` dal Worker (502 `upstream_error`) al primo collegamento di Google:** la documentazione di Google (aggiornata il 29 ottobre 2026) dice che in modalità popup il `redirect_uri` dello scambio è **l'origine della pagina** (per esempio `https://narrarium.net`), mentre il Worker invia `postmessage`, che molti sviluppatori riportano funzionante ma che non è documentato. Non ho potuto provarlo (servirebbero le tue credenziali). Se succede, **dillo allo sviluppatore**: la correzione è nel Worker (usare l'origine del sito). Non cambiare nulla nella console.
- I refresh token di Google durano finché l'utente non revoca l'accesso, ma scadono dopo 6 mesi di non uso, e ogni account ne può avere al massimo 100 per client.

---

## 4. Microsoft (Microsoft Entra ID)

1. [Microsoft Entra admin center](https://entra.microsoft.com/) → **Entra ID** → **App registrations** → l'applicazione con **Application (client) ID** `a80b2024-b9e3-4cb1-8480-aac7f164a6eb`.

### 4.1 Tipi di account supportati

Nella **Overview** (o nella scheda **Authentication → Settings**) controlla **Supported account types**: deve includere gli account personali, cioè **Any Entra ID Tenant + Personal Microsoft accounts** (in portale: «Accounts in any organizational directory and personal Microsoft accounts»). Il Worker usa l'authority `common`, che accetta sia account personali sia di lavoro/scuola.

**Verifica:** la Overview mostra «Multiple organizations, Personal Microsoft accounts» (o equivalente).

### 4.2 URI di reindirizzamento: piattaforma «Web»

1. **Manage** → **Authentication** → scheda **Redirect URI configuration** → **Add Redirect URI** → tessera **Web**.
2. Inserisci questi quattro URI (sono quelli della lista `ALLOWED_REDIRECT_URIS` di `wrangler.toml` per Microsoft; esatti, nessuno in più):
   - `https://narrarium.net/auth/microsoft-callback.html`
   - `https://www.narrarium.net/auth/microsoft-callback.html`
   - `http://localhost:5173/auth/microsoft-callback.html`
   - `http://localhost:4173/auth/microsoft-callback.html`
3. **Configure**.
4. Non toccare gli URI già presenti per MSAL (`…/msal-popup.html`, sotto «Single-page application»): servono al collegamento attuale. **Non** mettere i quattro nuovi sotto «Single-page application»: con quella piattaforma il refresh token dura al massimo 24 ore e Microsoft rifiuta lo scambio con il segreto (`AADSTS9002327`).
5. «Allow public client flows» (nella scheda *Settings*): **No**.

**Verifica:** i quattro URI compaiono sotto la piattaforma **Web**.

### 4.3 Il client secret (scade!)

1. **Manage** → **Certificates & secrets** → **Client secrets** → **New client secret**.
2. **Description:** `narrarium-worker`. **Expires:** **24 months** (il massimo; Microsoft consiglia meno di 12 mesi, scegli 12 se preferisci ruotare più spesso). **Add**.
3. Copia subito la colonna **Value** (non **Secret ID**): non sarà più visibile.
4. **Scrivi la data di scadenza in un promemoria** (30 giorni prima). Alla scadenza il Worker non riuscirà più a rinnovare i token Microsoft (errore `invalid_client`) e i collegamenti OneDrive chiederanno di ricollegare.
5. `set-secrets.sh` → secondo prompt (**Microsoft**): incolla il **Value**. (Se incolli per sbaglio l'ID del segreto, che ha la forma di un GUID, lo script lo rifiuta.)

**Rotazione senza interruzioni** (i refresh token già emessi restano validi: non dipendono dal segreto):

1. Crea un **secondo** client secret (il vecchio resta).
2. `set-secrets.sh` (salta Google e GitHub con Invio) e lascia lanciare il deploy.
3. `check-status.mjs` → Microsoft configurato; collega un account di prova dal sito.
4. Solo ora elimina il segreto vecchio (⋮ → **Delete**).

### 4.4 Permessi API

**Manage** → **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**: **`User.Read`**, **`Files.ReadWrite`**, **`offline_access`** (il sito chiede anche `openid` e `profile`, che sono i permessi di accesso di base). Non aggiungere altro (niente `Files.ReadWrite.All`, niente permessi di tipo *Application*).

**Verifica:** l'elenco mostra solo quei permessi delegati.

---

## 5. Controllo finale (comandi)

```bash
gh secret list                                   # nomi (mai i valori): CLOUDFLARE_*, GOOGLE_OAUTH_CLIENT_SECRET, MICROSOFT_OAUTH_CLIENT_SECRET, GH_APP_CLIENT_SECRET
infra/models-github-proxy/scripts/set-secrets.sh --dry-run   # mostra cosa farebbe, senza chiedere nulla
infra/models-github-proxy/scripts/set-secrets.sh             # chiede i tre segreti (input nascosto) e, se vuoi, lancia il deploy
gh workflow run deploy-worker.yml                # (se non l'hai lanciato dallo script)
gh run watch                                     # aspetta la fine; in fondo, nel riepilogo, c'è la tabella dei provider
curl https://models-github-proxy.alessandro-rapiti44.workers.dev/oauth/status
node infra/models-github-proxy/scripts/check-status.mjs      # lo stesso controllo, a parole
```

| Risposta | Significato |
| --- | --- |
| `{"google":true,"microsoft":true,"github":true}` | tutti i provider hanno id e segreto nel Worker |
| un valore `false` | manca il segreto (o, per GitHub, `GITHUB_APP_CLIENT_ID` è vuoto in `wrangler.toml`): `check-status.mjs` e il riepilogo del workflow dicono quale |
| `{"google":false,"microsoft":false}` (senza `github`) | il Worker in linea è ancora la versione vecchia: il deploy non è andato a buon fine o non si è ancora propagato; aspetta e rilancia |
| `curl` non risponde / errore HTTP | il Worker non è pubblicato o l'indirizzo è sbagliato: controlla `gh variable get VITE_GITHUB_MODELS_BASE` |

Dal riepilogo del workflow: **«Check which sign-in providers are configured»** non fa mai fallire il deploy (se il Worker non risponde scrive un avviso).

**Provare dal sito** (quando il sito pubblicato è quello con il broker):

1. **Google:** *Account e sincronizzazione* → ricollega Google (serve riautorizzare una volta per ottenere il refresh token). Aspetta più di un'ora: non deve richiedere un nuovo accesso.
2. **OneDrive:** stesso percorso con Microsoft. Aspetta più di 24 ore: il collegamento deve restare.
3. **GitHub:** arriverà con un rilascio successivo del sito («Accedi con GitHub»); fino ad allora il Worker è pronto ma il sito non lo usa.

---

## 6. Cosa imporre (riepilogo)

| Impostazione | Dove | Perché |
| --- | --- | --- |
| Token API Cloudflare con **solo** il permesso sui Worker (Editor su `models-github-proxy`, o Workers Scripts: Edit), solo il tuo account, con scadenza | Cloudflare → Account API Tokens | se il token trapela, si può solo ripubblicare quel Worker |
| Token API: **niente** IP filtering | Cloudflare | gli indirizzi dei runner GitHub cambiano |
| Data di scadenza del token API in calendario (2 settimane prima) | tuo calendario | evita deploy bloccati e token dimenticati |
| «Expire user authorization tokens» **attivo** | GitHub App → registrazione / Optional features | token da 8 ore con rotazione: un token rubato dura poco |
| **Wildcard matching spento** sui callback | GitHub App → Callback URL | un attaccante non può ricevere il codice su un sottodominio |
| Webhook **disattivato**; **nessun** permesso Administration/Pages/organizzazione | GitHub App | meno superficie e consenso più piccolo |
| Installare l'app solo sui repository dei libri | GitHub → Installed GitHub Apps | il token vede solo quelli |
| Schermata di consenso Google **In production** | Google Auth Platform → Audience | in *Testing* i refresh token scadono in 7 giorni |
| Origini JavaScript Google **esatte**, nessun URI di ritorno inutile | Google Auth Platform → Clients | meno modi per dirottare il codice |
| Piattaforma **Web** (non SPA) per gli URI Microsoft; **No** a «public client flows» | Entra → Authentication | il segreto è accettato e il refresh token dura 90 giorni |
| Client secret Microsoft: scadenza **≤ 24 mesi**, data in calendario, rotazione con secondo segreto | Entra → Certificates & secrets | evita il blocco di OneDrive alla scadenza |
| Segreti **solo** nei secret di GitHub (e da lì nel Worker), caricati con `set-secrets.sh` | GitHub → Secrets; Worker → Secrets | mai in `wrangler.toml`, in chat o nella cronologia della shell |
| Il repository secret di GitHub si chiama `GH_APP_CLIENT_SECRET` | GitHub | i nomi che iniziano con `GITHUB_` sono vietati |
| **Nessun PAT** nei dati sincronizzati / nelle impostazioni condivise; i token della GitHub App e il loro refresh token non entrano nei dati sincronizzati | sito (promemoria per le prossime versioni) | un token in chiaro su Drive o in un repository pubblico è un token perso |
| Variabili del Worker solo da `wrangler.toml`; Workers Logs spenti | repository / Cloudflare | niente tracce, niente differenze tra file e dashboard |
| Limite di richieste: codice + binding `OAUTH_RATE_LIMITER`; con dominio proprio anche regola WAF su `/oauth/` | Worker / Cloudflare | `workers.dev` non accetta regole WAF |
| Permessi del workflow: solo `contents: read` | `.github/workflows/deploy-worker.yml` | il workflow non può scrivere nel repository |

---

## Fonti (consultate il 23 novembre 2026)

Cloudflare:
- Token API e GitHub Actions: <https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/>
- Creare un token: <https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>; modelli: <https://developers.cloudflare.com/fundamentals/api/reference/template/>; permessi: <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>; rotazione: <https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/>
- Ruoli e permessi dei Worker (Editor/Admin, `wrangler deploy`, `secret put`, `tail`): <https://developers.cloudflare.com/workers/authorization/workers/>
- ID account: <https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/>
- `workers.dev` (sottodominio, BIC, disattivazione): <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>
- Domini personalizzati: <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
- Variabili e segreti: <https://developers.cloudflare.com/workers/configuration/environment-variables/>, <https://developers.cloudflare.com/workers/configuration/secrets/>
- Log in diretta e Workers Logs: <https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>, <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Binding Rate Limiting (Wrangler ≥ 4.36.0, per sede, non nel dashboard): <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- Regole WAF di rate limiting (piani, campi): <https://developers.cloudflare.com/waf/rate-limiting-rules/>
- Aggiungere un dominio, nameserver, DNSSEC: <https://developers.cloudflare.com/fundamentals/manage-domains/add-site/>, <https://developers.cloudflare.com/dns/nameservers/update-nameservers/>; GoDaddy: <https://www.godaddy.com/help/change-nameservers-for-your-domain-names-664>
- Azione `cloudflare/wrangler-action`: <https://github.com/cloudflare/wrangler-action>

GitHub:
- Registrare una GitHub App: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app>
- URL di callback e wildcard: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url>
- Token utente (scambio del codice, risposte): <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app>; rinnovo: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens>
- Errori dello scambio: <https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors>
- Revoca della *grant*: <https://docs.github.com/en/rest/apps/oauth-applications>
- Modifica della registrazione: <https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration>; installazione: <https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app>; revoca/gestione: <https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps>, <https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps>
- Permesso «Repository creation» (13 ottobre 2026): <https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/>
- Nomi dei secret (niente prefisso `GITHUB_`): <https://docs.github.com/en/actions/reference/security/secrets>; variabili d'ambiente predefinite: <https://docs.github.com/en/actions/reference/workflows-and-actions/variables>

Google:
- Pubblico / stato di pubblicazione: <https://support.google.com/cloud/answer/15549945>; Google Auth Platform: <https://support.google.com/cloud/answer/15544987>
- Ambiti di Drive (non sensibili / sensibili / restricted): <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- Modello a codice (popup, `redirect_uri`): <https://developers.google.com/identity/oauth2/web/guides/use-code-model>

Microsoft:
- Registrare un'app: <https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app>
- URI di reindirizzamento: <https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri>
- Credenziali e segreti (massimo 24 mesi): <https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials?tabs=client-secret>

### Cosa non ho potuto verificare

- I moduli veri (registrazione della GitHub App, creazione del token Cloudflare, schermate Google ed Entra) richiedono il tuo accesso: i nomi dei menu e dei campi vengono dalla documentazione ufficiale di oggi, non da una prova sullo schermo. Dove l'interfaccia può essere diversa l'ho scritto.
- Il token API minimo (Editor sul solo Worker, o Workers Scripts: Edit) è quello che la documentazione indica per `wrangler deploy` e `wrangler secret put`; non l'ho provato.
- Se in `Repository creation` il nome in interfaccia coincide con quello del changelog, e se funziona per un'app installata su «repository selezionati» di un account personale (il piano prevede una prova con un'app di test prima di basarci il sito).
- Lo scambio del codice di Google con `redirect_uri=postmessage` (vedi 3.5).
- La regola del limite dei 100 utenti per le app Google non verificate con ambiti restricted, e il fatto che la console Google mostri ancora i segreti dopo la creazione.
- La voce di menu per fare **Roll** di un token *di account* (la documentazione descrive solo quella dei token utente).
- Che GitHub accetti la revoca (`DELETE …/grant`) con un access token già scaduto: il sito deve rinnovare prima di revocare.
- Il comportamento dei menu di GoDaddy per cambiare i nameserver.
