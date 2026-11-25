# Reader e pubblicazione

Il reader supporta font, dimensione, interlinea, margini, modalità a capo source/dialogue/book, immagini, link canonici ricchi, segnalibri e fullscreen.

Le pagine paragrafo si aprono in modalità reader e passano alla modifica con conferma salva/scarta.

## Annotazioni

Seleziona un passaggio nel reader e scegli **Annota**: nel menu del tasto destro (scrivi una nota e scegli un'etichetta, ed è salvata subito), con **⌥⌘A** su Mac o **Ctrl+Alt+M** altrove, con il pulsante Annota del reader, o sul telefono dalla barra sotto la selezione. Un'annotazione ha un'etichetta, una nota facoltativa e uno stato: aperta, più tardi, fatta o scartata.

Ci sono cinque etichette predefinite (Da riscrivere, Non mi piace, Incoerenza, Da espandere, Da tenere), le tue etichette per ogni libro in **Impostazioni › Etichette delle annotazioni**, e le etichette di un solo libro, create nel reader o nell'elenco di un capitolo. La descrizione di un'etichetta è anche l'istruzione per l'AI.

Un passaggio segnato mostra la sottolineatura, il colore e l'icona della sua etichetta; l'icona apre l'annotazione, e il reader può nascondere i segni. Quando una scena viene modificata, l'annotazione segue il suo passaggio, spostato o cambiato, e non viene mai persa: un passaggio che non è più nel testo ne conserva la citazione. I contatori dei capitoli e delle scene contano le annotazioni da rivedere (aperte o più tardi) e aprono l'elenco del capitolo, che le filtra per etichetta, stato e scena.

Le annotazioni sono file del libro (`annotations/`): ognuna è salvata su questo dispositivo come commit locale e pubblicata dalla sincronizzazione successiva, così funzionano offline e in un libro tenuto solo su questo dispositivo. Non sono mai pubblicate nel reader online, ma se il repository del libro su GitHub è pubblico chiunque può leggerle lì.

## Metadati editoriali

Le impostazioni libro scelgono quali valori frontmatter di libro, capitolo e paragrafo sono visibili. I valori mancanti vengono ignorati. Le stesse regole e il separatore tra paragrafi sono usati in reader, preview paragrafo, DOCX, PDF ed EPUB.

## Export

Gli export supportano Word, PDF, EPUB e submission package, libro completo o demo, immagini, tipografia, frontmatter tecnico, titoli paragrafo, summary capitolo, preset, download locale e upload Drive.
