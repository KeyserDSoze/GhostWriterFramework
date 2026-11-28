/**
 * One short line for each tool of a book's MCP, for a person reading the public /mcp page (not the long description a model reads, which the server keeps).
 * The key is the name of the tool. Bundled with that page (see `@/i18n/mcpBookPage`): the app entry does not carry it. A tool that the server adds
 * needs its line here and in `mcpBookTools.it.ts`: `test/mcpBookToolsTexts.test.mjs` fails until it has them.
 */
const mcpBookToolsEn = {
  mcpBookTools: {
    book_info: "Title, language, counts, the autopilot in a few words, and what this assistant may do.",
    list_chapters: "The chapters in order, a page at a time.",
    read_chapter: "A chapter's details and scenes, and on request its prose, a page at a time.",
    read_paragraph: "One scene: its details and its text, a page at a time.",
    search_book: "Words or a “phrase” in scenes, chapters and canon, ranked, with an excerpt (secrets only when asked).",
    list_canon: "Characters, locations, factions, items, secrets and events: a secret by its name, never by what it says.",
    read_canon_entry: "One canon entry, found by its slug, name or alias.",
    list_files: "The book's own text files, and whether each one can be changed.",
    read_file: "One of the book's text files (notes, plot, guidelines…), a page at a time.",
    autopilot_status: "What the autopilot is doing: its question, pause, failed step, rules and last error.",
    read_outline: "The Synopsis: its description and its entries, a page at a time, with who wrote each.",
    read_outline_entry: "One Synopsis entry whole, with whether its chapter is already written or frozen.",
    read_bible: "What the book has agreed: decisions (locked ones bind), questions, threads, timeline, tone and rules.",
    read_design: "The design of every chapter with its gaps, and what the checks find in it.",
    create_chapter: "Adds a chapter: title, summary, point of view and ghostwriter.",
    update_chapter: "Changes a chapter's title, summary, point of view, ghostwriter or text.",
    create_paragraph: "Adds a scene to a chapter.",
    update_paragraph: "Replaces one passage of a scene, or all its text, or changes its details.",
    create_canon_entry: "Adds a character, location, faction, item, secret or event.",
    update_canon_entry: "Changes the name, the fields or the text of a canon entry.",
    write_file: "Writes another text file of the book (notes, plot, guidelines…), but never the Synopsis.",
    edit_outline: "Edits the Synopsis: up to 50 changes (add, insert, move, remove, update) saved as one commit.",
    edit_bible: "Captures decisions (never locked) and questions, edits threads, tone and rules in one commit.",
    autopilot_pause: "Pauses the autopilot after the step, after the chapter or now, or takes a waiting pause back.",
    autopilot_retry_now: "Ends the wait before a failed step is tried again, as the app's Retry now does.",
    autopilot_resume: "Resumes an autopilot you set up in the app, or designs the book; it never starts a book from nothing.",
    autopilot_note: "Gives the autopilot a note for the next step, or a permanent rule.",
    autopilot_answer: "Answers the question the autopilot is waiting on.",
  },
};

export default mcpBookToolsEn;
