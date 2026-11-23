# Git, branch e sincronizzazione

Narrarium clona il branch attivo in una working copy IndexedDB. Quando disponibile, le modifiche vengono scritte prima in locale.

## Stato repository

- **Pulito:** nessuna modifica locale o commit da pushare.
- **Modifiche locali:** file modificati ma non committati.
- **Avanti:** commit locali in attesa di push.
- **Remote cambiato:** GitHub contiene commit non ancora locali.
- **Sync incompleta:** il clone locale non è stato verificato completamente.

## Sync completo

Il Sync completo riconcilia le modifiche remote, preserva o committa il lavoro locale quando possibile e pusha secondo la policy configurata. Il dialog stato repository espone Fetch, Pull, Commit, Push, backup, reclone e riparazione.

## Branch e pull request

Ogni libro può scegliere un branch attivo. Copilot e i dialog Git possono elencare branch, cambiarli o crearli, mostrare diff e commit e aprire pull request.

## Permessi per tipo di token

Ogni cosa che Narrarium fa su GitHub richiede un permesso del token. Se un permesso manca, GitHub rifiuta quella sola azione e Narrarium ti dice quale; il resto continua a funzionare.

| Azione | Token classico | Token fine-grained |
| --- | --- | --- |
| Clonare, fare pull e leggere il libro | `repo` (privata) o `public_repo` | Contents: Read, Metadata: Read |
| Commit e push, branch | `repo` | Contents: Read and write |
| Pull request | `repo` | Pull requests: Read and write |
| Creare la repository | `repo` | Administration o Repository creation: Read and write |
| Scrivere `.github/workflows/*` | `workflow` | Workflows: Read and write |
| Attivare GitHub Pages | `repo` | Pages e Administration: Read and write |
| Eliminare una repository | `delete_repo` | Administration: Read and write |

- Un token classico mostra i suoi scope a Narrarium, che li legge prima di creare una repository e ti avverte se ne manca uno. GitHub non dice in anticipo cosa può fare un token fine-grained: Narrarium ci prova e spiega ogni rifiuto a parole.
- Un token fine-grained che seleziona solo alcune repository non può crearne una nuova né usarla subito: per questo scegli **All repositories**. Un token fine-grained ha un solo proprietario: per lavorare in un'organizzazione, rendi l'organizzazione il suo **Resource owner**.
- Le organizzazioni con single sign-on vogliono il token autorizzato per loro (**Configure SSO**). Un rifiuto per questo motivo viene riportato come tale.
- Quando si raggiunge il limite di richieste di GitHub, Narrarium si ferma e ti dice a che ora riprovare; non ritenta mai da solo.

## Creare una repository da un libro

Lo stesso creatore è usato da **Aggiungi libro** (un libro nuovo su GitHub) e da **Impostazioni libro → Collega il libro a GitHub** (un libro che vive su questo dispositivo). Crea la repository, invia i file del libro in un primo commit e il workflow di Pages in un secondo, e, se lo chiedi, attiva GitHub Pages. Se il token non può scrivere workflow o attivare Pages, la repository resta e la pagina del risultato mostra i passi da fare a mano: vedi *Crea il primo libro*.

## Un libro sul tuo server personale

Quando il tuo server personale fa girare l'autopilot di un libro su GitHub, pubblica i suoi commit su GitHub e porta dentro i tuoi prima di ogni passo. Se tu e il server avete cambiato lo stesso file, l'autopilot si ferma e scegli tu quale versione tenere: vedi *Conflitti con GitHub* nella guida Autopilot.
