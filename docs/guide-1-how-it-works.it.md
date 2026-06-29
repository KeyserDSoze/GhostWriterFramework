# Come funziona Narrarium

> Questa guida spiega l'architettura del sito e dove vivono i tuoi dati.

## In breve

Narrarium è una **applicazione interamente front-end**. Non c'è un nostro server che conserva i tuoi libri o le tue chiavi. Tutto gira nel browser e si appoggia a servizi che usi già.

Il "back-end" è composto da due pezzi che metti tu:

- **GitHub** = dove vive il libro. Ogni libro è un repository GitHub fatto di file Markdown (capitoli, paragrafi, personaggi, luoghi, segreti, script, bozze, ecc.). Tutte le modifiche sono commit veri sul repository.
- **Drive (Google Drive o OneDrive)** = dove vivono le tue impostazioni e i dati personali dell'app: configurazioni, chiavi, chat del Copilot, storico copie, costi. Quale dei due viene usato dipende dall'account con cui accedi (Google → Google Drive, Microsoft → OneDrive).

L'**LLM (modello AI) lo aggiungi tu**: nelle impostazioni inserisci la tua integrazione (OpenAI o Azure OpenAI) con la tua chiave. Narrarium non fornisce un modello: usa il tuo.

## Lo schema

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
              ┌────────────────────────┐
              │  OpenAI / Azure OpenAI │
              └────────────────────────┘
```

## Cosa significa per te

- **Privacy**: i tuoi testi restano tra il tuo browser, il tuo GitHub, il tuo Drive e il tuo provider AI. Non passano da un nostro server.
- **Controllo**: il libro è un repository GitHub normale. Puoi clonarlo, fare backup, aprirlo con altri strumenti.
- **Costi AI**: le richieste vanno direttamente al tuo provider con la tua chiave, quindi i costi sono i tuoi. Narrarium può **stimarli** se inserisci i prezzi (vedi la guida sui costi).

## Perché serve un token GitHub (PAT)

Per leggere e scrivere i file del libro, il browser ha bisogno di un permesso verso GitHub: un **Personal Access Token (PAT)**. Lo crei tu su GitHub e lo incolli in Narrarium (puoi avere un token di default e/o un token dedicato per ogni libro). Senza PAT, il sito non può salvare i capitoli.
