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

Il ramo del libro sullo schermo è nella barra in alto, accanto alla pillola della sincronizzazione. Apre il **selettore dei rami**: il ramo attuale e ciò che lo riguarda, ogni ramo su cui hai lavorato (i più recenti per primi) e gli altri rami che ha GitHub, da trovare scrivendo e da aprire con le frecce e Invio. Ogni ramo ha la sua copia di lavoro su questo dispositivo, quindi cambiare ramo non fa mai perdere nulla: il lavoro su un ramo resta su quel ramo.

- **Un nuovo ramo è un'azione sola.** Il selettore propone un nome (`draft/<data di oggi>`); qualche parola diventa `feature/<le-tue-parole>`. Il ramo nasce su questo dispositivo dal ramo attuale, con quello che ha adesso, e si apre subito, anche senza GitHub. Viene pubblicato su GitHub dalla prossima sincronizzazione, o subito con **Pubblicalo subito su GitHub**. Se su GitHub c'è già un ramo con quel nome e altre modifiche, non viene pubblicato né sovrascritto nulla: creane uno con un altro nome.
- **I rami ti seguono.** L'ultimo ramo su cui hai lavorato, e ogni ramo su cui hai lavorato, restano nei dati del tuo account (la copia che si sincronizza: Google Drive, OneDrive o `narrarium.settings`), solo nomi e date. Un altro dispositivo apre il libro sull'ultimo ramo che hai usato e lo dice; se quel ramo non è su GitHub (o non ancora) e non è su quel dispositivo, il libro resta sul ramo che aveva, e il messaggio nomina entrambi.
- **Nella scheda GitHub** delle impostazioni del libro, **Rami e sincronizzazione automatica** mostra l'ultimo ramo e ogni ramo su cui hai lavorato. **Rinomina** dà a un ramo un nome solo in questo elenco, **Dimentica** lo toglie dall'elenco (il ramo su GitHub e la sua copia su questo dispositivo restano), e **Tieni sincronizzato** sceglie: con i più recenti, sempre, o mai da solo. Un libro tenuto su questo dispositivo ha un **Nome del ramo** (`main` se non ne scegli un altro): un repository creato per lui, o uno vuoto, lo riceve come ramo predefinito; un repository che ha già dei commit tiene i suoi rami.
- Copilot e i dialog Git possono anche elencare branch, cambiarli o crearli, mostrare diff e commit e aprire pull request.

## Sincronizzazione automatica

Un libro su GitHub si sincronizza da solo, come scegli in **Impostazioni › Repository locali** per tutti i libri, e per ogni libro nel selettore e nella scheda GitHub: **Spenta**, **Quando il libro si apre e quando ci torni** (la scelta predefinita), o **Anche ogni 5 minuti**.

- Fa solo ciò che non può perdere né unire nulla: porta le modifiche di GitHub in un ramo che non ha nulla da pubblicare, e pubblica le modifiche di questo dispositivo (con un commit con lo stesso messaggio di Sincronizza) solo se nel frattempo GitHub non è cambiato. Quando sono cambiati entrambi, non viene sovrascritto nulla: il pulsante e un messaggio lo dicono, e **Sincronizza ora** apre la sincronizzazione di sempre, che ti chiede dei file cambiati da entrambe le parti. Un ramo che GitHub non ha più non viene mai ricreato da solo.
- Sincronizza prima il ramo sullo schermo, poi i quattro rami usati per ultimi e quelli che hai scelto di tenere sincronizzati (al massimo dieci). Un ramo su cui hai lavorato altrove viene portato su questo dispositivo, scaricando solo i file diversi da quelli delle copie già qui.
- Fa a GitHub una domanda per libro ogni volta (l'elenco dei suoi rami), che non costa nulla del limite orario di GitHub quando non è cambiato niente. Vicino al limite sincronizza solo il ramo sullo schermo, e si ferma fino all'ora successiva. Aspetta mentre l'autopilota lavora sul libro nel browser (anche dopo un ricaricamento, finché l'autopilota non riprende da solo), non porta modifiche in una pagina che stai modificando, e porta soltanto modifiche mentre il tuo server personale lavora sul libro. Una sola scheda del browser sincronizza per tutte.
- Senza una credenziale GitHub o offline non fa nulla, e il menu della pillola dice perché. Lo stesso menu dice quando è avvenuta l'ultima sincronizzazione automatica e che cosa ha fatto: cosa ha portato da GitHub, cosa ha pubblicato, niente da fare, o cosa richiede la tua attenzione.

## Due modi per accedere a GitHub

In **Account e sincronizzazione**, la scheda GitHub li offre entrambi, e puoi usare l'uno, l'altro o tutti e due:

- **Connetti con GitHub** (consigliato, quando questo sito lo ha). Accedi con la GitHub App di Narrarium: non c'è nessun token da incollare. GitHub te lo chiede una volta; l'accesso è tenuto dal broker delle credenziali, che lo rinnova da solo, e non fa mai parte delle tue impostazioni sincronizzate. L'app raggiunge solo i repository che le dai, quindi dopo l'accesso la **installi**: **Scegli i repository su GitHub** apre la pagina dove scegli tutti i tuoi repository o solo alcuni. La scheda dice poi dove l'app è installata, **Controlla di nuovo** lo rilegge quando torni da GitHub, e un libro il cui repository non è tra quelli viene nominato, con lo stesso pulsante. Per un'organizzazione, un proprietario dell'organizzazione deve installare o approvare l'app; se richiede il single sign-on (SAML), avvia prima la tua sessione SAML su GitHub. Il token dell'app dura 8 ore e viene rinnovato in background; se l'accesso scade, la scheda dice **Riconnetti GitHub** e non si perde nulla. **Disconnetti** revoca anche l'accesso dell'app su GitHub, su ogni dispositivo. Se la scheda dice che l'accesso con GitHub non è ancora attivo su questo sito, usa un token: il resto non cambia.
- **Un token di accesso personale (avanzato)**. Non scade da solo e funziona per ogni repository a cui è stato dato accesso, in qualsiasi account o organizzazione. Preferiscilo quando un server personale gestisce i tuoi libri, quando usi più account GitHub, o quando la tua organizzazione non permette l'app. Crealo come mostrato in *Crea il primo libro*.

I tuoi libri continuano a funzionare come prima: un token salvato per un libro, un token con nome o quello predefinito vincono sempre sulla connessione. La scheda mostra, per ogni libro, quale token usa (il suo, uno con nome, quello predefinito o la tua connessione GitHub), e un interruttore, **Preferisci la connessione GitHub al token predefinito**, mette la connessione davanti al token predefinito per i libri che non hanno un token proprio. La stessa riga è nelle impostazioni di ogni libro.

Con l'app collegata, la stessa lista propone anche a un libro che usa un token proprio, uno con nome o quello predefinito il pulsante **Usa la connessione GitHub**, quando l'app è installata sul repository di quel libro. Narrarium controlla prima con la connessione di poter leggere e scrivere il repository e solo se funziona lascia andare il token proprio del libro; altrimenti non cambia nulla. Nulla viene cambiato da solo, e a un libro gestito dal tuo server personale il passaggio non viene proposto, perché il server non può rinnovare il token dell'app. Quando nessun libro ha più bisogno del token predefinito, la scheda propone **Rimuovi il token predefinito**, dopo una conferma.

## Le tue impostazioni in un repository privato

Quando colleghi GitHub, con l'app o con un token, le impostazioni del tuo account si sincronizzano da sole in **narrarium.settings**, un repository privato del tuo account GitHub che Narrarium crea la prima volta e tiene aggiornato. Se hai disattivato la sincronizzazione dell'account nella scheda, resta disattivata. Con l'app, GitHub può rifiutarsi di creare il repository, oppure l'app può non essere installata su uno già esistente: la scheda lo dice, con **Scegli i repository su GitHub** e il pulsante **Riprova**, e nulla viene ritentato da solo. Puoi anche creare tu `narrarium.settings` come repository privato, oppure collegarti con un token. Quando le copie sono diverse (questo dispositivo, GitHub, Google Drive, OneDrive), Narrarium mostra quando ognuna è stata modificata, seleziona la più recente e aspetta la tua conferma con **Usa la copia più recente**: prima di allora non viene sovrascritto nulla, e le altre copie restano a portata di scelta.

## Permessi per tipo di token

Ogni cosa che Narrarium fa su GitHub richiede un permesso del token. Se un permesso manca, GitHub rifiuta quella sola azione e Narrarium ti dice quale; il resto continua a funzionare.

| Azione | Token classico | Token fine-grained | GitHub App (Connetti con GitHub) |
| --- | --- | --- | --- |
| Clonare, fare pull e leggere il libro | `repo` (privata) o `public_repo` | Contents: Read, Metadata: Read | Contents e Metadata: Read, sui repository su cui è installata |
| Commit e push, branch | `repo` | Contents: Read and write | Contents: Read and write |
| Pull request | `repo` | Pull requests: Read and write | Pull requests: Read and write |
| Creare la repository | `repo` | Administration o Repository creation: Read and write | Repository creation (o Administration): write |
| Scrivere `.github/workflows/*` | `workflow` | Workflows: Read and write | Workflows: Read and write |
| Attivare GitHub Pages | `repo` | Pages e Administration: Read and write | Pages: write, se l'app lo ha; altrimenti attivalo su github.com, oppure usa un token |
| Eliminare una repository | `delete_repo` | Administration: Read and write | non con l'app: eliminala su github.com, oppure usa un token |

- Con la GitHub App, quando un permesso manca te lo dice a parole: Narrarium nomina il permesso da dare all'app (per esempio **Repository creation** per creare un repository, **Workflows** per aggiungere il workflow di Pages) e offre la via d'uscita che funziona sempre: crea tu il repository vuoto su github.com, poi collegalo. Un repository creato dall'app è raggiungibile subito solo se l'app ha il permesso di creazione; se non lo è, la scheda mostra il passo di installazione.

- Un token classico mostra i suoi scope a Narrarium, che li legge prima di creare una repository e ti avverte se ne manca uno. GitHub non dice in anticipo cosa può fare un token fine-grained: Narrarium ci prova e spiega ogni rifiuto a parole.
- Un token fine-grained che seleziona solo alcune repository non può crearne una nuova né usarla subito: per questo scegli **All repositories**. Un token fine-grained ha un solo proprietario: per lavorare in un'organizzazione, rendi l'organizzazione il suo **Resource owner**.
- Le organizzazioni con single sign-on vogliono il token autorizzato per loro (**Configure SSO**). Un rifiuto per questo motivo viene riportato come tale.
- Quando si raggiunge il limite di richieste di GitHub, Narrarium si ferma e ti dice a che ora riprovare; non ritenta mai da solo.

## Accesso al lettore: password e GitHub Pages

In **Impostazioni del libro**, un libro su GitHub ha la scheda **Accesso al lettore**. Attiva o disattiva GitHub Pages per il libro, elenca le password che aprono il lettore pubblicato, le aggiunge e le rimuove, e mostra com'è andata l'ultima pubblicazione. Un libro senza password è pubblico: chiunque abbia l'indirizzo può leggerlo.

- **Aggiungi una password** con un'etichetta (per chi è) e una password generata o scritta da te; la scheda ne legge la robustezza e avverte che il libro cifrato è pubblicato a un indirizzo pubblico, quindi chiunque può scaricarlo e provare password sul proprio computer: usa una password lunga e casuale, come quelle generate. **Rimuovi** la toglie: il lettore smette di accettarla alla prossima pubblicazione, e ciò che qualcuno ha già letto o salvato con essa non si può riprendere.
- GitHub non mostra mai il valore di un secret, quindi Narrarium conserva le password nei dati dell'account che già sincronizza (il tuo Google Drive, OneDrive o il repository privato `narrarium.settings`), nascoste finché non premi **Mostra**, con un pulsante **Copia**. Non finiscono mai nel libro, in un'esportazione, in una richiesta a un'IA o in un log. Una password che esiste su GitHub ma non è stata creata qui, e la vecchia password singola di un libro, sono elencate come tali e si possono solo rimuovere.
- Ogni modifica arriva a GitHub in un ordine che non lascia mai il lettore pubblicato puntato a un secret che non c'è: aggiungere scrive il secret, poi lo elenca nella variabile del repository `READER_PASSWORD_SECRETS`, poi avvia il workflow di pubblicazione; rimuovere toglie prima il nome dalla variabile, poi elimina il secret, poi avvia il workflow. I secret si chiamano `READER_PASSWORD_001`, `READER_PASSWORD_002` e così via. Se un passo fallisce la scheda dice quale, cosa è già fatto, cosa sta facendo il lettore pubblicato, e offre di riprovare.
- **Disattiva Pages** chiede conferma. Di default il workflow e le password restano, così riattivando Pages si pubblica con le stesse. Una seconda scelta, separata, elimina anche i secret delle password e la variabile su GitHub, e una terza, ancora separata, dimentica le password conservate in Narrarium.
- Il sito Pages di un repository privato resta raggiungibile dal suo indirizzo sui piani GitHub senza controllo degli accessi per Pages: la cifratura è l'unica protezione. Revocare una password ferma tutto ciò che viene pubblicato dopo, non ciò che è già stato letto.

- **Fin dall'inizio.** Quando crei un libro su GitHub (o colleghi uno che vive su questo dispositivo) con **Attiva anche GitHub Pages**, scegli **Protetto da password** (predefinito) o **Lettore pubblico**. Un lettore protetto riceve una prima password robusta creata per te, mostrata con **Mostra** e **Copia** e conservata nel tuo account Narrarium. Viene messa su GitHub subito dopo che il repository e Pages esistono e prima che venga aggiunto il workflow di Pages, così la primissima pubblicazione la chiede già. Se non è possibile, il workflow viene trattenuto: non è pubblicato nulla, nulla è pubblico, e il risultato dice perché e offre di riprovare. La scelta compare solo quando il lettore che il libro riceve sa leggere le password.

- **Aggiorna il lettore.** Un libro il cui lettore è stato pubblicato prima delle password a più slot (il suo workflow non nomina `READER_PASSWORD_SECRETS`, o la sua cartella `reader/` è più vecchia) lo sente dire, in parole semplici, nella scheda **Lettore online** e nello stato della scheda **GitHub**. Pubblicato con una password e con un lettore vecchio, un libro espone ancora in chiaro l'EPUB (`downloads/book.epub`) e i titoli dei capitoli; aggiornare risolve. **Aggiorna il lettore** fa un solo commit visibile sul ramo di lavoro, mai di nascosto: il workflow scritto dal pacchetto del lettore (la password singola che usi oggi resta valida come una delle password) e i file di `reader/` presi dal modello che il sito porta con sé. I tuoi file non vengono mai toccati; un workflow con modifiche tue mostra le righe che differiscono e vuole un **Sostituisci le mie modifiche** esplicito. Il commit passa dalla copia di lavoro su questo dispositivo e viene pubblicato con la credenziale del libro; offline, o senza credenziale, resta su questo dispositivo e si pubblica alla prossima sincronizzazione, e la scheda dice che il sito pubblicato resta com'è fino ad allora. Dopo la pubblicazione la scheda segue l'esecuzione e propone **Controllo da fuori**: l'indirizzo `<indirizzo Pages>/downloads/book.epub` deve rispondere 404 e `version.json` deve dire che il lettore è protetto (se il browser non può leggere la risposta, la scheda dà la riga `curl` da copiare).

### Permessi necessari

Il token che un libro usa (la GitHub App o un token di accesso personale) ha bisogno di questi permessi del repository, tutti **Read and write** (Metadata: Read c'è sempre):

| Permesso | A cosa serve |
| --- | --- |
| Secrets | scrivere ed eliminare i secret delle password, e leggerne i nomi |
| Variables (Actions variables) | la variabile che li elenca |
| Actions | avviare il workflow di pubblicazione e leggerne le esecuzioni |
| Pages | attivare e disattivare Pages, e leggerne l'indirizzo |
| Contents e Workflows | leggere e aggiornare il file del workflow del lettore |

Quando GitHub rifiuta un passo, la scheda nomina il permesso che manca (legge l'intestazione `X-Accepted-GitHub-Permissions` di GitHub quando c'è) e dice dove aggiungerlo:

- **GitHub App:** i permessi dell'app li imposta chi gestisce l'app (GitHub › Settings › Developer settings › GitHub Apps › l'app › Permissions & events › Repository permissions). Dopo che cambiano, ogni installazione deve accettare i nuovi permessi (GitHub › Settings › Applications › l'app, oppure la richiesta che GitHub invia). Fino ad allora usa un token di accesso personale.
- **Token fine-grained:** GitHub › Settings › Developer settings › Personal access tokens › Fine-grained tokens › il token › Repository permissions: imposta Actions, Contents, Pages, Secrets, Variables e Workflows su **Read and write**, poi salva.
- **Token classico:** lo scope `repo`, e `workflow` per modificare il file del workflow.

## Creare una repository da un libro

Lo stesso creatore è usato da **Aggiungi libro** (un libro nuovo su GitHub) e da **Impostazioni libro → Collega il libro a GitHub** (un libro che vive su questo dispositivo). Crea la repository, invia i file del libro in un primo commit e il workflow di Pages in un secondo, e, se lo chiedi, attiva GitHub Pages. Se il token non può scrivere workflow o attivare Pages, la repository resta e la pagina del risultato mostra i passi da fare a mano: vedi *Crea il primo libro*.

## Un libro sul tuo server personale

Quando il tuo server personale fa girare l'autopilot di un libro su GitHub, pubblica i suoi commit su GitHub e porta dentro i tuoi prima di ogni passo. Se tu e il server avete cambiato lo stesso file, l'autopilot si ferma e scegli tu quale versione tenere: vedi *Conflitti con GitHub* nella guida Autopilot.

Il server tiene una copia del token del libro (con il tuo consenso quando sposti il libro) e non può rinnovare il token da 8 ore della GitHub App: **I token dell'app durano 8 ore; per un libro gestito dal tuo server usa un token di accesso personale (o tieni il browser aperto).** Narrarium ti avverte quando sposti un libro così e nelle sue impostazioni. Finché un browser con Narrarium è aperto, manda al server il token nuovo a ogni rinnovo (mai il token di rinnovo); un token di accesso personale non ha questo limite.
