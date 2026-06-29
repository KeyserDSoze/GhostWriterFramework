# Come funziona Narrarium / How Narrarium works

> Questa guida spiega l'architettura del sito e dove vivono i tuoi dati.
> This guide explains the site architecture and where your data lives.

---

## Italiano

### In breve

Narrarium è una **applicazione interamente front-end**. Non c'è un nostro server che conserva i tuoi libri o le tue chiavi. Tutto gira nel browser e si appoggia a servizi che usi già.

Il "back-end" è composto da due pezzi che metti tu:

- **GitHub** = dove vive il libro. Ogni libro è un repository GitHub fatto di file Markdown (capitoli, paragrafi, personaggi, luoghi, segreti, script, bozze, ecc.). Tutte le modifiche sono commit veri sul repository.
- **Drive (Google Drive o OneDrive)** = dove vivono le tue impostazioni e i dati personali dell'app: configurazioni, chiavi, chat del Copilot, storico copie, costi. Quale dei due viene usato dipende dall'account con cui accedi (Google → Google Drive, Microsoft → OneDrive).

L'**LLM (modello AI) lo aggiungi tu**: nelle impostazioni inserisci la tua integrazione (OpenAI o Azure OpenAI) con la tua chiave. Narrarium non fornisce un modello: usa il tuo.

### Lo schema

```
            ┌──────────────────────────────┐
            │        Browser (sito)        │
            │   React, tutto front-end     │
            └───────┬───────────────┬──────┘
                    │               │
          libro     │               │   impostazioni, chat,
        (Markdown)  │               │   costi, clipboard
                    ▼               ▼
              ┌──────────┐   ┌──────────────────┐
              │  GitHub  │   │  Google Drive /  │
              │  (repo)  │   │     OneDrive     │
              └──────────┘   └──────────────────┘

                    ▲
                    │  richieste AI dirette (con la tua chiave)
                    ▼
              ┌──────────────────────┐
              │  OpenAI / Azure OpenAI │
              └──────────────────────┘
```

### Cosa significa per te

- **Privacy**: i tuoi testi restano tra il tuo browser, il tuo GitHub, il tuo Drive e il tuo provider AI. Non passano da un nostro server.
- **Controllo**: il libro è un repository GitHub normale. Puoi clonarlo, fare backup, aprirlo con altri strumenti.
- **Costi AI**: le richieste vanno direttamente al tuo provider con la tua chiave, quindi i costi sono i tuoi. Narrarium può **stimarli** se inserisci i prezzi (vedi la guida sui costi).

### Perché serve un token GitHub (PAT)

Per leggere e scrivere i file del libro, il browser ha bisogno di un permesso verso GitHub: un **Personal Access Token (PAT)**. Lo crei tu su GitHub e lo incolli in Narrarium (puoi avere un token di default e/o un token dedicato per ogni libro). Senza PAT, il sito non può salvare i capitoli.

---

## English

### In a nutshell

Narrarium is a **fully front-end application**. There is no server of ours that stores your books or your keys. Everything runs in the browser and relies on services you already use.

The "back-end" is made of two pieces that you provide:

- **GitHub** = where the book lives. Each book is a GitHub repository made of Markdown files (chapters, paragraphs, characters, locations, secrets, scripts, drafts, and so on). Every change is a real commit on the repository.
- **Drive (Google Drive or OneDrive)** = where your settings and personal app data live: configuration, keys, Copilot chats, copy history, costs. Which one is used depends on the account you sign in with (Google → Google Drive, Microsoft → OneDrive).

You **bring your own LLM (AI model)**: in settings you add your integration (OpenAI or Azure OpenAI) with your own key. Narrarium does not ship a model — it uses yours.

### The diagram

```
            ┌──────────────────────────────┐
            │        Browser (the site)    │
            │   React, fully front-end     │
            └───────┬───────────────┬──────┘
                    │               │
          book      │               │   settings, chats,
       (Markdown)   │               │   costs, clipboard
                    ▼               ▼
              ┌──────────┐   ┌──────────────────┐
              │  GitHub  │   │  Google Drive /  │
              │  (repo)  │   │     OneDrive     │
              └──────────┘   └──────────────────┘

                    ▲
                    │  direct AI calls (with your key)
                    ▼
              ┌──────────────────────┐
              │  OpenAI / Azure OpenAI │
              └──────────────────────┘
```

### What this means for you

- **Privacy**: your text stays between your browser, your GitHub, your Drive and your AI provider. It does not go through a server of ours.
- **Control**: the book is a normal GitHub repository. You can clone it, back it up, open it with other tools.
- **AI cost**: requests go straight to your provider with your key, so the cost is yours. Narrarium can **estimate** it if you enter prices (see the cost guide).

### Why a GitHub token (PAT) is needed

To read and write the book files, the browser needs permission to GitHub: a **Personal Access Token (PAT)**. You create it on GitHub and paste it into Narrarium (you can have a default token and/or a dedicated token per book). Without a PAT, the site cannot save your chapters.
