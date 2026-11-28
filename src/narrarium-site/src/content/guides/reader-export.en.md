# Reader and publishing

The reader supports font family, size, line height, margins, source/dialogue/book line-break modes, images, rich canon links, bookmarks and fullscreen reading.

Paragraph pages open in reader mode and switch to editing with save/discard confirmation.

## Annotations

Select a passage in the reader and choose **Annotate**: in the right-click menu (write a note and pick a tag, and it is saved at once), with **⌥⌘A** on a Mac or **Ctrl+Alt+M** elsewhere, with the Annotate button of the reader, or on a phone from the toolbar under the selection. An annotation has a tag, an optional note and a status: open, later, handled or dismissed.

There are five built-in tags (To rewrite, Don't like it, Inconsistency, To expand, Keep it), your tags for every book in **Settings › Annotation tags**, and the tags of one book, made in the reader or in the list of a chapter. A tag's description is also the instruction for the AI.

A marked passage shows the underline, the colour and the icon of its tag; the icon opens the annotation, and the reader can hide the marks. When a scene is edited, the annotation follows its passage, moved or changed, and is never dropped: a passage that is no longer in the text keeps its quote. The badges of the chapters and scenes count the annotations to review (open or later) and open the list of the chapter, which filters them by tag, status and scene.

Annotations are files of the book (`annotations/`): each one is saved on this device as a local commit and published by the next sync, so they work offline and in a book kept only on this device. They are never published in the online reader, but if the book's repository on GitHub is public, anyone can read them there.

The **Annotations** page of the book (menu Book › Annotations; «Appunti» in Italian) lists every note by chapter in the order of the book, from the working copy. Filter by chapter, tag, status and words (the filters are in the address), and close, put off, dismiss or delete one note or many at once. On a note, **Fix with the AI** asks the model for a new text of the paragraphs that hold the passage, shows the change word by word, lets you keep or skip each part and edit it, and writes the scene in one go when you apply (it can be undone; the note is then handled "with the AI"); **Let's reason together** is a chat about a note, a chapter or all the notes that changes nothing. **Go through them one by one** (also in the reader's header) shows one note at a time: **H** handled, **L** later, **D** dismiss, **F** retry with the AI, **R** reason together, **P** open the paragraph, **S** skip; on a touch screen swipe right for handled and left for later. It remembers the notes you skipped on this device, so you can resume.

On a book the autopilot wrote, **Have the autopilot answer** (on the Annotations page, for the notes shown or selected) asks it to rewrite the passages of the open notes, chapter by chapter in the order of the book, as each note's tag and words ask (a note tagged Keep it is not a change). You see what it costs before you confirm; the director and the readers review each rewritten chapter again, and every note it answered is closed as handled by the autopilot, with what it did. Chapters you wrote or froze are left alone unless you tick them in the confirmation. On a personal server this needs a version that announces `autopilot-annotations`.

## Editorial metadata

Book Settings choose which book, chapter and paragraph frontmatter values are visible. Missing values are skipped. The same presentation rules and paragraph separator are applied to reader, paragraph preview, DOCX, PDF and EPUB.

## Export

Exports support Word, PDF, EPUB and submission packages, full book or sample scope, images, typography, frontmatter debug output, paragraph titles, chapter summaries, presets, local download and Drive upload.
