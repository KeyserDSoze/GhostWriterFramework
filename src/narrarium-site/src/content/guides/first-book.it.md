# Crea il primo libro

## 1. Crea un account GitHub

Crea un account su [github.com](https://github.com). Narrarium salva ogni libro come repository GitHub.

## 2. Accedi a GitHub

Ci sono due modi, e puoi usare l'uno, l'altro o tutti e due.

**Connetti con GitHub (nessun token da incollare).** Apri **Account e sincronizzazione**, nella scheda GitHub scegli **Connetti con GitHub** e accedi su GitHub. Poi **installa** l'app: **Scegli i repository su GitHub** apre la pagina dove scegli tutti i tuoi repository o solo alcuni; la scheda dice dove l'app è installata, e **Controlla di nuovo** lo rilegge quando torni. Con l'app, Narrarium può leggere e scrivere il libro, aprire pull request, creare il repository (all'app serve il permesso **Repository creation**) e aggiungere il workflow di Pages (all'app serve **Workflows**); non può attivare GitHub Pages né eliminare un repository: falli su github.com. Se la scheda dice che l'accesso con GitHub non è ancora attivo su questo sito, usa un token (qui sotto). L'accesso con l'app dura 8 ore e si rinnova da solo; se scade la scheda dice **Riconnetti GitHub**.

**Un token di accesso personale (PAT), avanzato.** Non scade da solo, funziona in qualsiasi account o organizzazione, ed è quello da usare quando il tuo server personale gestisce i tuoi libri o usi più account GitHub. Apri **GitHub → Settings → Developer settings → Personal access tokens** e scegli uno dei due tipi. Ciò che il token può fare decide ciò che Narrarium può fare per te: leggi la tabella prima di crearlo.

| Cosa fa Narrarium | Token classico | Token a grana fine (fine-grained) |
| --- | --- | --- |
| Leggere e scrivere file, branch e commit del libro | `repo` | Contents: Read and write (Metadata: Read lo aggiunge GitHub) |
| Aprire e unire pull request | `repo` | Pull requests: Read and write |
| **Creare la repository** (il tuo account o un'organizzazione) | `repo` (`public_repo` solo per le repository pubbliche) | Administration: Read and write, oppure Repository creation: Read and write |
| **Aggiungere il file del workflow di GitHub Pages** | `workflow` | Workflows: Read and write |
| **Attivare GitHub Pages** | `repo` | Pages: Read and write, e Administration: Read and write |
| Eliminare una repository vuota (solo se lo chiedi tu) | `delete_repo` | Administration: Read and write |

Conta quanto del tuo account il token può vedere, quanto i suoi permessi:

- **Token classico:** funziona su ogni repository che puoi raggiungere. Per un'organizzazione con single sign-on, autorizza il token per l'organizzazione (**Configure SSO** accanto al token).
- **Token fine-grained, tutte le repository:** scegli **All repositories** perché Narrarium possa creare una repository nuova e usarla subito. Un token limitato a **Only select repositories** non vede una repository che non esiste ancora: può collegare un libro già presente ma non crearne uno.
- **Token fine-grained e organizzazioni:** un token fine-grained appartiene a un solo proprietario. Per creare in un'organizzazione, scegli quell'organizzazione come **Resource owner** quando crei il token; l'organizzazione deve consentire i token fine-grained.

Copia subito il token: GitHub non lo mostrerà una seconda volta.

## 3. Configura il token

Solo per un token: in Narrarium apri **Impostazioni → GitHub** e salva il token come PAT predefinito, oppure aggiungi un PAT dedicato mentre colleghi il libro. Un token salvato per un libro, uno con nome o quello predefinito vincono sempre sulla connessione GitHub; **Account e sincronizzazione** mostra quale usa ogni libro.

## 4. Crea o collega un libro

Apri **I miei libri → Aggiungi libro**.

- **Collega** una repository Narrarium esistente dall'elenco.
- **Creane** una nuova: scegli GitHub come archiviazione, poi titolo, nome della repository, **proprietario** (il tuo account o un'organizzazione in cui il token può creare), **visibilità** (privata di default) e se attivare GitHub Pages. Prima di iniziare, un breve elenco dice cosa verrà creato e cosa il token sembra non poter fare; non ti blocca mai.

### Cosa crea il creatore

Una nuova repository contiene gli stessi file di un libro fatto con lo starter del framework (`create-narrarium-book`):

- il libro: file del canone, appunti, plot, la scaletta della misura scelta, il ghostwriter predefinito e i lettori simulati;
- il lettore: un sito Astro che mostra il libro, con gli script per esportare un EPUB e un manoscritto;
- le istruzioni per gli assistenti di scrittura (OpenCode, Claude, Copilot) e le impostazioni di VS Code;
- il **workflow di GitHub Pages**, inviato come secondo commit a parte.

La repository nasce vuota e si riempie in poche richieste (i file vanno inline, non una richiesta ciascuno). Se qualcosa viene rifiutato, la repository resta: non viene mai lasciata a metà senza dirtelo.

### Cosa non fa il creatore

- Non installa nulla sul tuo computer: il lettore viene costruito da GitHub Actions quando il workflow parte.
- Non attiva Pages per una repository **privata** se non lo chiedi: un account GitHub gratuito non può pubblicare Pages da una repository privata (rendila pubblica, o usa un piano a pagamento).
- Non imposta la password opzionale del lettore, non protegge i branch, non invita persone.
- Non elimina mai una repository da solo. Se il primo commit fallisce, la repository vuota resta lì e scegli tu: inviare di nuovo i file, oppure eliminarla (con una conferma).

### Quando una parte non è riuscita

La pagina del risultato dice cosa è stato fatto e cosa no. Non si perde nulla; la parte mancante si fa a mano:

1. **Il workflow di Pages non è stato aggiunto** (il token non ha il permesso *workflow*). Usa il pulsante **Copia il workflow**, apri la repository su GitHub, scegli **Add file → Create new file**, chiamalo `.github/workflows/deploy-reader-pages.yml`, incolla il testo e fai il commit sul branch main. Oppure aggiungi il permesso al token (classico: `workflow`; fine-grained: *Workflows: Read and write*) e crea di nuovo il libro.
2. **Pages non è attivo.** Su GitHub apri la repository → **Settings → Pages** e imposta **Source** su **GitHub Actions**. Poi apri la scheda **Actions** e aspetta che finisca l'esecuzione *Deploy Reader To GitHub Pages*. Il lettore sarà su `https://<proprietario>.github.io/<repository>/`.
3. **Il token non può creare repository.** Crea una repository vuota su github.com e collegala: per un libro che vive su questo dispositivo, **Impostazioni libro → Collega il libro a GitHub** accetta una repository vuota già esistente.

Il workflow non mette in cache npm: una repository fatta in un browser non ha un file di lock e il passo di cache fallirebbe senza. La prima esecuzione installa i pacchetti da zero, qualche secondo più lenta.

## 5. Configura il libro

Usa **Impostazioni libro** per branch attivo, metadati di export, separatori dei paragrafi, destinazione Drive e credenziali specifiche.
