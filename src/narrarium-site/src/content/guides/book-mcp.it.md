# Server MCP di un libro

Ogni libro sul tuo server personale può avere il suo **Server MCP**: un indirizzo del server (`/mcp/<nome>`) dove un assistente come Claude Code, Cursor, VS Code, ChatGPT o Claude.ai legge il libro e lo modifica con strumenti simili a quelli del Copilot di Narrarium (il [Model Context Protocol](https://modelcontextprotocol.io)). È spento per ogni libro finché non lo accendi, un libro alla volta. La [pagina MCP](/mcp) pubblica elenca ogni strumento che l'assistente riceve, con ciò che consente ogni permesso.

## Dove si trova

Apri il libro e vai in **Impostazioni libro**: la sezione **Server MCP** è in fondo alla pagina. Ciò che cambi lì vale subito sul server, senza **Salva**. La sezione è per un libro che sta sul tuo server personale (spostalo lì da **Dove gira**, nella pagina **In diretta** del suo autopilot); per ogni altro libro ha una riga con la strada per **Impostazioni** → **Server personale**. Un server troppo vecchio per averlo lo dice: aggiornalo dalle stesse impostazioni.

## Accenderlo

Attiva **Server MCP di questo libro**. La sezione mostra allora l'**Indirizzo** del libro, con un pulsante che lo copia, e il suo **Nome dell'indirizzo**, l'ultima parte dell'indirizzo: lettere minuscole, cifre e trattini singoli, fino a 80 caratteri. **Cambia l'indirizzo** gli dà un altro nome; se il server ne rifiuta uno (ce l'ha un altro libro, o non è un nome valido), il campo dice perché.

Spegnerlo, o cambiare l'indirizzo, **scollega ogni app** collegata al libro: ognuna dovrà chiederti di nuovo il permesso, e ogni assistente avrà bisogno del nuovo indirizzo. La pagina chiede conferma prima di fare l'una o l'altra cosa, e dice quante app sono collegate.

Se il server non ha ancora un indirizzo pubblico, l'indirizzo funziona solo sul computer del server, e la sezione lo dice con le parole del server: ChatGPT, Claude.ai e gli assistenti su altri dispositivi hanno bisogno di un indirizzo pubblico **https**, che imposti nel pannello di amministrazione del server (**Rete approvata**).

## Claude Code, Cursor e VS Code

Questi assistenti mandano un **token** in un'intestazione. Creane uno per l'assistente nel pannello di amministrazione del server (**Client**), con i soli permessi che gli servono, e mettilo al posto di `IL_TUO_TOKEN` nella configurazione che la sezione mostra per ciascuno, per esempio:

```bash
claude mcp add --transport http il-porto-di-vetro https://books.example.net/mcp/il-porto-di-vetro \
  --header "Authorization: Bearer IL_TUO_TOKEN"
```

Il token va nell'intestazione `Authorization`, mai nell'indirizzo. Narrarium non mostra mai il token di questo dispositivo.

## ChatGPT e Claude.ai

Su un server che lascia collegare le app da sole (con OAuth), incolla l'indirizzo: in Claude.ai come connettore personalizzato, in ChatGPT come connettore in modalità sviluppatore, con OAuth. Si apre una pagina del **tuo** server: dimostri che sei tu con una **passkey** (o il codice amministratore) e scegli cosa può fare l'app. Di base può solo leggere; modificare il libro e comandare l'autopilot restano spenti finché non li accendi.

**App collegate** elenca le app collegate al libro: il nome che l'app si è data, cosa può fare (leggere il libro, modificare il libro, comandare l'autopilot), l'indirizzo a cui torna, quando è stata collegata e quando è stata usata l'ultima volta. **Revoca** ne scollega una, dopo aver chiesto conferma; **Aggiorna l'elenco** lo rilegge, per un'app che hai appena autorizzato. Le tue passkey e il registro delle ultime chiamate sono nel pannello di amministrazione del server, in **App collegate (MCP)**.

## La Scaletta

Un assistente che può leggere il libro può leggerne la **Scaletta** (il tuo piano capitolo per capitolo, che l'autopilot segue) con due strumenti: `read_outline`, che dà la descrizione del libro e le voci una pagina alla volta (può anche cercare un numero o delle parole), e `read_outline_entry`, che dà una voce intera, con l'indicazione se il suo capitolo è già scritto o congelato e cosa farebbe l'autopilot se la voce cambiasse. Un assistente che può modificare il libro cambia la Scaletta con `edit_outline`: fino a 50 modifiche di fila (aggiungere, inserire, spostare, togliere o cambiare una voce, cambiare la descrizione del libro), salvate insieme in **un solo commit** che puoi annullare. La Scaletta si cambia solo così, come fa lo strumento «Modifica la Scaletta» del Copilot: l'assistente non può scriverne i file come file qualsiasi. Ciò che scrive lì è **tuo** (l'autopilot lo segue e non lo riscrive mai). Può sostituire il testo di una voce solo dopo averla letta, e se nel frattempo l'hai cambiata non scrive nulla. Una modifica che toccherebbe più di 1.000 file (per esempio un nuovo capitolo in testa a una Scaletta lunghissima) resta a te, nella pagina Scaletta.

## Il rischio

Un modello che legge il libro legge testo, e il testo può dire qualsiasi cosa: può essere convinto a usare gli strumenti (si chiama prompt injection). Quindi dai il permesso di modifica solo alle app di cui ti fidi, dai a ogni assistente solo i permessi che gli servono, e spegni il server MCP di un libro su cui non lavori con un assistente. Ogni modifica di un assistente è un commit del libro, che puoi annullare.
