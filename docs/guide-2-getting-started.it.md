# Primi passi

> Parti in locale e collega soltanto i servizi che ti servono.

## 1. Apri Narrarium

Narrarium si apre direttamente in un workspace locale durevole. Non sono necessari account o connessione di rete.

Impostazioni, registro libri, stato reader, bookmark, azioni personalizzate, clipboard, costi, chat e segmenti dell'archivio chat vengono scritti prima in locale. Chiudere e riaprire il browser non richiede il login a un provider.

## 2. Crea un libro

La modalità predefinita è **Solo questo dispositivo**. Un libro locale usa la stessa working copy di file, commit, snapshot di recovery e dirty tracking di un libro GitHub, ma non ha un target remoto.

In seguito puoi aprire le Impostazioni libro e collegare la stessa working copy a una nuova repository GitHub privata. Il PAT è supportato senza OAuth.

## 3. Configura l'AI

Narrarium non include un modello. Apri Impostazioni → integrazioni AI e configura OpenAI, Azure OpenAI, GitHub Models o un altro provider supportato. Configurazione e credenziali vengono salvate nel dataset account locale.

## 4. Repliche account opzionali

Apri **Account e sincronizzazione** per abilitare indipendentemente Google Drive, OneDrive o GitHub. Sono repliche dello stesso dataset account locale, non requisiti di accesso.

- Le credenziali dei connettori e il loro stato attivo/disattivo restano su questo dispositivo.
- I dati logici dell'account usano manifest UTC, hash dei contenuti e vector clock.
- Un errore remoto lascia al sicuro la copia locale e marca soltanto quella replica come in attesa o in errore.
- Le repliche divergenti richiedono una scelta esplicita della copia autorevole.

Il PAT GitHub è il collegamento attualmente funzionante nel browser statico. Il flusso OAuth PKCE è implementato, ma il token endpoint GitHub non espone una risposta CORS leggibile dal browser; vedi `docs/github-oauth-static-client.md`.

## 5. Inizia a scrivere

- Apri un capitolo e aggiungi un paragrafo.
- Usa uno script per progettare la scena, genera la bozza e poi rifinisci il paragrafo finale.
- Seleziona testo e usa l'azione contestuale Migliora o Sinonimo.
- Usa **Sincronizza ora** quando vuoi aggiornare immediatamente le repliche remote abilitate.
