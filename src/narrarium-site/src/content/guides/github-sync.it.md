# Git, branch e sincronizzazione

Narrarium clona il branch attivo in una working copy IndexedDB. Quando disponibile, le modifiche vengono scritte prima in locale.

## Stato repository

- **Pulito:** nessuna modifica locale o commit da pushare.
- **Modifiche locali:** file modificati ma non committati.
- **Avanti:** commit locali in attesa di push.
- **Remote cambiato:** GitHub contiene commit non ancora locali.
- **Sync incompleta:** il clone locale non è stato verificato completamente.

## Sync completo

Il Sync completo riconcilia le modifiche remote, preserva o committa il lavoro locale quando possibile e pusha secondo la policy configurata. Il dialog stato repository espone Fetch, Pull, Commit, Push, backup, reclone e riparazione.

## Branch e pull request

Ogni libro può scegliere un branch attivo. Copilot e i dialog Git possono elencare branch, cambiarli o crearli, mostrare diff e commit e aprire pull request.

## Due modi per accedere a GitHub

In **Account e sincronizzazione**, la scheda GitHub li offre entrambi, e puoi usare l'uno, l'altro o tutti e due:

- **Connetti con GitHub** (consigliato, quando questo sito lo ha). Accedi con la GitHub App di Narrarium: non c'è nessun token da incollare. GitHub te lo chiede una volta; l'accesso è tenuto dal broker delle credenziali, che lo rinnova da solo, e non fa mai parte delle tue impostazioni sincronizzate. L'app raggiunge solo i repository che le dai, quindi dopo l'accesso la **installi**: **Scegli i repository su GitHub** apre la pagina dove scegli tutti i tuoi repository o solo alcuni. La scheda dice poi dove l'app è installata, **Controlla di nuovo** lo rilegge quando torni da GitHub, e un libro il cui repository non è tra quelli viene nominato, con lo stesso pulsante. Per un'organizzazione, un proprietario dell'organizzazione deve installare o approvare l'app; se richiede il single sign-on (SAML), avvia prima la tua sessione SAML su GitHub. Il token dell'app dura 8 ore e viene rinnovato in background; se l'accesso scade, la scheda dice **Riconnetti GitHub** e non si perde nulla. **Disconnetti** revoca anche l'accesso dell'app su GitHub, su ogni dispositivo. Se la scheda dice che l'accesso con GitHub non è ancora attivo su questo sito, usa un token: il resto non cambia.
- **Un token di accesso personale (avanzato)**. Non scade da solo e funziona per ogni repository a cui è stato dato accesso, in qualsiasi account o organizzazione. Preferiscilo quando un server personale gestisce i tuoi libri, quando usi più account GitHub, o quando la tua organizzazione non permette l'app. Crealo come mostrato in *Crea il primo libro*.

I tuoi libri continuano a funzionare come prima: un token salvato per un libro, un token con nome o quello predefinito vincono sempre sulla connessione. La scheda mostra, per ogni libro, quale token usa (il suo, uno con nome, quello predefinito o la tua connessione GitHub), e un interruttore, **Preferisci la connessione GitHub al token predefinito**, mette la connessione davanti al token predefinito per i libri che non hanno un token proprio. La stessa riga è nelle impostazioni di ogni libro.

## Permessi per tipo di token

Ogni cosa che Narrarium fa su GitHub richiede un permesso del token. Se un permesso manca, GitHub rifiuta quella sola azione e Narrarium ti dice quale; il resto continua a funzionare.

| Azione | Token classico | Token fine-grained | GitHub App (Connetti con GitHub) |
| --- | --- | --- | --- |
| Clonare, fare pull e leggere il libro | `repo` (privata) o `public_repo` | Contents: Read, Metadata: Read | Contents e Metadata: Read, sui repository su cui è installata |
| Commit e push, branch | `repo` | Contents: Read and write | Contents: Read and write |
| Pull request | `repo` | Pull requests: Read and write | Pull requests: Read and write |
| Creare la repository | `repo` | Administration o Repository creation: Read and write | Repository creation (o Administration): write |
| Scrivere `.github/workflows/*` | `workflow` | Workflows: Read and write | Workflows: Read and write |
| Attivare GitHub Pages | `repo` | Pages e Administration: Read and write | non con l'app: attivalo su github.com, oppure usa un token |
| Eliminare una repository | `delete_repo` | Administration: Read and write | non con l'app: eliminala su github.com, oppure usa un token |

- Con la GitHub App, quando un permesso manca te lo dice a parole: Narrarium nomina il permesso da dare all'app (per esempio **Repository creation** per creare un repository, **Workflows** per aggiungere il workflow di Pages) e offre la via d'uscita che funziona sempre: crea tu il repository vuoto su github.com, poi collegalo. Un repository creato dall'app è raggiungibile subito solo se l'app ha il permesso di creazione; se non lo è, la scheda mostra il passo di installazione.

- Un token classico mostra i suoi scope a Narrarium, che li legge prima di creare una repository e ti avverte se ne manca uno. GitHub non dice in anticipo cosa può fare un token fine-grained: Narrarium ci prova e spiega ogni rifiuto a parole.
- Un token fine-grained che seleziona solo alcune repository non può crearne una nuova né usarla subito: per questo scegli **All repositories**. Un token fine-grained ha un solo proprietario: per lavorare in un'organizzazione, rendi l'organizzazione il suo **Resource owner**.
- Le organizzazioni con single sign-on vogliono il token autorizzato per loro (**Configure SSO**). Un rifiuto per questo motivo viene riportato come tale.
- Quando si raggiunge il limite di richieste di GitHub, Narrarium si ferma e ti dice a che ora riprovare; non ritenta mai da solo.

## Creare una repository da un libro

Lo stesso creatore è usato da **Aggiungi libro** (un libro nuovo su GitHub) e da **Impostazioni libro → Collega il libro a GitHub** (un libro che vive su questo dispositivo). Crea la repository, invia i file del libro in un primo commit e il workflow di Pages in un secondo, e, se lo chiedi, attiva GitHub Pages. Se il token non può scrivere workflow o attivare Pages, la repository resta e la pagina del risultato mostra i passi da fare a mano: vedi *Crea il primo libro*.

## Un libro sul tuo server personale

Quando il tuo server personale fa girare l'autopilot di un libro su GitHub, pubblica i suoi commit su GitHub e porta dentro i tuoi prima di ogni passo. Se tu e il server avete cambiato lo stesso file, l'autopilot si ferma e scegli tu quale versione tenere: vedi *Conflitti con GitHub* nella guida Autopilot.

Il server tiene una copia del token del libro (con il tuo consenso quando sposti il libro) e non può rinnovare il token da 8 ore della GitHub App: **I token dell'app durano 8 ore; per un libro gestito dal tuo server usa un token di accesso personale (o tieni il browser aperto).** Narrarium ti avverte quando sposti un libro così e nelle sue impostazioni. Finché un browser con Narrarium è aperto, manda al server il token nuovo a ogni rinnovo (mai il token di rinnovo); un token di accesso personale non ha questo limite.
