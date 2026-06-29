# How Narrarium works

> This guide explains the site architecture and where your data lives.

## In a nutshell

Narrarium is a **fully front-end application**. There is no server of ours that stores your books or your keys. Everything runs in the browser and relies on services you already use.

The "back-end" is made of two pieces that you provide:

- **GitHub** = where the book lives. Each book is a GitHub repository made of Markdown files (chapters, paragraphs, characters, locations, secrets, scripts, drafts, and so on). Every change is a real commit on the repository.
- **Drive (Google Drive or OneDrive)** = where your settings and personal app data live: configuration, keys, Copilot chats, copy history, costs. Which one is used depends on the account you sign in with (Google → Google Drive, Microsoft → OneDrive).

You **bring your own LLM (AI model)**: in settings you add your integration (OpenAI or Azure OpenAI) with your own key. Narrarium does not ship a model — it uses yours.

## The diagram

```
            ┌──────────────────────────────┐
            │       Browser (the site)     │
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
              ┌────────────────────────┐
              │  OpenAI / Azure OpenAI │
              └────────────────────────┘
```

## What this means for you

- **Privacy**: your text stays between your browser, your GitHub, your Drive and your AI provider. It does not go through a server of ours.
- **Control**: the book is a normal GitHub repository. You can clone it, back it up, open it with other tools.
- **AI cost**: requests go straight to your provider with your key, so the cost is yours. Narrarium can **estimate** it if you enter prices (see the cost guide).

## Why a GitHub token (PAT) is needed

To read and write the book files, the browser needs permission to GitHub: a **Personal Access Token (PAT)**. You create it on GitHub and paste it into Narrarium (you can have a default token and/or a dedicated token per book). Without a PAT, the site cannot save your chapters.
