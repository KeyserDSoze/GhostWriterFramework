# Impostazioni, privacy e recupero

Narrarium non conserva libro o credenziali su server Narrarium. GitHub conserva il libro; il tuo Drive conserva impostazioni e dati privati; i provider configurati elaborano le richieste AI.

## Restare collegati a Google Drive e OneDrive

Account e sincronizzazione si collega con **credenziali durature** quando il servizio di accesso di Narrarium è disponibile, così non devi accedere di nuovo ogni ora. Il servizio è un Worker Cloudflare che custodisce i segreti client di Google e Microsoft e rinnova i token per il tuo browser; non conserva nulla. Il refresh token lo tiene il tuo browser, solo se hai scelto **Ricorda la connessione su questo dispositivo**, sigillato con una chiave che non si può esportare. Non finisce mai nei dati sincronizzati, nelle esportazioni o nei log. Questo protegge la copia conservata, non da uno script che gira nella pagina.

- **Google:** nessuna scadenza finché non revochi l'accesso (l'app deve essere pubblicata, altrimenti 7 giorni). **Microsoft:** 90 giorni, rinnovati a ogni uso.
- **Disconnetti** le dimentica su questo dispositivo e revoca quelle di Google; quelle di Microsoft si possono revocare solo dal tuo account Microsoft.
- Senza il servizio non cambia nulla: vale l'accesso di sempre, di un'ora (Google) o di 24 ore (Microsoft), e non compare nessuna offerta.

## Impostazioni

Configura Integrazioni AI, AI Router, Deep Search, tool Copilot, credenziali GitHub, voce e sincronizzazione repository locale. Le impostazioni libro controllano branch, PAT dedicati, metadati reader/export e destinazioni Drive.

## Migrazione e cancellazione

La pagina migrazione copia i dati cloud Narrarium tra account Google e Microsoft. La cancellazione cloud non elimina i repository GitHub.

## Recupero

Gli strumenti repository forniscono backup ZIP, pull remote-wins, riparazione locale come fonte di verità, reclone e guarigione dei clone incompleti. Mantieni backup GitHub e locali per i progetti importanti.
