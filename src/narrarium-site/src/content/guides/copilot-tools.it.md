# Copilot, Fantasmino e tool

Copilot e assistente vocale condividono lo stesso motore di orchestrazione. Cambia soltanto il canale input/output.

## Tool Registry

I tool sono scopribili e configurabili singolarmente in **Impostazioni → Tools**. L'orchestrator preferisce tool locali/senza LLM quando possibile e usa il Router solo quando servono generazione o ragionamento.

Le capability includono creazione e modifica, ricerca, navigazione, lettura vocale, canone, research, note, branch/diff/commit/PR Git, valutazioni, Reader Persona ed export.

## Chat

La chat renderizza Markdown, mostra in streaming le risposte conversazionali, supporta invio con Shift+Invio, copia formattata/Markdown, salvataggio in nota e download o upload Drive in PDF/Markdown.

Un testo lungo che incolli (una sinossi, un'analisi, un capitolo) è materiale da leggere, non la tua richiesta: quello che chiedi è la riga che scrivi prima o dopo, e le parole del testo non la decidono mai, quindi a una richiesta che non è chiaramente un rifiuto risponde sempre il modello, che legge il testo come dati. **Usa questo testo come materiale**, sotto la casella quando un testo è lungo, lo mette da parte come allegato con un clic e lascia nella casella solo la riga che chiede. Quando una richiesta ha dovuto essere tagliata per stare nella finestra di contesto di un modello, la risposta lo dice, quanto è stato inviato e dove impostare la finestra; un testo messo da parte come materiale non viene mai tagliato dai limiti degli allegati, e quando questi tagliano il testo dei file allegati, la risposta dice quanto è stato letto.

## La pagina su cui sei

Su alcune pagine il Copilot lavora prima sulla pagina: la riga sopra il campo di scrittura dice quale («Sto lavorando su: Lettori simulati»). Vede ciò che la pagina mostra, non solo dove sei: in **Lettori simulati**, ogni lettore del libro (anche quelli predefiniti) con il suo stato acceso o spento, il tipo, la severità e i generi che preferisce, e il filtro e il lettore che hai aperto. Le pagine che funzionano così sono **Lettori simulati**, **Ghostwriter**, **Direttore**, **Stile di valutazione**, la **Configurazione** dell'autopilot, **Asset**, e la pagina di un personaggio, un luogo, una fazione o un oggetto. Una richiesta che può riguardare la pagina riguarda la pagina; tutto il resto che il Copilot sa fare resta disponibile su ogni pagina, compresi i tool delle altre pagine.

Quando il modello della rotta del Copilot sa chiamare i tool, sceglie da sé i suoi tool, prima quelli della pagina, in un breve ciclo: legge ciò che gli serve, ti risponde o propone una modifica; un tool del catalogo si esegue con le tue parole. Un modello segnato come senza chiamate di tool in **Integrazioni AI** è aiutato dalle regole a parole chiave, come prima, con prima la regola della pagina.

## Modificare i lettori simulati

In **Lettori simulati** chiedi con parole tue, in italiano o in inglese: «creami solo lettori storici, di diverso tipo, e leva tutti i lettori di default», «rendi più severo il lettore critico», «accendi il lettore mystery». Il Copilot propone un unico insieme di modifiche: lettori creati (anche più d'uno alla volta, scritti da una sola chiamata del modello, ciascuno di un tipo diverso), modificati, accesi o spenti, e rimossi. **I lettori predefiniti non si cancellano mai**: rimuoverne uno lo spegne. Prima che venga scritto qualcosa vedi una tabella di ogni lettore con com'è ora, come sarà e cosa cambia, prima le modifiche. **Applica** scrive tutto in una sola modifica del libro (su un libro su GitHub viene pubblicata subito quando GitHub è raggiungibile, come ogni modifica che applichi dal Copilot; altrimenti è salvata su questo dispositivo e la prossima sincronizzazione la pubblica); **Scarta** la lascia cadere; dopo averla applicata, **Annulla** rimette ciò che c'era. La pagina mostra i nuovi lettori appena la modifica è applicata. **Modifica questa pagina** in **Impostazioni → Tools** attiva o disattiva questa modifica.

## Modificare le altre pagine

Le altre pagine funzionano allo stesso modo: una sola proposta, una tabella di tutto con il suo stato finale, **Applica**, **Scarta** e **Annulla**, e la pagina mostra la modifica appena è applicata (un profilo che stai modificando non viene sostituito: la pagina ti avvisa che è cambiato).

- **Ghostwriter**: ghostwriter creati, modificati (tono, voce, punto di vista, tempo, ritmo, dialoghi, vocabolario, stile, influenze, punti di forza, cosa evitare, temperatura, istruzioni di stile) e rimossi. Il ghostwriter predefinito del libro, e l'ultimo, non si rimuovono mai.
- **Direttore**: i suoi campi, ciascuno com'è ora e come sarà (autonomia, severità, voto di approvazione, giri di revisione, priorità, gusto, linee rosse, il peso di ogni lettore, la visione). Un direttore che il libro non ha ancora salvato parte da quello predefinito.
- **Stile di valutazione**: criteri aggiunti, riformulati e rimossi, e il metodo e la severità.
- **Un personaggio, un luogo, una fazione o un oggetto**: i dati del suo tipo e la sua descrizione, campo per campo. Il Copilot non vede né scrive mai ciò che rimanda a un segreto o le tue note private (`secret_refs`, `private_notes`, `reveal_in`, `known_from`), non rinomina mai la voce, e i segreti e la timeline non ne fanno parte.

Nella **Configurazione** dell'autopilot il Copilot vede le impostazioni e il brief della Sinossi e ti dice cosa cambiare e in quale scheda: la configurazione si salva lì, tramite l'autopilot. In **Asset** vede quali immagini sono fatte e quali mancano, e il filtro che hai scelto; un'immagine si crea con l'azione della sua scheda, che mostra il prompt e chiede prima di spendere.
