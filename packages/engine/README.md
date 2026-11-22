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
| Book access | `BookStore` (list/read/commit with compare-and-swap, `readMany`), `BookConflictError`, `loadBookSnapshot` |
| Autopilot | `AutopilotSession`, `AutopilotRun`, `advanceState`, `nextStep`, `applyIntervention`, `summarizeAutopilotState`, `effectivePublish`, `hostDefaultPublish`, `normalizeRunLimits`, `runnerActivity`, `runnerHeartbeatAgeMs`, `AutopilotRuleError`, `classifyAutopilotError`, `AUTOPILOT_ERROR_KINDS`, `AUTOPILOT_RULE_ERROR_CODES` |
| Director | `askDirector`, `listDirectorOpinions`, `parseDirector`, `serializeDirector`, `directorPrompt` |
| Readers | `readerPersonaSystemPrompt`, `mergeReaderPersonas`, `READER_EVALUATION_TOOL`, `chapterReaderText` |
| Ghostwriters | `parseGhostwriter`, `ghostwriterPrompt` |
| Markdown | `parseMarkdown` (with `error`), `splitFrontmatter`, `stripFrontmatter`, `renderMarkdown`, `FrontmatterError` |
| Text | `clipMiddle`, `truncate`, `tail`, `countWords`, `languageCode`, `tokensPerWord`, `scaleOutputTokens`, `sceneCharacterLimit` |
| AI | `AiPort` (the only door to language models), `createFetchAi` (OpenAI, Azure OpenAI, GitHub Models), `buildChatRequest`, `resolveAiCandidates`, `pickAiRuntimeConfig`, `effectiveAiBase`, `endpointOrigin`, `redactSecrets` |
| Personal server | `NarrariumServerClient`, `pairWithServer`, `pairWithServerDetailed`, `verifyServerIdentity`, `serverCompatibility`, `serverSupportsAutopilotControls`, `serverSupportsAutopilotRules`, `remoteBookStore`, protocol types (scopes, pairing, updates), `ServerSentEventParser` |
| Sync | `planFileSync`, `syncBookStores` (three-way sync of two book stores, with the files it leaves out in `skipped`) |
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

### Session options

| Option | Meaning |
|---|---|
| `bookId`, `store`, `ai`, `host`, `hostLabel` | Required: the book, its `BookStore`, the `AiPort`, `"browser"` or `"server"`, and the name the author sees. |
| `hostId` | Stable identity of the host (device or server id). Without it the label identifies the host. |
| `ownRunnerAlive` | Whether a run recorded by this same host is alive outside this session (another tab). Without it such a run is taken for interrupted. |
| `hooks` | `beforeStep(signal)`, `afterCommit({ task, message, paths })` and `afterChapter({ chapterNumber, title })`, for a host that syncs. Which of the last two is called, and when, is decided by the engine from where the book is published: see *Quick controls → Publishing*. |
| `defaultPublish` | Where the host publishes when the author has not chosen (`options.publishEvery`): `"step"`, `"chapter"` or `"off"`. Without it a server host publishes after every step, as it always did, and a browser host as `options.syncAfterChapter` says. |
| `now`, `maxEvents` | The clock, and how many live events are kept for late subscribers (400). |
| `retryDelayMs` | The base delay of the retries of a failed step (4000 ms): see *Retries*. `0` makes them instant. |
| `random` | Source of the retry jitter, in [0, 1) (default `Math.random`). |
| `heartbeatMs` | While a run is active the session emits a `state` event this often (default 30 000 ms), with the run's heartbeat in memory; nothing is saved for it. `0` switches it off. |
| `persistHeartbeatMs` | The longest silence of `autopilot/state.json` during a run (default 300 000 ms): after it the run saves a fresh `runner.heartbeatAt`, so that another host does not take a long step for a dead run. `0` switches it off. |

A run whose heartbeat is older than `RUNNER_STALE_MINUTES` (20) is taken for dead. `runnerActivity(state)` says `"none"`, `"active"` or `"stale"`, and `runnerHeartbeatAgeMs(state)` how old the heartbeat is, in milliseconds, for a state and for the summary of a live `state` event (`null` when nobody runs).

### Pipeline

1. **Concept** — story design, world context, characters, locations, factions and secrets (skipped when the book already has a design or prose).
2. **Summaries of the author's chapters** — only for a book with chapters written by the author: see *Chapters the author wrote*.
3. **Plan** — chapter plan; simulated readers react to it and the director approves it or asks for changes. The run can pause here for the author.
4. **Per chapter** — scene plan, prose scene by scene (streamed), then the review cycle:
   - blind simulated readers (no canon, no secrets) and a panel summary;
   - specialists (continuity, canon, secrets, timeline, voice, style, pacing) with evidence anchored in the text;
   - the **director** accepts or rejects every finding; the software, not the model, derives the repairs;
   - accepted fixes are applied; a new round verifies them, up to the director's round limit;
   - consolidation: chapter summary, recap, story so far, `plot.md`.
5. **Final** — the director's judgement on the whole book.

### Author interventions

`session.intervene({ scope, text, interrupt? })`:

- `next_step` — delivered once to the next writing step;
- `from_now` — a permanent rule for every following step, the director included;
- `rewrite` — the director picks the written scenes that must change; they are rewritten and reviewed again.

With `interrupt: true` the running step is abandoned and repeated with the new instruction. An intervention is saved at once, also while a step runs.

Permanent rules (`from_now`) are edited with `session.updateRule(index, text, expectedText?)` and `session.removeRule(index, expectedText?)`; `expectedText` is the rule as the author saw it, and a rule that changed in the meantime is never overwritten. A rule that cannot be saved throws `AutopilotRuleError`, whose `code` is `rule_empty`, `rule_too_long` (a rule is at most `MAX_RULE_CHARACTERS`, 800, because it goes into every request; it is refused, never cut), `rule_not_found`, `rule_changed` or `rule_duplicate`. The author's answer to a question of the director (`QuestionAnswer`) is a note used once; with `asRule: true` it becomes a permanent rule instead (never the default).

### Quick controls

What the web app's quick-command bar uses: pause at the end of the chapter, the limits of one run, where the book is published, and the settings that can change while a run goes on. They live here, once, so the browser and the personal server behave the same.

**Pausing.** `session.pause(mode)` takes `"now"` (the request in flight is abandoned), `"after-step"` (the default: the step in flight finishes and is saved, then the run pauses) or `"after-chapter"` (the step in flight finishes and the run goes on to the end of the chapter in progress, its closing and the publishing of the chapter included, then pauses with `Chapter N completed: paused, as you asked.`, in the language of the book). It answers whether there was a run, or a start in flight, to ask.

- A chapter is *in progress* from the moment its scenes are planned until it is closed. With none in progress (the concept, the plan, the summaries of the author's chapters, the first step of a chapter that has not started, the moment between two chapters) it is `"after-step"`, and so is a wait before the retry of such a step; the wait before the retry of a step of the chapter goes on, because the chapter still has to be finished. A request made at the boundary, right after a chapter was closed, pauses before the next one starts. After the last step of the book the run is complete, and says so.
- The stricter request counts, whatever the order: `"now"`, then `"after-step"`, then `"after-chapter"`. A request made while `start()` is in flight is kept for the run.
- `session.cancelPause()` takes back a pause that is waiting (`"after-step"` or `"after-chapter"`) without stopping anything, and answers whether there was one. A `"now"` that happened cannot be taken back. `AutopilotRun` has the same: `stopAfterChapter()`, `cancelPause()` and `pausePending`.
- When the run ends for it, `run-ended` carries `code: "chapterPause"`. If the option `pauseAfterEachChapter` would pause at the same moment, the request that was just made is the one that is said.

**Limits of one run.** `session.start({ limits: { steps, chapters } })` pauses the run after that many steps saved, or chapters completed, by this run. Nothing of it is saved: the next run has no limit unless it asks. A value that is not a whole number above zero is no limit (`normalizeRunLimits`). A step that fails or is abandoned does not count; with `steps: 1` a run makes one step (also one of the plan, or the final judgement) and stops, so three of them make three steps and three commits. `chapters` is the same limit as the saved option `chaptersPerRun`: the stricter of the two counts. A limit never takes the place of a reason the book has to stop (a plan that waits for the author, a question, a complete book), and the pause the author asked for is the one reported when both are due at once. `run-ended` carries `code: "stepLimit"` or `code: "chapterLimit"`.

**Publishing.** `options.publishEvery` is `"step"` (after every saved step, and again when a chapter is closed, so that the chapter is published whole), `"chapter"` (when a chapter is closed) or `"off"` (never). It is saved with the other options and can change while a run goes on. `effectivePublish(options, defaultPublish)` is the one rule that says where the book is published: `options.publishEvery`, else the host's `defaultPublish`, else the older option `options.syncAfterChapter` (`"chapter"` when it is on, `"off"` when it is off), so the files of an older engine behave as they did. A host that passes no `defaultPublish` gets `hostDefaultPublish(host)`: a `"server"` host publishes after every step (its `afterCommit` hook has always been called then), a `"browser"` host has none, so `syncAfterChapter` decides.

The engine applies it, so a host only says *how* to publish: `hooks.afterCommit` is called after every saved step when the way is `"step"`; `hooks.afterChapter` when a chapter is closed and the way is `"chapter"` or `"step"`; neither when it is `"off"`. A host that publishes in every way needs both hooks. The way is read at the end of every step and of every chapter, from the state that step saved. A publish that fails is reported as before (a `sync` event with `syncFailed`, or `publishFailed` for a chapter) and never stops the run. `beforeStep` is not a publish: it is called before every step whatever the way.

**Changing settings during a run.** `session.updateOptions(partial)` saves the options and answers the saved state. While a run is active only `publishEvery` (`null` takes the choice back, so that the host decides again) and `pauseAfterEachChapter` can change (`LIVE_AUTOPILOT_OPTIONS`); any other option throws `AutopilotBusyError`, as `configure` does, and nothing of that request is applied. With no run active any option can change. The change is a compare-and-swap commit, like an intervention: the step in flight is neither failed nor repeated, the run takes the author's value into the state the step saves (`reconcileAuthorChanges`) and reads it at the end of that step, or of the chapter. A value nobody knows changes nothing, and a request that changes nothing writes nothing.

**What the summary says.** `AutopilotStateSummary`, which the `state` events carry and `snapshot().summary` holds for a client that connects later, has four fields that are never saved: `pausePending` (`"after-step"`, `"after-chapter"` or `null`), `limits` (`{ steps?, chapters?, stepsDone, chaptersDone }` of the run in progress, `null` when it has none or is over; `chapters` is the stricter of the run's limit and `chaptersPerRun`), `publish` (`effectivePublish` of the options and the host's default) and `retry` (the retry the run is waiting for, present only while it is: see *What the interface reads*). A summary made from the state file alone (`summarizeAutopilotState(state)`) has no `pausePending`, no `limits` and no `retry`: nothing in the file says them, so a client takes them from the events and the snapshot. They change without the state being written, so `updatedAt` does not move: every change of the pause that waits, and every saved step, is a `state` event, and a client keeps the newest event it has seen, whatever its `updatedAt`.

**Message codes.** `run-ended` and `insight` events carry a `code` when a client can say it in its own language: `chapterPause`, `stepLimit` and `chapterLimit` join `takenOver` and the others (`AutopilotMessageCode`). The `message` of the event, and of the saved state, is always in the language of the book.

### What the interface reads

Data the web app's pages used to have to guess (from the text of a step, from the 200 activities of the log) and now find in the state and in the summary. All of it is additive: every field is absent until the engine that writes it has something to say, and a state or a summary without one is what an older engine wrote.

**The final verdict.** When the `final` step is done, `state.finalReview` is `{ verdict, score, text, at }`: the director's judgement of the whole book as data, where the line of the step said `approve 8/10 — …`. `verdict` is `"approve"` or `"revise"` (a `rewrite` is a `revise`, and so is an approval withheld because its score is under the `approvalScore` of `director.md`); the book is closed all the same, as it always was. `score` is on the scale of the chapters (0-10, one decimal at most), `text` is the director's summary cut with `clipText` at `FINAL_REVIEW_TEXT_CHARACTERS` (1200) characters, and `at` is when the director gave it. `summary.finalReview` has the same fields with the text cut at `FINAL_REVIEW_SUMMARY_CHARACTERS` (400). A book that is not complete any more (its chapters were extended, or a `rewrite` reopened it) has none until the final step is done again.

**Working time.** `stats.workedMs` is the sum, over every run, of the durations of the steps that were saved, each from its start to its end as its activity shows. Not counted: the wait for the author, the pauses between runs, the attempts of a step that failed and the waits between them (a step counts the attempt that was saved), the steps that were abandoned. A whole number of milliseconds, never negative, in the state (so it outlives the 200 activities of the log) and in `summary.stats`. A state written before it existed has none (and neither has its summary: not zero, not `NaN`) and it counts from zero at the first step that is saved.

**Errors.** A step that fails puts `errorKind` and `errorDetail` in its activity (the `task-finished` event carries them too) and, when it ends the run, in `state.lastError`; `summary.lastError` has the same two under the names `kind` and `detail` as well. A step that the author cancelled is no failure and has neither. `AutopilotErrorKind` is a closed list (`AUTOPILOT_ERROR_KINDS`), told from what the engine knows of its errors (`classifyAutopilotError(error)` is the one function, a status or a flag deciding before the words do):

| Kind | What it is |
|---|---|
| `auth` | 401 or 403: a key, or a permission. |
| `rate_limit` | 429. |
| `timeout` | The request ran out of time (`timedOut`), or 408. |
| `network` | The provider could not be reached, or the connection dropped: no status, `transient`, or the words of a network failure. |
| `provider` | Any other failure of the provider (another 4xx or 5xx, an error inside the stream) or of its reply (`AiReplyRejectedError`, a reply that is not JSON). |
| `truncated` | The reply was cut by the output limit (`truncated`, `reasoningOnly` included). |
| `refused` | Nothing was called: the privacy setting for fallbacks left no candidate (`AiFallbackBlockedError`), or no model is routed to the task (`AiUnavailableError`). |
| `budget` | The routing limits leave no candidate to call (`AiRoutingBudgetError`). |
| `limit` | No context window holds the prompt (`AiPromptTooLargeError`), or the run's own ceiling of steps. |
| `profile` | A file of the book the autopilot would rewrite cannot be read: its frontmatter is not valid YAML (`FrontmatterError`). The author fixes it. |
| `conflict` | A file changed under the step and the retries are used up (`BookConflictError`). |
| `unknown` | Everything else. |

`errorDetail` is `{ status?, endpoint?, model?, provider?, integration?, attempt?, retries? }`, short and with no secret in any field: `status` is the HTTP status when the provider answered; `endpoint` is only the **origin** of the integration's address (`new URL(address).origin`: never a path, a query, a fragment or credentials, and nothing at all for an address that is not a web address); `model`, `provider` and `integration` (the id) are passed through `redactSecrets` and cut at 160 characters. `attempt` and `retries` are there only for a failure that is retried: the retry it belongs to (the one that followed it, or the last one made when the run gave up) and how many retries this kind of failure gets, the numbers of the `failureRetry` insight; a failure that is never retried (a 401) has neither. Where an error came from is `AiProviderError.target` (`{ provider, model, integrationId, endpoint? }`, the endpoint already an origin), which the engine's client sets on the error of the last candidate it tried; it is separate from the error's own `model`, `provider` and `integrationId`, whose presence means that the model had started to answer and is billed. A state written before the errors were classified has `lastError` with a message and no kind: `summary.lastError` then has none either.

**The retry that is waiting.** While the run waits to try a failed step again, `summary.retry` is `{ at, attempt, retries }`: `at` is the ISO time of the next attempt, `attempt` and `retries` those of the `failureRetry` insight (`retry 2 of 3`). It is never saved, and it is the fourth field of the summary that only a live session knows (see *What the summary says*). Every change is a `state` event, so a client counts down without guessing: one event when the wait begins (right after the `failureRetry` insight), one when it is over and the attempt starts (the summary has no `retry` then), and the last summary of a run that ends, or is paused, during the wait has none. A host that gets the state from a `state` event replaces its summary by the newest one it has seen, and so the retry goes away.

**The rounds of every chapter.** `PlannedChapter.rounds` is a compact history of the rounds of review of a chapter that closed: one `{ director?, readers?, accepted?, rejected? }` for each, oldest first, written when the director judges the round and kept after the chapter is closed (`state.review` is the round in progress and is cleared when the chapter closes). `director` is the director's vote and `readers` the average of the simulated readers' votes (0-10, one decimal at most); `accepted` and `rejected` are what the director decided, whole numbers. The readers read a chapter once, in the first round of its review, so only that round has `readers` (a chapter rewritten after the author's request is reviewed again without readers). A chapter keeps at most `MAX_CHAPTER_ROUNDS` (8): a chapter that is rewritten adds the rounds of its new review and the oldest leave. A chapter that was never reviewed has none (`rounds` is absent, never an empty list), and the history survives the plan being made again around the chapters when the author raises the number of chapters of a finished book. In `state.json` every round takes one line of about 75 bytes (the file is still plain JSON), so a book of 5000 chapters with three rounds each adds about 1.1 MB to a file the server accepts up to 8 MiB.

**Older and newer engines.** Every new field is read tolerantly (a value that is not valid is dropped, never made up) and an older file reads as it always did. An engine from before these fields reads a file that has them without trouble but does not know them: `normalizeAutopilotState` of that engine drops `finalReview`, `stats.workedMs`, the kind and the detail of `lastError`, and the `rounds` of the chapters, so the first time it writes the state the history is lost (the activities keep their `errorKind` and `errorDetail`, which it does not look at). The worked time then starts again from zero in the engine that knows it, and the rounds start again with the next review.

### Long books

There is no maximum number of chapters. A plan longer than `PLAN_BATCH_CHAPTERS` (20) is made of several `plan` steps, one per batch, so that no reply outgrows the model's output; `plan.revisionBatches` lists the first chapter of every batch a revision of the plan still has to regenerate, and `plan.skippedReaders` the readers whose reaction stayed incomplete after a retry and who are not asked again. The lists of chapters in a prompt are windowed around the chapter at hand (`outline`, at most `OUTLINE_MAX_CHARS`, 24 000 characters), so a prompt never outgrows its budget and the work to build it grows linearly with the book.

### Chapters the author wrote

A chapter written before the autopilot took over has no summary unless the author wrote one, and without it the story so far of the chapter that follows would start blind. Before anything is planned or written after them, the planner adds one `summarize-imported` step for every such chapter without a `summary`: the model of the `simple-tasks` route summarizes it in two to four sentences, and the summary is saved in its `chapter.md` (created when there is only a folder of scenes) and in its resume file when it has none. A chapter that already has a summary, in its file or in the plan, is skipped and its file is not touched; the plan learns the summaries the files have. One chapter is one step and one commit, with a title and a reason in the language of the book, so it respects pause and budget like any other step, is repeated safely and resumed where it stopped, and is never asked again once the summary is saved. A finished book is not summarized.

## The director

The director is the author's stand-in: it approves plans and chapters during the autopilot and can be asked at any time what it thinks of the book, a chapter or a scene:

```ts
import { askDirector } from "narrarium-engine";

const { opinion } = await askDirector({ store, ai, target: { kind: "chapter", chapter: "003-the-storm" }, question: "Is the ending strong enough?", save: true });
```

Its profile lives in `director.md` at the book root (persona, autonomy, strictness, approval score, review rounds, priorities, taste, red lines, simulated reader weights and a free vision). Saved opinions go to `evaluations/director/`.

Values are read as the author wrote them: an autonomy whatever its case (`Full`, `ask on critical`), numbers with their decimals (`approval_score: 7.5`, a reader weight of `0.4`) and a decimal comma (`'9,5'`).

### Profiles that cannot be read

`parseDirector`, `parseGhostwriter` and `parseReaderPersona` never throw and never hide a problem: they return `warnings: string[]` (empty when the file is as it says), each naming the file. A warning is YAML that cannot be read (with its line), a value that is not understood (an autonomy nobody knows, a score that is not a number, a list that is not a list, a reader type that is none of `standard`, `genre`, `custom`, a switch that is neither yes nor no), and the profile then has the default for that value, as it always had. The defaults themselves carry `warnings: []`.

A profile with warnings is not what the author wrote, so the engine never goes on with it silently and never replaces the file with the defaults:

- before a step, the autopilot checks the director, the files of the simulated readers when readers are used, and the ghostwriter of the chapter for a step that writes. When one has warnings it spends nothing, emits an insight with code `profileProblems` and stops with `status: "waiting-author"` and a `message` that lists the problems (in the language of the book); the author corrects the file and resumes.
- `askDirector` still gives its opinion, and reports the problems of `director.md` in `warnings` next to it.
- a host that saves a profile should not do it over a file that has warnings.

## Files in the book

| Path | Content |
|---|---|
| `director.md` | Director profile (`type: director`). |
| `autopilot/state.json` | Autopilot state: brief, options, plan (with the compact `rounds` of review of every chapter), review cycle, rules, interventions, statistics (with `workedMs`), the final review of the book (`finalReview`) and the last error with its kind. |
| `autopilot/activity.json` | Last 200 activities (what, why, next, result, model, tokens, cost). |
| `autopilot/plan.md` | Human-readable mirror of the plan. |
| `chapters/<chapter>/chapter.md` | The chapter, with its `summary` (written when it is closed, or by the summary step for a chapter the author wrote). |
| `resumes/` | `total.md` (one section per chapter) and `chapters/<chapter>.md` (the recap of each one). |
| `evaluations/director/` | Director opinions (`book.md`, `chapters/<chapter>.md`, `paragraphs/<chapter>/<paragraph>.md`). |
| `evaluations/readers/` | Simulated reader evaluations, in the same format as the web app. |

## AI tasks

The engine asks the host for these router tasks (capabilities): `autopilot` (concept, plan, scenes, prose, repairs), `director`, `reader-evaluation`, `reader-evaluation-summary`, `review` (specialists) and `simple-tasks` (summaries of scenes and of the chapters the author wrote). Missing routes fall back to models tagged `default`.

### What the models read of a scene

Prose that is judged or summarized (the specialists, the director's review of a chapter, the consolidation, the director's opinion on a scene or a chapter, the summary of a chapter the author wrote) is cut, when it is too long, in the middle: `clipMiddle(text, max, { head: 0.6 })` keeps the start and the end, joined by `[…]` (on a line of its own when the text has several lines), at a word and never inside a character. The limit comes from the book: `sceneCharacterLimit(wordsPerScene)` is ten characters a word (as much as the longest words of any script written with spaces) and half as much again, so a scene of the length the brief asks for is never clipped; the fixed limits these prompts always had stay as the least a prompt keeps, so no scene is cut that was not cut before. A scene within the limit reaches the model exactly as it is written. The ending the next scene is continued from is the real end of the previous one, however long it is.

### Secrets in a prompt

`secretRules(store, snapshot, chapterNumber?)` lists the secrets with the rule that holds for the chapter (`HIDDEN until chapter N`, `The reveal is planned in THIS chapter`, `Already revealable…`, or `No reveal threshold`) and, for each, its truth. A book with few secrets gets all of them, exactly as ever. A list over `SECRET_RULES_MAX_CHARS` (24 000 characters) is windowed like a list of chapters: secrets revealed more than `SECRET_WINDOW_CHAPTERS` (30) chapters before drop out first, then the truths and the long wording; what the chapter must not reveal (a reveal still to come, or none planned) and the reveal of the chapter itself stay as long as anything can, the nearest chapters first, and the last line says how many are not listed. Only the files of the secrets that are listed with their truth are read, so a book of thousands of secrets costs the same as a small one.

### Languages

Limits on the reply of a step are sized for Latin script (2.4 tokens a word) and grown for the language of the book: `tokensPerWord(language)` gives the factor of the language (by code, name or region: `ru`, `русский`, `zh-CN`), `UNKNOWN_TOKENS_PER_WORD` (6) for one the engine does not know, and `scaleOutputTokens` applies it up to `OUTPUT_TOKENS_CEILING`. Words are counted by `countWords` for every script, with `Intl.Segmenter` where a language has no spaces.

## The AI client

`createFetchAi(config, options)` is the one AI client of every host: the browser and the personal server give it the same `AiRuntimeConfig` (`pickAiRuntimeConfig(settings)`) and get the same requests and the same outcomes. A host adds only what is its own, through `options`:

| Option | Meaning |
|---|---|
| `fetch` | The `fetch` to use (default the global one). |
| `githubModelsBaseUrl` | Origin of GitHub Models, or of a proxy that forwards `/inference`. |
| `defaultTimeoutMs` | Timeout for an integration that has none (default `DEFAULT_REQUEST_TIMEOUT_MS`). |
| `onAttempt`, `onAttemptEnd` | Hooks that see every attempt that is sent and how it ended (below). |
| `acknowledgeFallback` | Asked before content goes to an integration of another account than the one it went to so far (below). |

What every host gets, whatever its options:

| What | How |
|---|---|
| Request | `buildChatRequest(candidate, request, { githubModelsBaseUrl })` is the only place a request is built: URL, headers, body, streaming, tools or JSON-in-prompt, and the output limit parameter of the model family. Pure and exported, so hosts can test their configuration against it. |
| Output limit | A structured request gets at least `STRUCTURED_OUTPUT_FLOOR` (4096) tokens. A model known to reason by name (o1/o3/o4, gpt-5, codex-mini; for Azure the declared underlying model, else the deployment name) gets `REASONING_OUTPUT_MARGIN` (12 000) more, because its reasoning is counted in the limit. Never above the model's own `maxOutputTokens`. An Azure deployment of unknown identity gets `max_completion_tokens` from API version 2024-09-01, `max_tokens` before. |
| Prompt size | A candidate whose `maxInputTokens` (context window) cannot hold the prompt (estimated with `likelyMessageTokens`, the tool schema included, against `resolveModelTokenBudgets`: window minus the output reserve minus a 5% margin) is skipped. If no candidate can, `AiPromptTooLargeError` (not retryable) gives the estimate and the largest budget. A prompt is never cut. |
| Privacy of fallbacks | `fallbackDisclosure.sameBoundaryOnly` excludes fallbacks outside the primary's integration (the boundary). `requireAcknowledgement` asks `options.acknowledgeFallback(from, to, { capability, label })` before content goes to an integration it has not gone to: only `true` allows it, a throw cancels the call, and a host without the hook (the server) never crosses (fail closed). The engine asks at every call that needs the crossing (once per pair of accounts within a call), so a host that remembers acknowledgements answers from its memory. When nothing is left to call, the error names the setting and how to change it. |
| Routing limits | `routingExecution`: `maxCandidates`, `maxTotalDurationMs`, `maxTokenAttempts`, `maxEstimatedCost`. The total time never interrupts the first candidate before its own timeout; later candidates start only while time remains and run for what remains. Tokens and cost are estimated per attempt from the real prompt and the output limit (reasoning margin included): candidates are kept while the sum fits, and a first attempt that alone exceeds a limit gives `AiRoutingBudgetError`. A configuration without these fields (saved by an older host) has no such limits and no privacy policy. |
| Timeout | An integration's `requestTimeoutMs`, else `options.defaultTimeoutMs`, else `DEFAULT_REQUEST_TIMEOUT_MS` (600 s), in every host. |
| Hooks | `onAttempt(attempt)`: `attemptId`, the effective `messages` (with the JSON instruction a model without tools receives), the output limit, `stream`, `tools`, `endpoint` and `timeoutMs`. `onAttemptEnd(end)`: the same `attemptId`, `outcome` (`ok`, `failed`, `cancelled`), `usage`, `cost`, `usageKnown`, `costKnown`, the reply `text` or the `error` (without credentials), `failureKind` (`timeout`, `cancelled`, `provider`), `status`, `retryAfterMs` and `durationMs`, for every attempt that was sent, failed ones included. A hook that throws never breaks a call. |
| Approving endpoints | `effectiveAiBase(integration, githubModelsBaseUrl?)` is the origin and path every request of an integration starts with, defaults included (`https://api.openai.com/v1`, `https://models.github.ai/inference`). A host that approves where API keys may be sent should compare these. |
| Wire format | Server-sent events with several `data:` lines are joined with a newline; a JSON reply to a streaming request (a server that ignores `stream`) is read as the reply; an `error` in a 200 reply is a provider error. |
| Errors | `AiProviderError` carries `status`, `retryable`, `transient` (it depends on the moment: 408, 429, 502, 503, 504, network), `retryAfterMs` (the `Retry-After` of a 429 or 503, at most five minutes), `timedOut`, `truncated` and `reasoningOnly`. Keys, `Bearer …`, `api-key: …`, `?key=…` and `sk-…` are removed from every message (`redactSecrets`), also before the runner saves it. The error of a candidate that was tried carries `target` (`{ provider, model, integrationId, endpoint? }`, the endpoint only an origin: see *What the interface reads*). |

### Costs and budgets

`estimateCost` bills cached tokens like normal input unless the model has a `cachedPerMTok`. A reply carries `usageKnown` and `costKnown`: when the provider reports no tokens, `usage` is an estimate (`usageKnown: false`, `costKnown: false`); a model without a price has no `cost`. The autopilot counts those calls in `stats.usageUnknownCalls` and `stats.costUnknownCalls`, says once per run that the money budget (`options.budgetLimit`) cannot apply to a model without a price (`budgetNotApplicable`), and `options.budgetTokens` stops the run at a number of tokens instead (0 = off).

### Retries

A step that failed with a transient provider error is retried up to three times, after about 4 s, 12 s and 36 s (with jitter, never sooner than the provider's `Retry-After`); the `failureRetry` insight carries `attempt`, `retries` and `waitMs`. A rejected reply, or a failure that is not the provider's, is retried once, the first with the reason. The same failure twice in a row that does not depend on the moment (an empty reply, a 500 with the same message) stops the run at once. A reply cut while the model had only reasoned is retried once with an output limit three times larger (`AiRequest.outputBoost`), and the next steps of that kind start with it. `retryDelayMs` is the base delay: every delay scales with it, `0` makes them instant. A pause ends the wait. While the run waits, `summary.retry` says when the next attempt is (see *What the interface reads*).

### What the model's replies must be

- A forced tool call must carry at least one of the schema's required fields (else one of its declared properties); otherwise the JSON in the text is used, and a reply with neither is rejected and retried once with the reason.
- `<think>` blocks are dropped, and so is everything up to the last `</think>` of a model that never opened it.
- What the engine escapes in prompts (`&amp;`, `&lt;`, `&gt;`) is un-escaped in prose and in every text field of a structured reply (`unescapePromptData`).
- The director decides with a score: the reply must carry `verdict` and `score` (0-10; above 10 and up to 100 is read as a percentage). An `approve` below the `approvalScore` of `director.md` counts as `revise`, with the reason in the record, for the plan, every chapter, the final review and `askDirector`.
- A simulated reader must answer with a score and its reaction. A reader whose reply is still incomplete after the retry is skipped (and said so): the review goes on with those who answered.

## Sync

`syncBookStores({ local, remote, base })` is a three-way sync of two `BookStore`s (the browser's working copy and the personal server's): it copies what changed on one side, reports what changed on both (`conflicts`, settled by `resolveConflict`) and returns the `base` to remember for the next one. It reads from a store that has `readMany` a batch of paths at a time, and commits in chunks of at most 400 changes and 24 MiB, so a book of any size passes the limits of one request.

What it does not move is reported, never silently ignored and never a reason for the sync to fail. `result.skipped` lists, in path order, each file with its `reason`:

| Reason | Meaning |
|---|---|
| `too-large` | The file is over `maxFileBytes` (`SYNC_MAX_FILE_BYTES`, 8 MiB, what the personal server accepts), with its `size` in bytes; or a store refused to send it because it is too much (HTTP 413), without a `size`. The size is checked before the file goes into a commit: a store may list `size` in its `BookFileEntry`, and then the file is not even read. |
| `unsafe-path` | A path that is not a safe repository path (`../x.md`, `.git/…`, absolute): the same paths as `rejected`. |
| `not-text` | A file that is not text (binary assets are left to the hosts) and is not the same on both sides. |

A skipped file is not recorded as synced (a file that was never synced stays out of `base`, one that was keeps the version the other side has), so the next sync says it again until it can be moved; the deletion of a file is never skipped.

## The personal server client

`NarrariumServerClient` is the typed client of the personal server API, shared by the web app and the CLI (see the [server README](../server/README.md)).

- **Version compatibility.** `serverCompatibility(info)` tells whether the server speaks an API this engine supports (`MIN_SUPPORTED_SERVER_API` to `MAX_SUPPORTED_SERVER_API`, both 1 today): `{ status: "ok" | "server-older" | "server-newer", message }`. A server that does not say which API it speaks is an older one. It never throws; `verifyServerIdentity` returns it as `compatibility`, and so does `client.verifiedInfo()` in `identity`, so the host decides how to show it (update the server, or update the app).
- **Pairing.** `pairWithServer(options)` still answers the token. `pairWithServerDetailed(options)` answers `{ token, verification?, requestVerification?, compatibility? }`, and `onWaitingApproval({ verification?, compatibility? })` is called while the owner approves. The verification is four digits the server derives (see the server README): while the request waits, the admin panel shows the same four digits next to it (`requestVerification`, which `onWaitingApproval` receives as `verification`), so the owner can tell this device's request from another one; once approved, the panel shows the digits of the token next to the client (`verification` of the result). `onPaired(pairing)` hands over the same details to a host that keeps calling `pairWithServer`. An older server that sends none is fine; a value that is not four digits is ignored.
- **Signing out.** `client.signOut()` revokes the token the client holds (`DELETE /api/v1/session`) and no other: `{ revoked: true }`, or `{ revoked: false }` when the token was already revoked. A server that cannot be reached is an error, because the token may still be valid there (`forgetSession()` is the older call and reports a revoked token as an error).
- **Quick controls.** Pause at the end of the chapter, the limits of one run and the settings that can change during a run (see *Quick controls* above) go through three calls. A server that implements them announces `SERVER_FEATURE_AUTOPILOT_CONTROLS` (`"autopilot-controls"`) in the `features` of `GET /api/v1/info`, and `serverSupportsAutopilotControls(info)` reads it (never throws; an older server, or an odd answer, says no). Ask before sending what an older server would read as something else: it ignores `limits` (the run would not stop after the step or the chapter that was asked for, and goes on spending) and takes every pause mode but `now` for `after-step` (a `cancel` would pause). The calls need the `run` permission, like the other commands that steer a run, answer the snapshot (`AutopilotSnapshot`, with the server session's `summary`: `pausePending`, `limits`, `publish`), and fail as `{ "code", "message" }` with the status below, which `ServerRequestError` carries as `status` and `code`. Every one also answers 401 `unauthorized`, 403 `scope` (no `run` permission) and 404 `book_not_found`.

  | Client method | Request | Answer |
  |---|---|---|
  | `pauseAutopilot(bookId, mode)` | `POST /api/v1/books/:id/autopilot/pause` with `{ "mode": "now" \| "after-step" \| "after-chapter" \| "cancel" }`. A body without `mode` is `after-step`, as it always was. | `200` the snapshot. `cancel` with nothing waiting, and any mode with nothing running, are `200` too: the summary's `pausePending` says what is waiting now. `400 invalid_request` for a `mode` that is none of the four, or a body that is not a JSON object. |
  | `startAutopilot(bookId, input)` | `POST /api/v1/books/:id/autopilot/start` with the body it always had (`brief`, `options`, `force`) and `limits?: { "steps"?: number, "chapters"?: number }`. | `200` the snapshot. `400 invalid_request` when `limits` is present and is not a JSON object. The server hands the numbers to the engine as they are (a value that is not a whole number above zero is no limit) and does not save them. The other answers are as before: `409 busy`, `412 ai_not_configured`, `429 too_many_runs`, `503 maintenance`. |
  | `updateAutopilotOptions(bookId, input)`, also `updateOptions` | `PUT /api/v1/books/:id/autopilot/options` with `{ "publishEvery"?: "off" \| "chapter" \| "step" \| null, "pauseAfterEachChapter"?: boolean }`: at least one of the two, and nothing else. `null` takes the choice back, so that the server's default decides again. | `200` the snapshot, of the state that was saved (as `configure` answers), also while the autopilot runs: the step in flight is not repeated, and the run reads the new value at the end of the step, or of the chapter. `400 invalid_request` for a body that is not a JSON object, has none of the two keys or has another key, or a value of the wrong type (`publishEvery` that is not one of the four, `pauseAfterEachChapter` that is not a boolean). `409 conflict` when the state file kept changing under the write (try again) and `409 state_corrupt` when it cannot be read; `503 maintenance` while the server is about to restart. |

  The server answers with the engine's `session.pause`, `session.cancelPause`, `session.start({ …, limits })` and `session.updateOptions`, and takes `defaultPublish: "step"` as its default (which is what it does when it passes none). It can validate the bodies against the lists the engine exports for that: `PAUSE_AUTOPILOT_MODES`, `AUTOPILOT_PUBLISH_MODES` and `LIVE_AUTOPILOT_OPTIONS`. For a GitHub book its `afterCommit` hook pushes (what the engine calls after every step in `step` mode) and its `afterChapter` hook pushes too (what it calls when a chapter is closed in `chapter` and `step` mode): without that one, `chapter` would publish nothing.

- **Permanent rules.** The rules the author gave with `from_now` (`state.constraints`, in the order the author sees them) are edited and removed with two calls, which the engine's session already has (`session.updateRule`, `session.removeRule`). A server that implements the routes below announces `SERVER_FEATURE_AUTOPILOT_RULES` (`"autopilot-rules"`) in the `features` of `GET /api/v1/info`, and `serverSupportsAutopilotRules(info)` reads it (never throws; an older server, or an odd answer, says no): a client asks before it offers to edit or remove a rule, because an older server answers `404 not_found` to the routes. The calls need the `run` permission, like the other commands that steer a run, and answer the snapshot (`AutopilotSnapshot`), as `configure` does; the `index` is the position of the rule in `state.constraints`, from 0. `expectedText` is the rule as the author saw it: when the rule at that index is no longer that (compared without the spaces around it), nothing is written and the answer is `409 rule_changed`, so a rule that changed in the meantime, on another device or by the director's answer, is never overwritten or removed by mistake. Every call also answers `401 unauthorized`, `403 scope` (no `run` permission) and `404 book_not_found`.

  | Client method | Request | Answer |
  |---|---|---|
  | `updateRule(bookId, index, text, expectedText?)` | `PUT /api/v1/books/:id/autopilot/rules/:index` with `{ "text": string, "expectedText"?: string }`. | `200` the snapshot, of the state that was saved (also while the autopilot runs: the step in flight is not repeated, and the next step has the new rule). A text equal to the rule it replaces changes nothing. `400 rule_empty` (nothing but spaces), `400 rule_too_long` (over `MAX_RULE_CHARACTERS`, 800: it is refused, never cut), `400 rule_duplicate` (another rule already says it), `404 rule_not_found` (no rule at that index), `409 rule_changed`, `409 conflict` when the state file kept changing under the write (try again) and `409 state_corrupt` when it cannot be read, `503 maintenance` while the server is about to restart. |
  | `removeRule(bookId, index, expectedText?)` | `DELETE /api/v1/books/:id/autopilot/rules/:index`, with `?expectedText=…` (URL-encoded) when the client has it. No body. | `200` the snapshot. `404 rule_not_found`, `409 rule_changed`, `409 conflict`, `409 state_corrupt`, `503 maintenance`. The rules after the one that was removed move up by one: a client reads the answer, not its own list. |

  The `code` of a refusal of a rule is the `code` of the engine's `AutopilotRuleError` (`AUTOPILOT_RULE_ERROR_CODES`: `rule_empty`, `rule_too_long`, `rule_not_found`, `rule_changed`, `rule_duplicate`), which a server can answer as it is (`400` for the first, the third and the last, `404` for `rule_not_found`, `409` for `rule_changed`); `isAutopilotRuleErrorCode(error.code)` tells a refusal of a rule from the other codes of `ServerRequestError`. The client sends the text as it is given and an index as it is given (a number that names no rule is `404 rule_not_found`), and what it gets back is the error it always gives, with the status and the code of the server. The answer to a question of the director that is kept as a rule needs nothing new: `answer(bookId, { questionId, answer, asRule: true })` has always carried `asRule` (`QuestionAnswer`), and a note used once is still the default.

## Tests

```bash
npm test -w narrarium-engine
```
