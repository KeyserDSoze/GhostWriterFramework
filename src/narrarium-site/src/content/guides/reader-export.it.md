# Reader e pubblicazione

Il reader supporta font, dimensione, interlinea, margini, modalità a capo source/dialogue/book, immagini, link canonici ricchi, segnalibri e fullscreen.

Le pagine paragrafo si aprono in modalità reader e passano alla modifica con conferma salva/scarta.

## Annotazioni

Seleziona un passaggio nel reader e scegli **Annota**: nel menu del tasto destro (scrivi una nota e scegli un'etichetta, ed è salvata subito), con **⌥⌘A** su Mac o **Ctrl+Alt+M** altrove, con il pulsante Annota del reader, o sul telefono dalla barra sotto la selezione. Un'annotazione ha un'etichetta, una nota facoltativa e uno stato: aperta, più tardi, fatta o scartata.

Ci sono cinque etichette predefinite (Da riscrivere, Non mi piace, Incoerenza, Da espandere, Da tenere), le tue etichette per ogni libro in **Impostazioni › Etichette delle annotazioni**, e le etichette di un solo libro, create nel reader o nell'elenco di un capitolo. La descrizione di un'etichetta è anche l'istruzione per l'AI.

Un passaggio segnato mostra la sottolineatura, il colore e l'icona della sua etichetta; l'icona apre l'annotazione, e il reader può nascondere i segni. Quando una scena viene modificata, l'annotazione segue il suo passaggio, spostato o cambiato, e non viene mai persa: un passaggio che non è più nel testo ne conserva la citazione. I contatori dei capitoli e delle scene contano le annotazioni da rivedere (aperte o più tardi) e aprono l'elenco del capitolo, che le filtra per etichetta, stato e scena.

Le annotazioni sono file del libro (`annotations/`): ognuna è salvata su questo dispositivo come commit locale e pubblicata dalla sincronizzazione successiva, così funzionano offline e in un libro tenuto solo su questo dispositivo. Non sono mai pubblicate nel reader online, ma se il repository del libro su GitHub è pubblico chiunque può leggerle lì.

La pagina **Appunti** del libro (menu Libro › Appunti) elenca ogni nota per capitolo, nell'ordine del libro, dalla copia di lavoro. Filtra per capitolo, etichetta, stato e parole (i filtri stanno nell'indirizzo), e chiudi, metti da parte, scarta o elimina una nota o molte insieme. Su una nota, **Correggi con l'AI** chiede al modello un nuovo testo dei paragrafi che contengono il passaggio, mostra la modifica parola per parola, ti lascia tenere o saltare ogni parte e correggerla, e scrive la scena in un colpo solo quando applichi (si può annullare; la nota risulta allora sistemata «con l'AI»); **Ragioniamo insieme** è una chat su una nota, un capitolo o tutte le note che non cambia nulla. **Passali uno per uno** (anche nell'intestazione del reader) mostra una nota alla volta: **H** fatto, **L** più tardi, **D** scarta, **F** riprova con l'AI, **R** ragiona insieme, **P** apri il paragrafo, **S** salta; su un touch screen trascina a destra per fatto e a sinistra per più tardi. Ricorda su questo dispositivo le note che hai saltato, così puoi riprendere.

Su un libro scritto dall'autopilota, **Fai rispondere l'autopilota** (nella pagina Appunti, per le note mostrate o selezionate) gli chiede di riscrivere i passaggi delle note aperte, capitolo per capitolo nell'ordine del libro, come chiedono l'etichetta e le parole di ogni nota (una nota con l'etichetta Da tenere non è una modifica). Vedi quanto costa prima di confermare; il direttore e i lettori rivedono di nuovo ogni capitolo riscritto, e ogni nota a cui risponde viene chiusa come sistemata dall'autopilota, con ciò che ha fatto. I capitoli che hai scritto o congelato restano com'erano, a meno che tu non li spunti nella conferma. Su un server personale serve una versione che annuncia `autopilot-annotations`.

## Metadati editoriali

Le impostazioni libro scelgono quali valori frontmatter di libro, capitolo e paragrafo sono visibili. I valori mancanti vengono ignorati. Le stesse regole e il separatore tra paragrafi sono usati in reader, preview paragrafo, DOCX, PDF ed EPUB.

## Export

Gli export supportano Word, PDF, EPUB e submission package, libro completo o demo, immagini, tipografia, frontmatter tecnico, titoli paragrafo, summary capitolo, preset, download locale e upload Drive.
