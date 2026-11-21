# narrarium-engine

Shared Narrarium engine: the **autopilot**, the **director**, the **simulated readers** and the **personal-server sync**. The same code runs in the Narrarium web app (browser) and in [`narrarium-server`](../server/README.md) (Node.js), so a book behaves identically wherever its autopilot runs.

The package is isomorphic: it only uses `fetch`, Web Crypto, `AbortController` and `structuredClone`, with no Node or DOM APIs.

## Install

```bash
npm install narrarium-engine
```

## What it contains

| Area | Main exports |
|---|---|
| Book access | `BookStore` (list/read/commit with compare-and-swap), `BookConflictError`, `loadBookSnapshot` |
| Autopilot | `AutopilotSession`, `AutopilotRun`, `advanceState`, `nextStep`, `applyIntervention`, `summarizeAutopilotState` |
| Director | `askDirector`, `listDirectorOpinions`, `parseDirector`, `serializeDirector`, `directorPrompt` |
| Readers | `readerPersonaSystemPrompt`, `mergeReaderPersonas`, `READER_EVALUATION_TOOL`, `chapterReaderText` |
| Ghostwriters | `parseGhostwriter`, `ghostwriterPrompt` |
| AI | `AiPort` (the only door to language models), `createFetchAi` (OpenAI, Azure OpenAI, GitHub Models), `resolveAiCandidates`, `pickAiRuntimeConfig` |
| Personal server | `NarrariumServerClient`, `pairWithServer`, `verifyServerIdentity`, `remoteBookStore`, protocol types (scopes, pairing, updates), `ServerSentEventParser` |
| Sync | `planFileSync`, `syncBookStores` (three-way sync of two book stores) |
| Testing | `narrarium-engine/testing`: `MemoryBookStore`, `seedBookFiles`, `createFakeAutopilotAi` |

## Running the autopilot

A host provides two adapters: a `BookStore` over the book files and an `AiPort` over its AI configuration.

```ts
import { AutopilotSession, createFetchAi, pickAiRuntimeConfig } from "narrarium-engine";

const session = new AutopilotSession({
  bookId: "my-book",
  store,                                  // your BookStore
  ai: createFetchAi(pickAiRuntimeConfig(settings)),
  host: "server",
  hostLabel: "my laptop",
});

session.subscribe((event) => console.log(event.type, event));
await session.start({
  brief: { idea: "A harbor town built on glass hides a lie.", targetChapters: 12 },
  options: { pauseAfterPlan: true },
});
await session.waitForIdle();
```

Every step is one atomic commit of the book files plus `autopilot/state.json` and `autopilot/activity.json`. A step whose files changed in the meantime (for example because the author edited them) is never overwritten: it is repeated on the latest text.

### Pipeline

1. **Concept** — story design, world context, characters, locations, factions and secrets (skipped when the book already has a design or prose).
2. **Plan** — chapter plan; simulated readers react to it and the director approves it or asks for changes. The run can pause here for the author.
3. **Per chapter** — scene plan, prose scene by scene (streamed), then the review cycle:
   - blind simulated readers (no canon, no secrets) and a panel summary;
   - specialists (continuity, canon, secrets, timeline, voice, style, pacing) with evidence anchored in the text;
   - the **director** accepts or rejects every finding; the software, not the model, derives the repairs;
   - accepted fixes are applied; a new round verifies them, up to the director's round limit;
   - consolidation: chapter summary, recap, story so far, `plot.md`.
4. **Final** — the director's judgement on the whole book.

### Author interventions

`session.intervene({ scope, text, interrupt? })`:

- `next_step` — delivered once to the next writing step;
- `from_now` — a permanent rule for every following step, the director included;
- `rewrite` — the director picks the written scenes that must change; they are rewritten and reviewed again.

With `interrupt: true` the running step is abandoned and repeated with the new instruction.

## The director

The director is the author's stand-in: it approves plans and chapters during the autopilot and can be asked at any time what it thinks of the book, a chapter or a scene:

```ts
import { askDirector } from "narrarium-engine";

const { opinion } = await askDirector({ store, ai, target: { kind: "chapter", chapter: "003-the-storm" }, question: "Is the ending strong enough?", save: true });
```

Its profile lives in `director.md` at the book root (persona, autonomy, strictness, approval score, review rounds, priorities, taste, red lines, simulated reader weights and a free vision). Saved opinions go to `evaluations/director/`.

## Files in the book

| Path | Content |
|---|---|
| `director.md` | Director profile (`type: director`). |
| `autopilot/state.json` | Autopilot state: brief, options, plan, review cycle, rules, interventions, statistics. |
| `autopilot/activity.json` | Last 200 activities (what, why, next, result, model, tokens, cost). |
| `autopilot/plan.md` | Human-readable mirror of the plan. |
| `evaluations/director/` | Director opinions (`book.md`, `chapters/<chapter>.md`, `paragraphs/<chapter>/<paragraph>.md`). |
| `evaluations/readers/` | Simulated reader evaluations, in the same format as the web app. |

## AI tasks

The engine asks the host for these router tasks (capabilities): `autopilot` (concept, plan, scenes, prose, repairs), `director`, `reader-evaluation`, `reader-evaluation-summary`, `review` (specialists) and `simple-tasks` (scene summaries). Missing routes fall back to models tagged `default`.

## Tests

```bash
npm test -w narrarium-engine
```
