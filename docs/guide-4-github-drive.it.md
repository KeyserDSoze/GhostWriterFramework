# GitHub, Drive e costi

> Branch, commit, pull request, dove finiscono i dati e come si stima la spesa.

## Il libro su GitHub

Ogni libro è un repository. Mentre lavori, Narrarium scrive file Markdown e fa **commit veri** sul branch attivo.

- **Branch di lavoro**: per non scrivere direttamente su `main`, l'app usa un tuo branch personale. Puoi vedere il branch attivo in alto nelle pagine del libro.
- **Commit**: ogni salvataggio (capitolo, paragrafo, canon, script, ecc.) è un commit con un messaggio descrittivo.
- **Pull request**: dal menu Azioni del libro puoi aprire/vedere le PR per portare il tuo branch su `main`.
- **Cronologia commit**: sempre dal menu Azioni puoi consultare la storia.

Le azioni Git (Commit, PR, Esporta, Immagine) sono raccolte nel pulsante **Azioni** della pagina libro.

## Navigazione contestuale

Il menu (hamburger) si popola in base a dove sei:

- nel **libro**: panoramica, dashboard, ghostwriter, stile, asset, reader, impostazioni, canon (personaggi, luoghi, ...);
- nel **capitolo**: script, bozze, resume, valutazione, stile capitolo;
- nel **paragrafo**: script, bozza, finale, valutazione.

In più c'è un pulsante flottante **Azioni** contestuale, e puoi nascondere i pulsanti flottanti dall'icona occhio in alto.

## Dati personali su Drive

Su Drive (Google Drive o OneDrive, secondo l'account) finiscono:

- **Impostazioni** dell'app (incluse le chiavi AI e i PAT che inserisci): le conserva il provider, cifrate dal provider stesso.
- **Chat del Copilot**: ogni conversazione è un file.
- **Storico clipboard**: le ultime 20 copie/tagli.
- **Costi**: un file aggregato per libro.

Il libro (i testi) **non** sta su Drive: sta su GitHub. Drive è solo per la tua configurazione e i dati dell'app.

## Esportazione

Puoi esportare il libro in **DOCX, PDF, EPUB** o come **pacchetto di submission**, interamente nel browser, con preset configurabili e download locale o caricamento su Drive.

## Costi AI

Narrarium può stimare quanto stai spendendo, **solo se imposti i prezzi** nelle integrazioni AI.

- I prezzi si impostano per integrazione, in **euro**.
- Token (chat e immagini) sono per **1.000.000** di token; lo STT è all'**ora**; il TTS è per **1M caratteri**.
- L'app legge dall'API i token usati a ogni richiesta e somma il costo sul libro corrente.
- La pagina **Costi** (ultima voce del menu) mostra il totale complessivo e il totale per libro, suddiviso per chat, immagini, TTS, STT.
- Si tiene solo l'**aggregato** (totali), non il costo di ogni singola richiesta. Se non imposti i prezzi, non viene calcolato nulla.

## Sessione e accesso

- Microsoft mantiene la sessione a lungo grazie al refresh token nel browser.
- Google, per come funziona l'accesso lato browser, può richiedere ogni tanto un nuovo login alla scadenza dell'ora; durante l'uso non vieni disconnesso a metà lavoro.
