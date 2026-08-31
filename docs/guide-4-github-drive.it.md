# Dati locali, GitHub, Drive e costi

> Dove vivono i dati nell'architettura offline-first.

## Fonte locale autorevole

Narrarium scrive prima ogni normale azione utente nello storage durevole del browser. Il dataset account comprende impostazioni, registro libri, stato reader, bookmark, azioni personalizzate, routing e credenziali AI, clipboard, costi, chat e segmenti lossless delle chat.

Gli errori remoti non annullano mai le modifiche locali. Lo stato globale distingue **Salvato localmente**, **Sync in attesa**, **richiede login** e repliche remote confermate.

## Libri

Un libro può essere **solo locale** o collegato a GitHub. La modalità solo locale è predefinita e usa la stessa working copy di file, commit locali, dirty tracking, lock, diagnostica e snapshot di recovery senza inventare owner o repository remoti.

Un libro locale può essere collegato in seguito a una nuova repository GitHub privata. Identità repository locale, file, cronologia in attesa e recovery vengono conservati. Le operazioni repository GitHub ricevono un token risolto e non distinguono internamente OAuth da PAT.

## Repliche account

Google Drive, OneDrive e la repository GitHub privata `narrarium.settings` sono repliche indipendenti dello stesso dataset account logico. Sullo stesso browser può essere abilitata qualsiasi combinazione.

Provider attivi, token OAuth dei connettori, identità provider, stato retry, ID cartelle ed errori locali dei connettori appartengono esclusivamente al dispositivo e non vengono copiati su altri client.

Ogni copia remota possiede un manifest con:

- versione schema;
- UUID snapshot;
- ora di modifica UTC ISO-8601;
- device ID locale;
- vector clock;
- hash deterministico dei contenuti.

I vector clock classificano le repliche come uguali, avanti, indietro o divergenti. Le copie divergenti non vengono mai sovrascritte automaticamente. La scelta della copia autorevole crea un recovery e una nuova versione di riconciliazione che domina tutti i vector clock osservati.

## Dati account GitHub

Il sync account GitHub usa esattamente `narrarium.settings`. Se manca, viene creata privata. Una repository pubblica viene rifiutata prima del caricamento. Le scritture usano un unico commit Git aggregato come `Sync Narrarium account data`, non un commit per carattere.

Il PAT è supportato direttamente. OAuth GitHub con PKCE è predisposto ma disabilitato perché una verifica reale in Chromium ha confermato che il token endpoint GitHub non espone una risposta CORS leggibile dal browser. Non sono stati introdotti workaround `no-cors` opachi né backend. Vedi `github-oauth-static-client.md`.

## Drive

Google Drive e OneDrive restano disponibili come repliche account e destinazioni di esportazione opzionali. I vecchi file di impostazioni, costi, clipboard e chat possono essere importati nel dataset locale comune. I nuovi snapshot account usano revisioni condizionali del provider quando disponibili per non sovrascrivere modifiche concorrenti.

La disconnessione lascia intatti dati locali e remoti. La cancellazione remota è un'azione separata e confermata esplicitamente.

## Costi ed esportazioni

I contatori dei costi vengono salvati subito in locale e partecipano alla versione account. DOCX, PDF, EPUB, pacchetti di submission e chat esportate restano artefatti generati, scaricabili o caricabili in una cartella Drive scelta.

## Limiti repository nel browser

- file di testo o Markdown: **2 MiB**;
- asset binario: **25 MiB**;
- singola mutazione repository: **50 MiB**;
- singolo trasferimento clone, pull o repair: **250 MiB**, ulteriormente limitato dalla quota browser disponibile.
