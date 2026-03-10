# Revise Chapter Guide

`revise_chapter` is the proposal-only editorial tool for a final chapter in `chapters/`.

It does **not** write files.

Use it when you want a chapter diagnosis, a revision plan, and scene-by-scene rewrite suggestions before deciding what to apply manually.

## What it is for

`revise_chapter` is the chapter-scale counterpart to `revise_paragraph`.

Use it when you want help with:

- chapter rhythm
- scene order pressure and momentum
- consistency of delivery across the chapter
- repeated exposition or slack prose
- identifying which scenes deserve revision first

It works best when the chapter already exists in `chapters/` and you want a controlled editorial pass rather than an automatic rewrite.

## What it returns

The tool returns:

- chapter-level diagnosis notes
- a revision plan ordered by scene priority
- scene proposals for the paragraphs that changed or need continuity review
- an overall continuity impact signal
- optional merged `suggestedStateChanges`
- source files used for the pass

It is intentionally proposal-only.

## Revision modes

Current supported modes:

- `clarity`
- `pacing`
- `dialogue`
- `voice`
- `tension`
- `show-dont-tell`
- `redundancy`

The same mode is applied across the chapter, but the result is still scene-aware.

That means:

- some scenes may change a lot
- some scenes may barely change
- some scenes may mostly generate continuity warnings rather than heavy prose edits

## Intensity

`revise_chapter` accepts:

- `light`
- `medium`
- `strong`

Use `medium` as the normal editorial pass.

Use `strong` when you want a more aggressive cleanup plan, still without writing files.

## How it works

At a high level:

1. read the final chapter and its scene files
2. review chapter-level context already present in the repository
3. run the requested editorial mode across the chapter's scenes
4. build chapter diagnosis notes
5. produce a revision plan
6. suggest `state_changes` review if continuity-sensitive beats appear

This means the tool is not just one giant rewrite blob. It is meant to help you decide where to act first.

## Typical use cases

Good examples:

- `revise_chapter` with `mode: pacing` when a chapter feels slow or over-explained
- `revise_chapter` with `mode: tension` when the chapter needs sharper pressure and cleaner scene escalation
- `revise_chapter` with `mode: redundancy` when multiple scenes repeat the same emotional or informational point
- `revise_chapter` with `mode: voice` when the chapter reads flatter than the surrounding material

## Continuity behavior

Just like `revise_paragraph`, this tool does not mutate canon or state files.

But if one or more scenes contain continuity-sensitive beats such as:

- location changes
- knowledge or reveal beats
- inventory movement
- relationship shifts
- conditions or wounds
- open loops opening or resolving

the result can include:

- `overallContinuityImpact`
- per-scene `continuityImpact`
- merged `suggestedStateChanges`

That means:

- if you later apply one or more proposed scene rewrites with `update_paragraph`
- and those same beats still matter in the revised text
- you should review the relevant chapter resume `state_changes`

Then run `sync_story_state` manually when the rewrite is stable.

## Recommended workflow

Typical flow:

1. read `chapter_writing_context`
2. run `revise_chapter`
3. review the diagnosis and revision plan
4. choose which scene proposals are worth keeping
5. apply selected changes manually with `update_paragraph`
6. review any suggested `state_changes`
7. run `sync_story_state` when ready

This keeps revision explicit and lets you avoid accidental chapter-wide mutations.

## MCP example

```json
{
  "tool": "revise_chapter",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "chapter": "chapter:001-the-arrival",
    "mode": "pacing",
    "intensity": "medium",
    "preserveFacts": true
  }
}
```

## Core API example

```ts
import { reviseChapter } from "narrarium";

const result = await reviseChapter("my-book", {
  chapter: "chapter:001-the-arrival",
  mode: "tension",
  intensity: "medium",
});

console.log(result.chapterDiagnosis);
console.log(result.revisionPlan);
console.log(result.proposedParagraphs);
console.log(result.suggestedStateChanges);
```

## Difference from `revise_paragraph`

- `revise_paragraph` is a scalpel for one scene
- `revise_chapter` is an editorial pass over the whole chapter

Use `revise_paragraph` when you already know which scene needs work.

Use `revise_chapter` when you want Narrarium to tell you which scenes should move first and why.

## Limits

`revise_chapter` is intentionally conservative.

- it does not write files
- it does not reorder chapter files automatically
- it is best for revision planning and targeted scene proposals, not full autonomous chapter replacement
- continuity suggestions are heuristics and still need author review

## Related docs

- `docs/revise-paragraph.md`
- `docs/query-canon.md`
- `docs/repository-spec.md`
- `packages/core/README.md`
- `packages/mcp-server/README.md`
