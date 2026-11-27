# Impostazioni, privacy e recupero

Narrarium non conserva libro o credenziali su server Narrarium. GitHub conserva il libro; il tuo Drive conserva impostazioni e dati privati; i provider configurati elaborano le richieste AI.

## Restare collegati a Google Drive e OneDrive

Account e sincronizzazione si collega con **credenziali durature** quando il servizio di accesso di Narrarium è disponibile, così non devi accedere di nuovo ogni ora. Il servizio è un Worker Cloudflare che custodisce i segreti client di Google e Microsoft e rinnova i token per il tuo browser; non conserva nulla. Il refresh token lo tiene il tuo browser, solo se hai scelto **Ricorda la connessione su questo dispositivo**, sigillato con una chiave che non si può esportare. Non finisce mai nei dati sincronizzati, nelle esportazioni o nei log. Questo protegge la copia conservata, non da uno script che gira nella pagina.

- **Google:** nessuna scadenza finché non revochi l'accesso (l'app deve essere pubblicata, altrimenti 7 giorni). **Microsoft:** 90 giorni, rinnovati a ogni uso.
- **Disconnetti** le dimentica su questo dispositivo e revoca quelle di Google; quelle di Microsoft si possono revocare solo dal tuo account Microsoft.
- Senza il servizio non cambia nulla: vale l'accesso di sempre, di un'ora (Google) o di 24 ore (Microsoft), e non compare nessuna offerta.

## Cosa chiede Narrarium a Google

A ogni accesso con Google Narrarium chiede solo permessi **non sensibili**: chi sei (`openid`, `profile`, `email`), `drive.appdata` (una cartella nascosta dell'app) e `drive.file` (solo i file e le cartelle che Narrarium crea nel tuo Drive: la cartella **Narrarium** con i dati dell'account e la cartella in cui vanno le esportazioni). Google non richiede verifica e non mostra l'avviso «app non verificata».

- **L'accesso completo a Drive** (lo scope limitato `drive`) non viene mai chiesto all'accesso. Si chiede solo se scegli qualcosa che lo richiede: esportare in una cartella che c'era già, o recuperare le chat di una versione precedente che Google nasconde a Narrarium. La schermata dice perché, Google avvisa che l'app non è verificata per esso, e il permesso resta solo finché la pagina è aperta; ritiralo su myaccount.google.com/connections.
- **Quando un accesso scade**, la scheda di Google dice «Accedi di nuovo a Google Drive su questo dispositivo», perché è scaduto (le credenziali di sessione durano circa un'ora; quelle durature si rinnovano in background tramite il servizio di accesso) e offre il passaggio a quelle durature dove il servizio c'è. I tuoi dati restano al sicuro su questo dispositivo.
- **Controlla la configurazione di Google** (nella scheda di Google) mostra i permessi che il sito chiede, il numero del progetto Google Cloud del suo client id (mai il resto) e la lista per il proprietario del progetto: il **Pubblico** deve essere «In produzione» (in «Test» possono accedere solo gli utenti di prova e l'accesso scade dopo 7 giorni); il client id deve appartenere a quel progetto; gli scope nella console (Accesso ai dati) devono coincidere con l'elenco; togli i vecchi consensi su myaccount.google.com/connections prima di riprovare.

## Sincronizzazione automatica e «Tutto sincronizzato»

In cima ad **Account e sincronizzazione** l'interruttore **Sincronizzazione automatica per tutti i servizi** accende o spegne la sincronizzazione automatica per tutti i servizi collegati insieme. Ogni servizio ha anche un suo interruttore: se lo imposti, quel servizio ignora quello generale (**Segui l'impostazione generale** glielo ridà). Le connessioni fatte prima di questa impostazione mantengono il valore che avevano.

Quando tutto è sincronizzato la scheda del servizio dice **Tutto sincronizzato · ultimo controllo 09:30** e non mostra il pulsante principale **Sincronizza**: compare solo se c'è qualcosa da fare (modifiche non inviate, dati più recenti sul servizio, un errore). **Controlla ora** resta come pulsante discreto per cercare le modifiche fatte su un altro dispositivo.

## Impostazioni

Configura Integrazioni AI, AI Router, Deep Search, tool Copilot, credenziali GitHub, voce e sincronizzazione repository locale. Le impostazioni libro controllano branch, PAT dedicati, metadati reader/export e destinazioni Drive.

## Migrazione e cancellazione

La pagina migrazione copia i dati cloud Narrarium tra account Google e Microsoft. La cancellazione cloud non elimina i repository GitHub.

## Recupero

Gli strumenti repository forniscono backup ZIP, pull remote-wins, riparazione locale come fonte di verità, reclone e guarigione dei clone incompleti. Mantieni backup GitHub e locali per i progetti importanti.
