# Primi passi

> Come accedere, collegare un libro e configurare l'AI.

## 1. Accedi

Apri il sito e accedi con **Google** o **Microsoft**.

- Con Google le impostazioni vanno su **Google Drive**.
- Con Microsoft vanno su **OneDrive**.

La prima volta dovrai dare il consenso ai permessi su Drive (servono per salvare le tue impostazioni e le chat).

## 2. Crea un token GitHub (PAT)

Il libro vive su GitHub, quindi serve un token con permesso di scrittura sui repository.

1. Vai su GitHub → Settings → Developer settings → Personal access tokens.
2. Crea un token (fine-grained va benissimo) con accesso ai repository che userai e permesso di **lettura e scrittura sui contenuti**.
3. Copia il token.

In Narrarium puoi:
- impostare un **token di default** in Impostazioni, oppure
- dare a un singolo libro un **token dedicato** (consigliato se usi repository diversi con permessi diversi).

## 3. Collega un libro

- Se hai già un repository Narrarium su GitHub, aggiungilo dalla pagina Libri.
- Se parti da zero, puoi creare il repository del libro con lo strumento del framework (vedi le guide di riferimento) e poi collegarlo.

Un libro = un repository. Narrarium legge la struttura (capitoli, canon, ecc.) direttamente dai file.

## 4. Aggiungi la tua AI (LLM)

Narrarium **non include un modello**: usi il tuo.

1. Vai in Impostazioni → integrazioni AI.
2. Aggiungi un'integrazione **OpenAI** o **Azure OpenAI** con la tua chiave.
3. Indica i modelli (scrittura, eventuale revisione, immagini, voce).
4. Facoltativo: inserisci i **prezzi** per stimare i costi (vedi la guida costi).

Da qui in poi le funzioni AI (Copilot, migliora, sinonimo, generazione script/bozza/paragrafo, immagini, voce) useranno la tua integrazione.

## 5. Inizia a scrivere

- Apri un capitolo, aggiungi un paragrafo.
- Usa lo **script** per progettare la scena, poi genera la **bozza**, poi il **paragrafo finale**.
- Seleziona del testo e usa il tasto destro (desktop) o il pulsante che appare sulla selezione (mobile) per **Migliora** o **Sinonimo**.
