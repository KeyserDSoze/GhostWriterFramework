# Primi passi / Getting started

> Come accedere, collegare un libro e configurare l'AI.
> How to sign in, connect a book, and set up the AI.

---

## Italiano

### 1. Accedi

Apri il sito e accedi con **Google** o **Microsoft**.

- Con Google le impostazioni vanno su **Google Drive**.
- Con Microsoft vanno su **OneDrive**.

La prima volta dovrai dare il consenso ai permessi su Drive (servono per salvare le tue impostazioni e le chat).

### 2. Crea un token GitHub (PAT)

Il libro vive su GitHub, quindi serve un token con permesso di scrittura sui repository.

1. Vai su GitHub → Settings → Developer settings → Personal access tokens.
2. Crea un token (fine-grained va benissimo) con accesso ai repository che userai e permesso di **lettura e scrittura sui contenuti**.
3. Copia il token.

In Narrarium puoi:
- impostare un **token di default** in Impostazioni, oppure
- dare a un singolo libro un **token dedicato** (consigliato se usi repository diversi con permessi diversi).

### 3. Collega un libro

- Se hai già un repository Narrarium su GitHub, aggiungilo dalla pagina Libri.
- Se parti da zero, puoi creare il repository del libro con lo strumento del framework (vedi le guide di riferimento) e poi collegarlo.

Un libro = un repository. Narrarium legge la struttura (capitoli, canon, ecc.) direttamente dai file.

### 4. Aggiungi la tua AI (LLM)

Narrarium **non include un modello**: usi il tuo.

1. Vai in Impostazioni → integrazioni AI.
2. Aggiungi un'integrazione **OpenAI** o **Azure OpenAI** con la tua chiave.
3. Indica i modelli (scrittura, eventuale revisione, immagini, voce).
4. Facoltativo: inserisci i **prezzi** per stimare i costi (vedi la guida costi).

Da qui in poi le funzioni AI (Copilot, migliora, sinonimo, generazione script/bozza/paragrafo, immagini, voce) useranno la tua integrazione.

### 5. Inizia a scrivere

- Apri un capitolo, aggiungi un paragrafo.
- Usa lo **script** per progettare la scena, poi genera la **bozza**, poi il **paragrafo finale**.
- Seleziona del testo e usa il tasto destro (desktop) o il pulsante che appare sulla selezione (mobile) per **Migliora** o **Sinonimo**.

---

## English

### 1. Sign in

Open the site and sign in with **Google** or **Microsoft**.

- With Google, settings go to **Google Drive**.
- With Microsoft, they go to **OneDrive**.

The first time you will be asked to grant Drive permissions (needed to save your settings and chats).

### 2. Create a GitHub token (PAT)

The book lives on GitHub, so you need a token with write access to repositories.

1. Go to GitHub → Settings → Developer settings → Personal access tokens.
2. Create a token (fine-grained is fine) with access to the repositories you will use and **read and write access to contents**.
3. Copy the token.

In Narrarium you can:
- set a **default token** in Settings, or
- give a single book a **dedicated token** (recommended if you use different repositories with different permissions).

### 3. Connect a book

- If you already have a Narrarium repository on GitHub, add it from the Books page.
- If you are starting from scratch, you can create the book repository with the framework tooling (see the reference guides) and then connect it.

One book = one repository. Narrarium reads the structure (chapters, canon, etc.) straight from the files.

### 4. Add your AI (LLM)

Narrarium **does not include a model**: you use your own.

1. Go to Settings → AI integrations.
2. Add an **OpenAI** or **Azure OpenAI** integration with your key.
3. Set the models (writing, optional review, images, speech).
4. Optional: enter **prices** to estimate costs (see the cost guide).

From now on, AI features (Copilot, improve, synonym, script/draft/paragraph generation, images, voice) will use your integration.

### 5. Start writing

- Open a chapter, add a paragraph.
- Use the **script** to plan the scene, then generate the **draft**, then the **final paragraph**.
- Select text and use right-click (desktop) or the button that appears on the selection (mobile) for **Improve** or **Synonym**.
