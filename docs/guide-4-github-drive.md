# GitHub, Drive e costi / GitHub, Drive and costs

> Branch, commit, pull request, dove finiscono i dati e come si stima la spesa.
> Branches, commits, pull requests, where data goes, and how spend is estimated.

---

## Italiano

### Il libro su GitHub

Ogni libro è un repository. Mentre lavori, Narrarium scrive file Markdown e fa **commit veri** sul branch attivo.

- **Branch di lavoro**: per non scrivere direttamente su `main`, l'app usa un tuo branch personale. Puoi vedere il branch attivo in alto nelle pagine del libro.
- **Commit**: ogni salvataggio (capitolo, paragrafo, canon, script, ecc.) è un commit con un messaggio descrittivo.
- **Pull request**: dal menu Azioni del libro puoi aprire/vedere le PR per portare il tuo branch su `main`.
- **Cronologia commit**: sempre dal menu Azioni puoi consultare la storia.

Le azioni Git (Commit, PR, Esporta, Immagine) sono raccolte nel pulsante **Azioni** della pagina libro.

### Navigazione contestuale

Il menu (hamburger) si popola in base a dove sei:

- nel **libro**: panoramica, dashboard, ghostwriter, stile, asset, reader, impostazioni, canon (personaggi, luoghi, ...);
- nel **capitolo**: script, bozze, resume, valutazione, stile capitolo;
- nel **paragrafo**: script, bozza, finale, valutazione.

In più c'è un pulsante flottante **Azioni** contestuale, e puoi nascondere i pulsanti flottanti dall'icona occhio in alto.

### Dati personali su Drive

Su Drive (Google Drive o OneDrive, secondo l'account) finiscono:

- **Impostazioni** dell'app (incluse le chiavi AI e i PAT che inserisci): le conserva il provider, cifrate dal provider stesso.
- **Chat del Copilot**: ogni conversazione è un file.
- **Storico clipboard**: le ultime 20 copie/tagli.
- **Costi**: un file aggregato per libro.

Il libro (i testi) **non** sta su Drive: sta su GitHub. Drive è solo per la tua configurazione e i dati dell'app.

### Esportazione

Puoi esportare il libro in **DOCX, PDF, EPUB** o come **pacchetto di submission**, interamente nel browser, con preset configurabili e download locale o caricamento su Drive.

### Costi AI

Narrarium può stimare quanto stai spendendo, **solo se imposti i prezzi** nelle integrazioni AI.

- I prezzi si impostano per integrazione, in **euro**.
- Token (chat e immagini) sono per **1.000.000** di token; lo STT è all'**ora**; il TTS è per **1M caratteri**.
- L'app legge dall'API i token usati a ogni richiesta e somma il costo sul libro corrente.
- La pagina **Costi** (ultima voce del menu) mostra il totale complessivo e il totale per libro, suddiviso per chat, immagini, TTS, STT.
- Si tiene solo l'**aggregato** (totali), non il costo di ogni singola richiesta. Se non imposti i prezzi, non viene calcolato nulla.

### Sessione e accesso

- Microsoft mantiene la sessione a lungo grazie al refresh token nel browser.
- Google, per come funziona l'accesso lato browser, può richiedere ogni tanto un nuovo login alla scadenza dell'ora; durante l'uso non vieni disconnesso a metà lavoro.

---

## English

### The book on GitHub

Each book is a repository. As you work, Narrarium writes Markdown files and makes **real commits** to the active branch.

- **Working branch**: to avoid writing directly to `main`, the app uses a personal branch of yours. You can see the active branch at the top of the book pages.
- **Commit**: every save (chapter, paragraph, canon, script, etc.) is a commit with a descriptive message.
- **Pull request**: from the book's Actions menu you can open/view PRs to bring your branch into `main`.
- **Commit history**: also from the Actions menu you can browse the history.

Git actions (Commit, PR, Export, Image) are gathered in the **Actions** button on the book page.

### Contextual navigation

The (hamburger) menu populates based on where you are:

- in the **book**: overview, dashboard, ghostwriters, style, assets, reader, settings, canon (characters, locations, ...);
- in the **chapter**: scripts, drafts, resume, evaluation, chapter style;
- in the **paragraph**: script, draft, final, evaluation.

There is also a contextual floating **Actions** button, and you can hide the floating buttons from the eye icon at the top.

### Personal data on Drive

On Drive (Google Drive or OneDrive, depending on the account) the following live:

- App **settings** (including the AI keys and PATs you enter): kept by the provider, encrypted by the provider itself.
- **Copilot chats**: each conversation is a file.
- **Clipboard history**: the last 20 copies/cuts.
- **Costs**: one aggregate file per book.

The book (your text) is **not** on Drive: it is on GitHub. Drive is only for your configuration and app data.

### Export

You can export the book to **DOCX, PDF, EPUB** or as a **submission package**, entirely in the browser, with configurable presets and local download or upload to Drive.

### AI costs

Narrarium can estimate how much you are spending, **only if you set prices** in the AI integrations.

- Prices are set per integration, in **euro**.
- Tokens (chat and images) are per **1,000,000** tokens; STT is per **hour**; TTS is per **1M characters**.
- The app reads from the API the tokens used on each request and adds the cost to the current book.
- The **Costs** page (last menu item) shows the grand total and the per-book total, split by chat, images, TTS, STT.
- Only the **aggregate** (totals) is kept, not the cost of each individual request. If you don't set prices, nothing is computed.

### Session and sign-in

- Microsoft keeps the session for a long time thanks to the refresh token in the browser.
- Google, because of how browser sign-in works, may occasionally require a new login when the hour expires; during use you are not signed out mid-work.
