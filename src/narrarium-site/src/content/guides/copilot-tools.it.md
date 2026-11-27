# Copilot, Fantasmino e tool

Copilot e assistente vocale condividono lo stesso motore di orchestrazione. Cambia soltanto il canale input/output.

## Tool Registry

I tool sono scopribili e configurabili singolarmente in **Impostazioni → Tools**. L'orchestrator preferisce tool locali/senza LLM quando possibile e usa il Router solo quando servono generazione o ragionamento.

Le capability includono creazione e modifica, ricerca, navigazione, lettura vocale, canone, research, note, branch/diff/commit/PR Git, valutazioni, Reader Persona ed export.

## Chat

La chat renderizza Markdown, mostra in streaming le risposte conversazionali, supporta invio con Shift+Invio, copia formattata/Markdown, salvataggio in nota e download o upload Drive in PDF/Markdown.

## La pagina su cui sei

Su alcune pagine il Copilot lavora prima sulla pagina: la riga sopra il campo di scrittura dice quale («Sto lavorando su: Lettori simulati»). Vede ciò che la pagina mostra, non solo dove sei: in **Lettori simulati**, ogni lettore del libro (anche quelli predefiniti) con il suo stato acceso o spento, il tipo, la severità e i generi che preferisce, e il filtro e il lettore che hai aperto. Una richiesta che può riguardare la pagina riguarda la pagina; tutto il resto che il Copilot sa fare resta disponibile su ogni pagina.

Quando il modello della rotta del Copilot sa chiamare i tool, sceglie da sé i suoi tool, prima quelli della pagina, in un breve ciclo: legge ciò che gli serve, ti risponde o propone una modifica; un tool del catalogo si esegue con le tue parole. Un modello segnato come senza chiamate di tool in **Integrazioni AI** è aiutato dalle regole a parole chiave, come prima, con prima la regola della pagina.

## Modificare i lettori simulati

In **Lettori simulati** chiedi con parole tue, in italiano o in inglese: «creami solo lettori storici, di diverso tipo, e leva tutti i lettori di default», «rendi più severo il lettore critico», «accendi il lettore mystery». Il Copilot propone un unico insieme di modifiche: lettori creati (anche più d'uno alla volta, scritti da una sola chiamata del modello, ciascuno di un tipo diverso), modificati, accesi o spenti, e rimossi. **I lettori predefiniti non si cancellano mai**: rimuoverne uno lo spegne. Prima che venga scritto qualcosa vedi una tabella di ogni lettore con com'è ora, come sarà e cosa cambia, prima le modifiche. **Applica** scrive tutto in una sola modifica del libro (su un libro su GitHub viene pubblicata subito quando GitHub è raggiungibile, come ogni modifica che applichi dal Copilot; altrimenti è salvata su questo dispositivo e la prossima sincronizzazione la pubblica); **Scarta** la lascia cadere; dopo averla applicata, **Annulla** rimette ciò che c'era. La pagina mostra i nuovi lettori appena la modifica è applicata. **Modifica questa pagina** in **Impostazioni → Tools** attiva o disattiva questa modifica.
