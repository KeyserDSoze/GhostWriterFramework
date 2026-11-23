# The Outline (Scaletta)

The Outline is the plan of the book, chapter by chapter: a rough description of the book and, for every chapter, a hypothetical title, what happens in it and, when it is not the book's, the ghostwriter that writes it. Open it from the book's menu (**Outline**). It lives in the files of the book (`outline/book.md` and one `outline/chapters/<NNN>.md` per chapter), so it travels with the book like everything else.

## The page

At the top, **The book**: a working title (optional: the book's own title stays in its settings) and the **Rough description of the book**. Below, one card per chapter with its **Hypothetical title**, **What happens** (plain text: the events, the turning points, who is there; not prose) and its **Ghostwriter**, where **The book's ghostwriter (default)** is the first choice.

Every card says in words, with an icon, what became of it: **Written by the autopilot, untouched**, **Yours**, **Chapter already written** (a link to the chapter), **Frozen chapter**, **Chapter approved**, or **Changed after the plan: the autopilot will plan it again**. A ghostwriter that does not exist, and a file the Outline cannot read, are said on the card.

The buttons of a card move it up or down (also with Alt+↑ and Alt+↓ inside the card), insert a chapter before or after it, or delete it. Deleting asks first: a chapter already written keeps its text in the book, and the autopilot does not delete it; **Renumber the following chapters** closes the gap. **Add a chapter at the end** is at the top of the page. After every action **Undo** takes it back exactly.

## Saving

What you type is saved when you choose **Save** on the card, or **Save all** (also Ctrl+S) for everything: until then the card says **Unsaved changes**, and leaving the page asks first. Nothing is saved while you type, on purpose: the autopilot plans a chapter again as soon as its entry changes. Every save is a commit of the book, published like the others. If the Outline changed elsewhere meanwhile (the autopilot, the Copilot, another tab), your text is kept and the page says so; **Reload the outline** shows the new version and discards what you had not saved.

## Long books

The page shows 50 chapters at a time, with **Previous** and **Next**. **Filter chapters…** finds chapters by number, title or what happens, and **Go to chapter** jumps to one. An Outline of 5000 chapters opens as fast as one of ten.

## An empty Outline

**Add the first chapter**, **Let the autopilot write it** (the autopilot's **Configuration** opens), or, when the brief has a chapter-by-chapter synopsis, **Convert the brief's synopsis**: the lines «Chapter 1: …» become chapters, the rest becomes the description, and you see everything before anything is written.

## What the autopilot does with it

The autopilot follows the Outline as binding: the same chapters, in the same order, with your titles and your events. When it plans, it fills the chapters that have no entry yet, as its own (**Written by the autopilot, untouched**), and never touches yours; as soon as you change an entry it wrote, the entry is yours. When you change the entry of a chapter it has not written yet, it plans that chapter again (**Replanning chapter N** in its history); when you delete one, the chapter leaves its plan and the following chapters keep their numbers (a chapter already written stays in the book and in its plan: the autopilot only tells you, once, that its entry is gone). When you change the entry of a chapter it has already written and closed, it does what its **Configuration** says for a changed frozen chapter: by default it asks you what to do: **Rewrite the chapter to follow the Outline**, **Keep the text, update only the Outline** or **Mark as reviewed** (see *Frozen chapters* in the autopilot's help). A chapter it has in its hands, being written or revised, is told once and decided when it is closed. The card says so before you save, and the page says it again once saved. A chapter takes the ghostwriter of its entry; one that does not exist is said, and the book's writes it. **Fill the Outline with the plan**, in the autopilot's **Configuration** (under **The book**), turns the filling off. The chapter-by-chapter synopsis of the brief still works, and where the two differ the Outline wins.

## The assistant in the text areas

The menu of a text area of the Outline (right click, or the round button on a touch screen) offers **Improve the entry**, **Summarize the entry**, **Develop this chapter** (events and key points consistent with the description, the nearby chapters and the canon) and **Check against the canon and the nearby chapters** (what does not hold). Each shows its answer first: **Apply** puts it in the card as an unsaved change, **Cancel** leaves the card as it was. Your custom actions for the book appear there too.

## Talking to the Copilot about it

On the Outline page and on the autopilot's pages, «chapter 3» means entry 3 of the Outline; on every other page of the book it means the written chapter 3. «Outline» or «scaletta» always means the Outline, wherever you are, and «the written chapter» or «the chapter's text» always means the chapter. When it is not clear, the Copilot asks which one. Its changes to the Outline are a proposal: nothing is written until you choose **Apply all file updates**, they are applied together and saved like the page's saves (**Undo assistant changes** takes them back), and every entry it writes is yours.
