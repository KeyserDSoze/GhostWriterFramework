# Wildcards Spec (Fuori dal coro)

The wildcards are a writers' room next to the Director, the Ghostwriters and the simulated Readers: voices that propose and check, never with a score.

The readers **judge**: they simulate the audience and give a score that the autopilot follows. The wildcards **propose and check**: they give ideas and findings, never a score, and nothing they say is applied by itself. The Director triages what they give in the autopilot (adopted, adapted or rejected, always with the reason), the author decides in a review table (accept or skip, one apply), and the ghostwriters use what was accepted as material.

The room lives once in [`narrarium-engine`](../packages/engine/README.md) (`profiles/wildcards.ts` and `wildcards/`): the web app and the personal server call the same code.

## Two groups, fourteen built-in voices

Every wildcard has a name, a mandate, a temperament, an **audacity** from 1 (prudent) to 10 (reckless), a **respect for the canon** (`faithful`: proposes inside what exists; `flexible`: bends it and says what changes; `subversive`: may propose to change it) and an **output format** (`ideas`, `objections`, `questions`, `constraints`, `findings`). The built-in ones exist in English and Italian, in the language of the book.

**Provocateurs** (ideas)

| Slug | Name | Audacity | Canon | Gives |
|---|---|---|---|---|
| `subversive` | The Subversive | 9 | subversive | ideas: inverts premises, point of view, roles |
| `devils-advocate` | The Devil's Advocate | 6 | faithful | objections: the strongest one for each choice, and the pre-mortem (why the book will fail) |
| `cliche-hunter` | The Cliché Hunter | 6 | flexible | ideas: what the reader already predicted, and the unexpected alternative |
| `twist-engineer` | The Twist Engineer | 7 | flexible | ideas: reversals, misdirection, fair clues |
| `genre-guest` | The Genre Guest | 7 | flexible | ideas: what a noir, horror or comic author would do here (`domain` names the guest genres) |
| `naive` | The Naive | 3 | faithful | questions: the obvious «why?» that shows the holes |
| `antagonist` | The Antagonist | 7 | flexible | ideas: thinks as the villain and the secondary characters, gives each an agenda |
| `chaos-maker` | The Chaos Maker | 10 | subversive | constraints: oblique strategies («without dialogue», «from the object's point of view») |
| `poet` | The Poet | 6 | faithful | ideas: non-obvious images, sensory detail, voice experiments |

**Sentinels** (checks, always `findings`)

| Slug | Name | Audacity | Canon | Checks |
|---|---|---|---|---|
| `ledger-keeper` | The Ledger Keeper | 2 | faithful | setups and payoffs: every promise and Chekhov's gun gets its resolution |
| `continuity-keeper` | The Continuity Keeper | 1 | faithful | timeline, logic of events, behaviour of the characters |
| `secrets-guardian` | The Secrets Guardian | 1 | faithful | involuntary spoilers and impossible knowledge, with the secrets and their thresholds |
| `domain-expert` | The Domain Expert | 3 | faithful | technical plausibility from the domain the author sets (a robotics engineer, a lawyer, a historian) |
| `moral-stress-test` | The Moral Stress-Test | 5 | flexible | dilemmas and themes: does each choice cost what it should |

Three **presets** pick the voices of a consultation: *Creative room* (Subversive, Cliché Hunter, Twist Engineer, Poet), *Pre-mortem* (Devil's Advocate, Naive, Antagonist, Ledger Keeper) and *Narrative quality check* (Ledger Keeper, Continuity Keeper, Secrets Guardian, Domain Expert). A consultation asks 4 voices by default and 8 at most.

## The file of a wildcard

A wildcard is a Markdown file: the frontmatter says who it is, the body is the prompt of the persona.

```md
---
type: wildcard
id: wildcard:custom:hacker
name: The Hacker
group: provocateur
mandate: Finds the exploit in every plot: the door nobody locked, the system everybody trusts.
temperament: Laconic, nocturnal, allergic to hand-waving.
audacity: 8
canon_respect: subversive
output_format: ideas
domain: computer security
secrets: threshold
language: en
enabled: true
order: 1000
builtin: false
version: 1
---

Think like an attacker: where would you get in, what would you steal, whom would you fool?
```

- `group`: `provocateur` or `sentinel`. `canon_respect`: `faithful`, `flexible`, `subversive`. `output_format`: `ideas`, `objections`, `questions`, `constraints`, `findings`. `audacity`: 1 to 10. Keys of two words are written in snake case; the camel case spelling (`canonRespect`, `outputFormat`) is read too.
- `secrets`: `threshold` (the default: the voice knows only the secrets the material may know) or `author` (the secrets as the author knows them). Only a **sentinel** may have `author`; a provocateur that says it is read with `threshold`, and the file gets a warning.
- `id`: `wildcard:<slug>` for a built-in one (a file with that id changes it), `wildcard:custom:<…>` for one of the author's own.
- `version`: the version of the format (1). A key this version does not know is kept and written back as it was; a value it cannot read (a group that is none of the known ones, an audacity that is not a number, YAML that cannot be read) is a warning that names the file, and the value is the default. A file with a warning is never asked.

## Where the wildcards live

- **Built-in**: in the engine, in English and Italian. A book does not get files for them.
- **The author's account** (all their books): the same text as a book file, kept with the account's settings and synchronised with them. The personal server never receives the account's data, so the autopilot (in the web app and on the server alike) uses the room of the book: to use one of your own wildcards there, copy it into the book.
- **The book**: `wildcards/<slug>.md`. A file whose `id` is a built-in one changes it (turn it off, give the Domain Expert a domain); any other is one of the author's own.

The layers are merged in this order, each one changing a wildcard of the layers before it by its `id`: built-in, then the account, then the book. A wildcard file can be exported (the `.md` file) and imported, into the book or into the account.

## In the web app

- **The Wildcards page** (the book's menu, *Profiles*) lists every wildcard with its group, where it comes from (built-in, the account, the book) and its switch, and edits all of it. *Where your changes go* chooses the layer a change is saved in: **This book** (`wildcards/<slug>.md`, what the autopilot uses too) or **All my books** (the account's settings, `settings.wildcards`: the text of each file with when it changed, and a tombstone for a deleted one, so that two devices' copies are merged wildcard by wildcard). *Restore default* removes the layer's change of a built-in wildcard; *Copy to this book* and *Copy to all my books* move a wildcard between the two. *Export* downloads the file (`<slug>.wildcard.md`), *Import* adds files (64 KB at most each) where changes go.
- **The page-aware Copilot** sees every wildcard on the page and proposes one batch (`propose_wildcard_changes`): wildcards created in one call of the model («create a provocateur who thinks like a hacker»), edited, turned on or off and removed. The batch changes the book's room: a built-in or account wildcard gets a file of its own in the book, and removing it turns it off there; only the book's own wildcards are deleted. The author sees every wildcard with its resulting state, applies the batch in one change and can undo it.

## What the room gives

Every voice answers with a structured reply (`wildcard_ideas`): at most 6 items, each read into a record.

```yaml
id: idea-3f2a9c0d1e4b5a67      # the same for the same reply, read again
kind: idea                     # idea (a provocateur) or finding (a sentinel)
persona: { id: wildcard:subversive, slug: subversive, name: The Subversive, group: provocateur }
title: Tell it from the tide
idea: Let the tide narrate the night of the flood.
why: Nobody expects it, and it carries the dread.
changes: { chapters: [3], secrets: [], summary: One scene changes point of view. }
risk: It may feel like a trick.
audacity: 8
evidence: «the key on the hook»   # a finding: the passage it is about
severity: major                   # a finding: minor, major or critical
advisory: true                    # always: never a score, never a gate
decision:                         # when somebody decided
  verdict: adapted                # adopted, adapted or rejected
  reason: The core is right, the form too loud.
  by: director                    # director (autopilot) or author (review table)
  at: 2026-11-28T10:00:00.000Z
  adaptation: Keep the idea, in one paragraph only.
```

Nothing is cut in silence: an item without an idea is counted as invalid, items beyond the cap are counted as omitted, voices beyond the cap are counted, a material too large for the model is shortened in the middle and the prompt and the result say so, and a reply cut by the output limit is marked.

## The journal of the room: `bible/ideas.yml`

Every consultation on which something was decided is kept in the Story Bible, with what each voice gave and what was decided of it:

```yaml
# The journal of the room: every consultation of the wildcards (Fuori dal coro), what each voice proposed and what was decided of it.
version: 1
entries:
  - id: room-7c1e…              # the consultation
    at: 2026-11-28T09:58:00.000Z
    by: author                  # who asked: author, copilot, brainstorming, autopilot
    target: { kind: chapter, label: "Chapter 3: The harbour", chapter: 3 }
    preset: creative-room
    voices: [subversive, cliche-hunter, twist-engineer, poet]
    ideas: [ … the records above … ]
```

- The target is a `selection`, a `paragraph` (scene), a `chapter`, the `book`, the `plan` of a design run or a `conversation` (Brainstorming).
- It is append-only and mergeable: two devices' copies are joined entry by entry by the sync, with no conflict, and an idea decided on both keeps the latest decision.
- It keeps the last 365 days, at most 300 consultations of 40 ideas each. A key this version does not know, in an entry or in an idea, is kept.
- Nothing decides from it and nothing is applied from it. The room is told the ideas rejected before, so that it does not give them again. Deleting it loses only the history.

## Secrets

- The **Secrets Guardian** (and any sentinel with `secrets: author`) is told every secret with its rule for the point of the story the room reads, as the writer is (`secretRules`): what is hidden until which chapter, what is revealed.
- **Every other voice** is told only the secrets the material may know: those whose reveal (`reveal_in`, else `known_from`, the rule of the autopilot) is at or before the chapter the room reads, with their truths. A secret still hidden there is never in its prompt, and without a chapter (a plan, a conversation) none is.
- The canon every voice shares lists characters, places, items and factions, never the secrets.

## Calls, cache and costs

- The room has its own task in the AI router, **Wildcards** (`wildcards`), which follows the review's while it has no route of its own (its own tags first, then what the review would be given), so a setup that never routed it keeps working.
- On the Costs page the room is a use of its own, **Wildcards' ideas** (`ideas`), wherever the author consults it (its voices, the Director's triage and the rewrite with the accepted ideas, all labelled `wildcards:…`); the consultations of the autopilot are the autopilot's, so that its budget counts them.
- The voices are asked in parallel (4 at once at most), each with the forced function. A reply that cannot be read is asked again once with what was wrong; a voice that fails says why and the others go on. A money cap stops starting voices once the answers cost that much.
- Every voice's prompt starts the same way (the instructions of the room, the book and the material) and says who the voice is, what it may know of the secrets and the ideas rejected before only after that: a provider that caches the start of a prompt serves the shared part to every voice after the first.
- The material is sized for the context window of the model the room is routed to.
- The estimate of a consultation (`estimateWildcardRoom`) is an interval: at the least every voice answers once and briefly, the shared start served from the cache; at the most every voice is asked twice and fills its output limit.

## The Director's triage

In the autopilot the Director decides every idea (`wildcard_triage`): adopted, adapted (with the version to use) or rejected, always with the reason, and accepts a few at most (3 by default). A reply that leaves ideas undecided, or decides one without a reason or an adaptation, is asked again once; what is still not decided stays undecided. The accepted ideas become material for the corrections (`wildcardIdeasMaterial`), never orders: the writer uses what serves the text, and never against the canon or the threshold of a secret.
