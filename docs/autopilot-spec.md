# Autopilot and Director Spec

Narrarium can write a book on autopilot while the author keeps the final word. The same engine ([`narrarium-engine`](../packages/engine/README.md)) runs in the web app and in the personal server ([`narrarium-server`](../packages/server/README.md)), so the book files, the decisions and the live events are identical wherever it runs.

## Roles

- **Architect and ghostwriter** — design the concept and the plan, then write scene by scene following the selected ghostwriter profile.
- **Simulated readers** — read each finished chapter *blind*: no canon, no secrets, no plan. They write the same reader evaluations as the Reader evaluations page, then a panel summary.
- **Specialists** — check continuity, canon, secrets and reveal timing, timeline, character voice, style and pacing. Every finding must quote the text.
- **Director** — the author's stand-in. It approves or corrects the plan, decides on every finding (accept with a precise fix, or reject with a reason), scores the chapter and carries standing guidance forward. The software, not the model, turns accepted findings into repairs. When its autonomy allows it, the director asks the author instead of deciding a critical matter.

## Pipeline

1. Concept: story design, world context, characters, locations, factions, secrets with their reveal chapter.
2. Plan: chapters; simulated readers react to the pitch and the plan; the director approves or asks for changes. By default the autopilot pauses here so the author can read the plan.
3. For every chapter: scene plan → prose → readers → specialists → director → repairs → verification round (up to the director's limit) → consolidation (chapter summary, recap, story so far, `plot.md`).
4. Final: the director's judgement on the whole book.

A book that already has chapters is continued after the last one; chapters written by the author are never rewritten unless the author asks.

## Author interventions

| Scope | Effect |
|---|---|
| Next step only | Delivered once to the next writing step, then marked as applied. |
| From now on | A permanent rule for every following step, the director included. |
| Revise what is already written | The director picks the scenes that must change; they are rewritten and reviewed again. |

An intervention can interrupt the running step, which is then repeated with it. The author's instructions always win over the director's taste.

## Asking the director

On any book, chapter or scene page, **Ask the director** returns a structured opinion: verdict, score, strengths, concerns with quoted evidence, decisions, next steps and, when asked, a direct answer. Opinions can be kept in the book.

## Files

| Path | Content |
|---|---|
| `director.md` | Director profile: `type: director`, `name`, `persona`, `autonomy` (`full`, `ask-on-critical`, `ask-always`), `strictness`, `approval_score`, `max_review_rounds`, `priorities`, `taste`, `red_lines`, `reader_weights`, and the vision in the body. |
| `autopilot/state.json` | Brief, options, plan, current review cycle, author rules and interventions, director guidance, statistics. |
| `autopilot/activity.json` | The last 200 steps: what, why, next, result, model, tokens and cost. |
| `autopilot/plan.md` | Human-readable mirror of the plan. |
| `evaluations/director/` | Director opinions (`type: director-opinion`) for the book, chapters and paragraphs. |
| `evaluations/readers/` | Simulated reader evaluations and panel summaries. |

Chapters, paragraphs, canon entries, resumes and `plot.md` use the normal Narrarium formats and pass `validate_book`/`doctor_book`. Run `sync_plot`, `sync_all_resumes` and `sync_story_state` to regenerate the deterministic maintenance files after an autopilot session.

## Where it runs

- **In the browser**: each step is a local commit in the book's working copy; GitHub books are published after every approved chapter. Only one tab runs a book at a time; other tabs follow it live and can pause it or send interventions.
- **On the personal server** (`npx narrarium-server`): the autopilot keeps working with the browser closed. GitHub books travel through GitHub (the server pushes every step); local books are exchanged with a three-way file sync. The browser follows the server live.

## AI router tasks

The autopilot uses the router tasks **Autopilot** (writing), **Director**, **Reader evaluation**, **Reader evaluation summary**, **Review** (specialists) and **Simple tasks**. Tasks without a route fall back to models tagged `default`. For long scenes, set the context window and the max output tokens of the models.
