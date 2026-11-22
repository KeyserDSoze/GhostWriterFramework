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
| Autopilot | `AutopilotSession`, `AutopilotRun`, `advanceState`, `nextStep`, `applyIntervention`, `summarizeAutopilotState`, `runnerActivity`, `runnerHeartbeatAgeMs`, `AutopilotRuleError` |
| Director | `askDirector`, `listDirectorOpinions`, `parseDirector`, `serializeDirector`, `directorPrompt` |
| Readers | `readerPersonaSystemPrompt`, `mergeReaderPersonas`, `READER_EVALUATION_TOOL`, `chapterReaderText` |
| Ghostwriters | `parseGhostwriter`, `ghostwriterPrompt` |
| Markdown | `parseMarkdown` (with `error`), `splitFrontmatter`, `stripFrontmatter`, `renderMarkdown`, `FrontmatterError` |
| Text | `clipMiddle`, `truncate`, `tail`, `countWords`, `languageCode`, `tokensPerWord`, `scaleOutputTokens`, `sceneCharacterLimit` |
| AI | `AiPort` (the only door to language models), `createFetchAi` (OpenAI, Azure OpenAI, GitHub Models), `buildChatRequest`, `resolveAiCandidates`, `pickAiRuntimeConfig`, `effectiveAiBase`, `redactSecrets` |
| Personal server | `NarrariumServerClient`, `pairWithServer`, `pairWithServerDetailed`, `verifyServerIdentity`, `serverCompatibility`, `remoteBookStore`, protocol types (scopes, pairing, updates), `ServerSentEventParser` |
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
| `hooks` | `beforeStep(signal)`, `afterCommit({ task, message, paths })` and `afterChapter({ chapterNumber, title })`, for a host that syncs. |
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
| `autopilot/state.json` | Autopilot state: brief, options, plan, review cycle, rules, interventions, statistics. |
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
| Errors | `AiProviderError` carries `status`, `retryable`, `transient` (it depends on the moment: 408, 429, 502, 503, 504, network), `retryAfterMs` (the `Retry-After` of a 429 or 503, at most five minutes), `timedOut`, `truncated` and `reasoningOnly`. Keys, `Bearer …`, `api-key: …`, `?key=…` and `sk-…` are removed from every message (`redactSecrets`), also before the runner saves it. |

### Costs and budgets

`estimateCost` bills cached tokens like normal input unless the model has a `cachedPerMTok`. A reply carries `usageKnown` and `costKnown`: when the provider reports no tokens, `usage` is an estimate (`usageKnown: false`, `costKnown: false`); a model without a price has no `cost`. The autopilot counts those calls in `stats.usageUnknownCalls` and `stats.costUnknownCalls`, says once per run that the money budget (`options.budgetLimit`) cannot apply to a model without a price (`budgetNotApplicable`), and `options.budgetTokens` stops the run at a number of tokens instead (0 = off).

### Retries

A step that failed with a transient provider error is retried up to three times, after about 4 s, 12 s and 36 s (with jitter, never sooner than the provider's `Retry-After`); the `failureRetry` insight carries `attempt`, `retries` and `waitMs`. A rejected reply, or a failure that is not the provider's, is retried once, the first with the reason. The same failure twice in a row that does not depend on the moment (an empty reply, a 500 with the same message) stops the run at once. A reply cut while the model had only reasoned is retried once with an output limit three times larger (`AiRequest.outputBoost`), and the next steps of that kind start with it. `retryDelayMs` is the base delay: every delay scales with it, `0` makes them instant. A pause ends the wait.

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

## Tests

```bash
npm test -w narrarium-engine
```
