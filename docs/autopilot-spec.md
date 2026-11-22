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

- **In the browser**: each step is a local commit in the book's working copy; GitHub books are published as the author chose (every chapter unless chosen otherwise). Only one tab runs a book at a time; other tabs follow it live and can pause it, take a pause back, change the options that may change during a run, or send interventions.
- **On the personal server** (`npx narrarium-server`): the autopilot keeps working with the browser closed. GitHub books travel through GitHub (the server pushes after every step unless the author chose otherwise); local books are exchanged with a three-way file sync. The browser follows the server live.

### The Autopilot page

A control band stays at the top of the page and reads only what the engine already publishes: the status, the host and how long ago the run was last heard of (the newer of `summary.runner.heartbeatAt` and the last event the tab received), the step in progress with the text it streams (`live`), the progress (`summary.progress`), the phase, the steps of the chapter in progress (derived from the activity log and the review cycle: write, readers, specialists, director, fix) and the cost and token use against the budgets (`summary.stats`, `options.budgetLimit`, `options.budgetTokens`). Right under it come the things that wait for the author, each shown once: the director's question, the error, the problems of a profile file, a plan to approve. The rest of the page is the history, and the plan, the interventions, the rules, where it runs, the settings and a danger zone with **Reset** (which asks first). The layout follows the width of the page and not of the window: two columns when it is wide; four tabs (Overview, Timeline, Plan, Rules) when it is not, with the Plan open while the plan waits for the author; on a phone the quick commands move to a bar at the bottom. A finished book offers to add chapters and says how it went (the director's verdict on the whole book, the working time, the cost, the words); the working time is a minimum when the log of the last 200 steps no longer holds the first ones.

The mini-player of the web app (the Autopilot button next to Copilot) shows the state, the step in progress, the progress and the commands of one book, and in its "Live" tab one line for each of the latest events of every book. It keeps out of the way on the Autopilot pages, where the page shows all this, and keeps clear of the buttons and the fields of the assistant on a phone.

### Quick commands

The web app puts the commands the author reaches for most in one bar (the control band of the Autopilot page, which becomes a bar at the bottom of the screen on a phone; the "This book" tab of the mini-player; and its "Live" tab for the book in focus). They all go through the engine, once, so the browser and the server behave the same:

- **Pause** `now`, `after-step` or `after-chapter`, and **cancel** a pause that waits (`session.pause`, `session.cancelPause`; `summary.pausePending` says what waits).
- **Run one step or one chapter**: a start with `limits: { steps: 1 }` or `{ chapters: 1 }`, for that run only (`summary.limits`).
- **Publish** never, every chapter or every step: `options.publishEvery`, which `session.updateOptions` changes during a run (`summary.publish` says what is in force). A browser publishes from both hooks, `afterCommit` (every step) and `afterChapter`.
- **Where it runs**: a handover plan per book, an intention of the tab that made it. It asks the run to pause (after the step, or now), waits until it has ended, moves the book (`moveToServer` or `moveToBrowser`: the same consents and conflict handling as "Where it runs"), and starts the autopilot on the other side only if it was running; with a number of steps it runs that many there (`limits.steps`) and comes back. A move that cannot be made leaves the book stopped where it was, with the reason; a failure after the move (the start on the other side, the way back) does not move the book back, and the message says where it is. A handover never sends a secret: a server that lacks the AI configuration or the book's GitHub token sends the author to "Where it runs".
- **Older servers** that do not announce `autopilot-controls` ignore `limits` and take `after-chapter` and `cancel` for `after-step`, so the web app does not send those commands to them and says which version of the server has them.

### The personal server

- **Pairing and identity**: the browser pairs with a nine-digit code generated in the server's admin panel (`http://127.0.0.1:24243`) and approved there by the owner. Before sending its token, the browser asks the server to sign a fresh nonce with its Ed25519 key and compares the key's fingerprint with the one remembered at pairing.
- **Permissions**: each client token carries `read`, `write`, `run` and, only when the owner allows it, `update`.
- **Updates**: a client with `update` (or the admin panel) can ask the supervisor to install the latest npm release. The supervisor installs it only when it carries the npm registry signature and the provenance attestation of this repository's publishing workflow, and only when no autopilot is running. A failed installation keeps the previous version.
- **Network**: the server listens on `127.0.0.1` only and calls only the AI endpoints approved by its owner. Remote access goes through HTTPS, for example the Cloudflare connector managed from the admin panel.

See the [`narrarium-server` README](../packages/server/README.md) for commands, data folders and the release procedure.

## AI router tasks

The autopilot uses the router tasks **Autopilot** (writing), **Director**, **Reader evaluation**, **Reader evaluation summary**, **Review** (specialists) and **Simple tasks**. Tasks without a route fall back to models tagged `default`. For long scenes, set the context window and the max output tokens of the models.
