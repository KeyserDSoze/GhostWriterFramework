# Query Canon Guide

`query_canon` is the fastest way to ask the repository a continuity question in natural language.

It sits between raw search and full manual file reading:

- `search_book` finds text matches
- `query_canon` tries to answer the question
- source files are still returned so the answer stays auditable

## What it can answer

Current-state questions:

- where a character or entity is
- what a character knows
- what a character has in inventory
- what a relationship currently is
- what conditions or wounds are active
- which open loops are still active
- who holds a secret
- when something first appears

Range and evolution questions:

- how a relationship changes between two chapters
- how a condition or wound state changes between two chapters
- which open loops open or resolve across a chapter range

## Where the answer comes from

`query_canon` combines several layers, in this order:

1. structured story state in `state/chapters/` and `state/current.md`
2. chapter resume deltas in `resumes/chapters/*.md` under `state_changes`
3. canon metadata in entity files
4. chapter and paragraph text
5. fallback repository search

This means the tool is strongest when:

- chapter resumes are up to date
- `state_changes` is filled in carefully
- `sync_story_state` has been run after stable rewrites

If story state is stale, the answer still works, but the tool adds a note so the user knows continuity snapshots may lag behind recent edits.

## Best use cases

Use `query_canon` when you want a short answer plus sources.

Good examples:

- `Where is Lyra right now?`
- `What does Lyra know after chapter 4?`
- `What is Lyra's relationship with Taren?`
- `What condition is Lyra in?`
- `What open loops are still active?`
- `Who knows this secret?`
- `When does the brass key first appear?`
- `How does Lyra's relationship with Taren change between chapter 3 and chapter 8?`
- `How does Lyra's condition change between chapter 3 and chapter 8?`
- `What open loops change between chapter 3 and chapter 8?`

Less ideal examples:

- broad thematic analysis with no concrete target
- style questions better answered from prose directly
- requests that depend on facts never written into canon, resumes, or state

## Instant queries

These ask for the latest known state, or for state through a specific chapter.

Examples:

```text
Where is Lyra right now?
What does Lyra know after chapter 4?
What does Lyra have?
What is Lyra's relationship with Taren?
What condition is Lyra in?
What open loops are still active?
```

If the question mentions a chapter like `after chapter 4`, the tool scopes the answer to that point in the book.

## Arc queries

These compare two chapter snapshots and summarize the change.

Examples:

```text
How does Lyra's relationship with Taren change between chapter 3 and chapter 8?
How does Lyra's condition change between chapter 3 and chapter 8?
What open loops change between chapter 3 and chapter 8?
```

The answer is built from the ordered story-state snapshots and chapter resume deltas, so it can say things like:

- a relationship moves from `wary-trust` to `guarded-loyalty`
- a condition changes from `exhausted` to `focused`
- an open loop is opened in one chapter and resolved in another

## Scope controls

Natural-language parsing is supported, but exact controls are available too.

### MCP tool

`query_canon` accepts:

- `question`
- `throughChapter`
- `fromChapter`
- `toChapter`
- `limit`

Use `throughChapter` for point-in-time answers.

Use `fromChapter` plus `toChapter` for range comparisons.

### Core API

```ts
import { queryCanon } from "narrarium";

const result = await queryCanon("my-book", "What does Lyra know?", {
  throughChapter: "chapter:004-market-ashes",
});

const arc = await queryCanon("my-book", "How does Lyra's condition change?", {
  fromChapter: "chapter:003-rain-gate",
  toChapter: "chapter:008-black-ledger",
});
```

## Output fields

`query_canon` returns structured output so agents can decide what to do next.

- `answer`: short human-readable answer
- `confidence`: `high`, `medium`, or `low`
- `intent`: what kind of query was recognized
- `matchedTarget`: the entity or chapter id that matched best
- `throughChapter`: the point-in-time chapter scope, when used
- `fromChapter` and `toChapter`: the resolved comparison range, when used
- `sources`: the files used to support the answer
- `notes`: ambiguity warnings, stale-state warnings, and fallback notes

## Recommended workflow

For best results:

1. write or revise final chapter or paragraph prose
2. let the normal maintenance sync refresh `plot.md` and `resumes/`
3. update `state_changes` in the relevant chapter resume
4. run `sync_story_state`
5. use `query_canon` to check continuity and evolution

This makes `query_canon` useful not only for drafting, but also for revision and continuity QA.

## Limitations

`query_canon` is strong, but it is not magic.

- it can only answer from what is actually written in canon, resumes, state, or prose
- if `state_changes` is incomplete, state-based answers may be partial
- if names are ambiguous, the tool may choose one target and add an ambiguity note
- open loops are global state, so target-specific filtering is heuristic
- some broad literary questions are still better served by directly reading the chapter text

## When to use something else

- use `search_book` when you want raw text matches
- use `list_related_canon` when you want files that mention an id or concept
- use `chapter_writing_context` or `resume_book_context` when you need broader drafting context instead of a single answer

## Related docs

- `docs/repository-spec.md`
- `packages/mcp-server/README.md`
- `packages/core/README.md`
