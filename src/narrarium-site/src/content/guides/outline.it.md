# La Sinossi

La Sinossi è il piano del libro, capitolo per capitolo: l'idea del libro (la premessa, il pitch) e, per ogni capitolo, un titolo ipotetico, cosa succede e, quando non è quello del libro, il ghostwriter che lo scrive. Aprila dal menu del libro (**Sinossi**). Vive nei file del libro (`outline/book.md` e un `outline/chapters/<NNN>.md` per capitolo), quindi viaggia con il libro come tutto il resto.

## La pagina

In alto, **Il libro** è una scheda sola: un titolo di lavoro (facoltativo: il titolo vero del libro resta nelle sue impostazioni), l'**Idea, promessa o pitch** (di cosa parla il libro, di chi parla e cosa è in gioco, in una o due frasi; dall'idea l'autopilot costruisce il concept e il piano), il genere, il pubblico, le **Parole per scena** e la **Trama capitolo per capitolo** (facoltativa). **Salva tutto** (o Ctrl+S) salva l'intera scheda in una volta: l'idea e il titolo nel libro, i campi del brief in `outline/_brief.md`. L'idea è la descrizione del libro in `outline/book.md`, e non ce n'è un'altra. Sotto, una scheda per capitolo con il **Titolo ipotetico**, **Cosa succede** (testo semplice: gli eventi, le svolte, chi c'è; non prosa) e il **Ghostwriter**, dove la prima scelta è **Ghostwriter del libro (predefinito)**.

Ogni scheda dice a parole, con un'icona, cosa ne è stato: **Scritto dall'autopilot, non toccato**, **Tuo**, **Capitolo già scritto** (con il collegamento al capitolo), **Capitolo congelato**, **Capitolo approvato**, oppure **Cambiato dopo il piano: l'autopilot lo ripianificherà**. Un ghostwriter che non esiste, e un file che la Sinossi non riesce a leggere, sono segnalati sulla scheda.

I pulsanti di una scheda la spostano su o giù (anche con Alt+↑ e Alt+↓ dentro la scheda), inseriscono un capitolo prima o dopo, oppure la eliminano. Prima di eliminare la pagina chiede conferma: un capitolo già scritto tiene il suo testo nel libro e l'autopilot non lo cancella; **Rinumera i capitoli successivi** chiude il vuoto. **Aggiungi un capitolo in fondo** è in cima alla pagina. Dopo ogni azione **Annulla** la riporta indietro esattamente.

## Salvare

Quello che scrivi si salva quando scegli **Salva** sulla scheda, oppure **Salva tutto** (anche Ctrl+S) per tutto: fino ad allora la scheda dice **Modifiche non salvate**, e lasciare la pagina chiede conferma. Di proposito nulla si salva mentre scrivi: l'autopilot ripianifica un capitolo appena la sua voce cambia. Ogni salvataggio è un commit del libro, pubblicato come gli altri. Se nel frattempo la Sinossi è cambiata altrove (l'autopilot, il Copilot, un'altra scheda), il tuo testo resta e la pagina lo dice; **Ricarica la Sinossi** mostra la versione nuova e scarta quello che non avevi salvato.

## Libri lunghi

La pagina mostra 50 capitoli alla volta, con **Precedenti** e **Successivi**. **Filtra capitoli…** trova i capitoli per numero, titolo o cosa succede, e **Vai al capitolo** salta a uno. Una Sinossi di 5000 capitoli si apre veloce come una di dieci.

## Una Sinossi vuota

**Aggiungi il primo capitolo**, **Lascia che la scriva l'autopilot** (si apre la **Configurazione** dell'autopilot) oppure, quando il brief ha una trama capitolo per capitolo, **Converti la trama del brief**: le righe «Capitolo 1: …» diventano capitoli, il resto diventa l'idea del libro, e vedi tutto prima che venga scritto qualcosa.

## Cosa ne fa l'autopilot

L'autopilot segue la Sinossi come vincolante: gli stessi capitoli, nello stesso ordine, con i tuoi titoli e i tuoi eventi. Quando pianifica riempie i capitoli che non hanno ancora una voce, come suoi (**Scritto dall'autopilot, non toccato**), e non tocca mai le tue; appena cambi una voce che ha scritto lui, la voce è tua. Quando cambi la voce di un capitolo che non ha ancora scritto, lo ripianifica (**Ripianificazione del capitolo N** nella sua cronologia); quando ne elimini una, il capitolo esce dal piano e i capitoli successivi mantengono il loro numero (un capitolo già scritto resta nel libro e nel suo piano: l'autopilot ti dice soltanto, una volta sola, che la sua voce non c'è più). Quando cambi la voce di un capitolo che ha già scritto e chiuso, fa quello che dice la sua **Configurazione** per un capitolo congelato modificato: di norma ti chiede cosa fare: **Riscrivi il capitolo secondo la Sinossi**, **Tieni il testo, aggiorna solo la Sinossi** oppure **Segna come rivisto** (vedi *Capitoli congelati* nell'aiuto dell'autopilot). Un capitolo che ha tra le mani, in scrittura o in revisione, lo dice una volta sola e lo decide quando è chiuso. La scheda lo dice prima che tu salvi, e la pagina lo ripete dopo il salvataggio. Un capitolo prende il ghostwriter della sua voce; uno che non esiste viene segnalato, e lo scrive quello del libro. **Riempi la Sinossi con il piano**, nella **Configurazione** dell'autopilot (in **Il libro**), spegne il riempimento. La trama capitolo per capitolo del brief funziona ancora, e dove le due differiscono vince la Sinossi.

## L'assistente nelle aree di testo

Il menu di un'area di testo della Sinossi (clic destro, o il pulsante rotondo su uno schermo touch) offre **Migliora la voce**, **Riassumi la voce**, **Sviluppa questo capitolo** (eventi e punti chiave coerenti con la descrizione, i capitoli vicini e il canone) e **Controlla con il canone e i capitoli vicini** (ciò che non torna). Ognuna mostra prima la risposta: **Applica** la mette nella scheda come modifica non salvata, **Annulla** lascia la scheda com'era. Lì compaiono anche le tue azioni personalizzate per il libro.

## Parlarne al Copilot

Nella pagina Sinossi e nelle pagine dell'autopilot, «capitolo 3» è la voce 3 della Sinossi; in tutte le altre pagine del libro è il capitolo 3 scritto. «Sinossi» (o «scaletta», «outline») indica sempre la Sinossi, ovunque tu sia, e «il capitolo scritto» o «il testo del capitolo» indica sempre il capitolo. Quando non è chiaro, il Copilot chiede quale dei due. Le sue modifiche alla Sinossi sono una proposta: nulla viene scritto finché non scegli **Applica tutte le modifiche**, si applicano tutte insieme e si salvano come quelle della pagina (**Annulla modifiche dell'assistente** le riporta indietro), e ogni voce che scrive è tua.

## Brainstorming

**Brainstorming** è il Copilot potenziato per il grande disegno del libro: la premessa, gli archi, il ritmo, la posta in gioco, la struttura. Aprilo con **Brainstorming** in cima alla pagina Sinossi, o con il suo pulsante arancione accanto a quello del Copilot in basso a destra, che c'è finché la pagina è aperta. Lavora solo sulla Sinossi di questo libro: l'idea del libro e ogni voce dei capitoli, la descrizione del libro e il suo brief, i riassunti dei capitoli già scritti e se sono approvati, congelati o importati, e i nomi del canone (mai i segreti). Non scrive prosa, non tocca mai il testo di un capitolo e non ha nessuno degli altri strumenti del Copilot: legge una voce, il riassunto di un capitolo o una voce del canone quando gli servono, esegue il controllo di coerenza dell'intera Sinossi e propone modifiche.

Una chat vuota offre idee per cominciare, per **Iniziare il libro** (da una premessa alla Sinossi, il cuore della storia, tre modi di raccontarlo, gli archi dei personaggi) e per **Cambiare il libro** (e se…, ristrutturare, aggiungere una sottotrama, riordinare i capitoli, stringere il centro, controllare la Sinossi): ciascuna riempie la tua richiesta, che poi cambi e invii.

Una modifica della Sinossi è sempre una proposta: una serie di modifiche (capitoli nuovi, spostamenti, cambiamenti, eliminazioni) fatte come le fa la pagina Sinossi, con la differenza di ogni file e **Cosa farà l'autopilot** di ogni capitolo che tocca, con le parole della pagina: per un capitolo approvato chiede, lo riscrive o lo segnala soltanto, come dice la sua **Configurazione**, e uno non ancora scritto lo ripianifica. **Applica alla Sinossi** chiede ancora una volta; le modifiche vengono poi salvate insieme, come tue, e **Annulla** le riporta indietro. Quando lo chiedi, Brainstorming salva anche le decisioni di un brainstorming negli appunti del libro, `outline/brainstorm.md`, una sezione datata ogni volta: non sono voci, e l'autopilot non le segue.

Brainstorming tiene le sue chat per ogni libro: riaprirlo riporta l'ultima, e la sua **Cronologia** elenca solo le chat del libro. **Torna al Copilot** nella sua intestazione, il pulsante del Copilot o lasciare la pagina riportano il Copilot con la sua chat com'era. Funziona per un libro tenuto su questo dispositivo e senza GitHub, con le integrazioni AI del compito del Copilot, e cambia la Sinossi solo finché «Modifica la Sinossi» è attivo in **Impostazioni → Tools for Copilot**.
