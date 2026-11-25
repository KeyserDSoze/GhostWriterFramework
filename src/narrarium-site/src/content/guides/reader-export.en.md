# Reader and publishing

The reader supports font family, size, line height, margins, source/dialogue/book line-break modes, images, rich canon links, bookmarks and fullscreen reading.

Paragraph pages open in reader mode and switch to editing with save/discard confirmation.

## Annotations

Select a passage in the reader and choose **Annotate**: in the right-click menu (write a note and pick a tag, and it is saved at once), with **⌥⌘A** on a Mac or **Ctrl+Alt+M** elsewhere, with the Annotate button of the reader, or on a phone from the toolbar under the selection. An annotation has a tag, an optional note and a status: open, later, handled or dismissed.

There are five built-in tags (To rewrite, Don't like it, Inconsistency, To expand, Keep it), your tags for every book in **Settings › Annotation tags**, and the tags of one book, made in the reader or in the list of a chapter. A tag's description is also the instruction for the AI.

A marked passage shows the underline, the colour and the icon of its tag; the icon opens the annotation, and the reader can hide the marks. When a scene is edited, the annotation follows its passage, moved or changed, and is never dropped: a passage that is no longer in the text keeps its quote. The badges of the chapters and scenes count the annotations to review (open or later) and open the list of the chapter, which filters them by tag, status and scene.

Annotations are files of the book (`annotations/`): each one is saved on this device as a local commit and published by the next sync, so they work offline and in a book kept only on this device. They are never published in the online reader, but if the book's repository on GitHub is public, anyone can read them there.

## Editorial metadata

Book Settings choose which book, chapter and paragraph frontmatter values are visible. Missing values are skipped. The same presentation rules and paragraph separator are applied to reader, paragraph preview, DOCX, PDF and EPUB.

## Export

Exports support Word, PDF, EPUB and submission packages, full book or sample scope, images, typography, frontmatter debug output, paragraph titles, chapter summaries, presets, local download and Drive upload.
