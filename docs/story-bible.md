# The Story Bible: decisions, questions, threads and checks

The Bible tab of the Synopsis page composes everything the book has agreed, from its own files (the format is in `repository-spec.md`, «The Synopsis and the Story Bible»). This note says how the parts work together.

## Decisions and open questions (`bible/decisions.md`)

- Capture what you settle in the Bible (**Decisions**), or let Brainstorming propose it (`propose_bible_decisions`, the hook an agent calls to «capture this decision»: it proposes the file, you confirm, nothing is written before). A decision captured by an agent is always **open**.
- **Lock** a decision (the button is yours: no agent can press it, and `edit_bible` of the MCP endpoint captures open too). From then on:
  - the design run and the writing autopilot are told it in every request as your instruction, and a step whose result touches what it covers is not committed: it is repeated once with the reason, then the run stops and names the decision (open the decision again in the Bible, or change the request, and resume);
  - Brainstorming is told it, flags its own proposals that touch it, and the Copilot's apply asks you «apply it anyway, or leave it» instead of applying;
  - the Bible warns when the autopilot of the book runs on a personal server that does not announce `bible-decisions` (an older server writes without it).
- What a decision covers is what you say: `chapters` (the entry of these chapters in the Synopsis is held), `files`, `secrets`, and `avoid` (phrases the new text must not have). A decision with none of them still binds by words: it is in the instructions of every agent.
- **Open questions** are the story's still-unsettled points: the director's questions about the story, Brainstorming's and the Copilot's. You answer them (optionally recording the answer as a locked decision); the agents never settle them, and the autopilot closes its own question in the file when you have answered it in the autopilot.

## Threads of setup and payoff (`bible/threads.md`)

A thread is something the story plants and has to pay off: an object, a promise, a danger. Edit them in the Bible. A secret has its own clues and reveal in its file; a thread is everything else the reader is promised.

## What is shown

- **All the chapter designs**: a table of the 17 fields of every chapter, the gaps in the needed fields (goal, point of view, main events, ending) marked in words and in colour, with a search and filters (only the gaps, only the chapters missing one field, only those with a finding).
- **Timeline** and **Guidelines**: the events in the order of their dates with the chapter each is anchored to; the guidelines edited in place.
- **Checks**: findings with severity («Warning», «To look at») and chapter, filtered by severity. The **spoiler check on written text** reads the chapters already written when you ask, and lists the sentences that state a secret before its reveal. The design run gives the findings to the director; the director's review of a written chapter gets the spoiler check of that chapter as evidence.

## For tools

MCP (`/mcp` of a book on the personal server): `read_bible`, `read_design` (with `written` for the spoiler check) and `edit_bible`; `autopilot_resume` takes `design` and `designChapters`. `bible/` is not written with `write_file`.
