# Primi passi

> Parti in locale e collega soltanto i servizi che ti servono.

## 1. Apri Narrarium

Narrarium si apre direttamente in un workspace locale durevole. Non sono necessari account o connessione di rete.

Impostazioni, registro libri, stato reader, bookmark, azioni personalizzate, clipboard, costi, chat e segmenti dell'archivio chat vengono scritti prima in locale. Chiudere e riaprire il browser non richiede il login a un provider.

## 2. Crea un libro

La modalità predefinita è **Solo questo dispositivo**. Un libro locale usa la stessa working copy di file, commit, snapshot di recovery e dirty tracking di un libro GitHub, ma non ha un target remoto.

In seguito puoi aprire le Impostazioni libro e collegare la stessa working copy a una nuova repository GitHub privata. Il PAT è supportato senza OAuth.

## 3. Configura l'AI

Narrarium non include un modello. Apri **Impostazioni → Integrazioni AI** e aggiungi OpenAI, Azure OpenAI, GitHub Models o un altro provider supportato. Configurazione e credenziali vengono salvate nel dataset account locale. Poi apri **Impostazioni → AI Router** per scegliere quale modello gestisce ogni task, con i fallback.

## 4. Repliche account opzionali

Apri **Account e sincronizzazione** per abilitare indipendentemente Google Drive, OneDrive o GitHub. Sono repliche dello stesso dataset account locale, non requisiti di accesso.

- Le credenziali dei connettori e il loro stato attivo/disattivo restano su questo dispositivo.
- I dati logici dell'account usano manifest UTC, hash dei contenuti e vector clock.
- Un errore remoto lascia al sicuro la copia locale e marca soltanto quella replica come in attesa o in errore.
- Le repliche divergenti richiedono una scelta esplicita della copia autorevole.
- Google Drive e OneDrive possono restare collegati con **credenziali durature** che si rinnovano da sole, così non devi accedere di nuovo ogni ora. Le schede di **Account e sincronizzazione** mostrano che tipo di credenziali ha ogni connessione e propongono **Passa a credenziali durature**. Serve il servizio di accesso di Narrarium (un Worker Cloudflare); senza, vale l'accesso di sempre, di un'ora (Google) o di 24 ore (Microsoft), e non cambia altro. Google le mantiene finché non revochi l'accesso (l'app deve essere pubblicata, non in test: altrimenti 7 giorni); Microsoft le mantiene per 90 giorni, rinnovati a ogni uso. **Disconnetti** le dimentica su questo dispositivo e revoca quelle di Google; quelle di Microsoft si possono revocare solo dal tuo account Microsoft.

GitHub si collega in due modi in **Account e sincronizzazione**: **Connetti con GitHub** (la GitHub App di Narrarium, tramite il servizio di accesso di Narrarium, senza token da incollare; l'app si installa poi sui repository che scegli) e un **token di accesso personale** (avanzato; quello giusto per i libri gestiti dal tuo server personale e per più account). Entrambi possono creare un repository completo del libro dove i loro permessi lo consentono. Vedi `docs/github-oauth-static-client.md`.

## 5. Inizia a scrivere

- Apri un capitolo e aggiungi un paragrafo.
- Usa uno script per progettare la scena, genera la bozza e poi rifinisci il paragrafo finale.
- Seleziona testo e usa l'azione contestuale Migliora o Sinonimo.
- Usa **Sincronizza ora** quando vuoi aggiornare immediatamente le repliche remote abilitate.
