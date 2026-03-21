# Revise Paragraph Guide

`revise_paragraph` is a proposal-only editorial tool for final scene files in `chapters/`.

It does **not** write files.

Use it when you want Narrarium to suggest a better version of a scene before deciding whether to apply it with `update_paragraph`.

## What it is for

`revise_paragraph` sits between context gathering and actual mutation:

- `paragraph_writing_context` gives you what to read first
- `revise_paragraph` proposes a focused rewrite
- `update_paragraph` applies the rewrite only if you decide to keep it

This keeps revision explicit and audit-friendly.

## What it returns

The tool returns:

- a proposed paragraph body
- editorial notes about what changed and why
- a `continuityImpact` signal
- optional `suggestedStateChanges`
- source files used for the pass

## Revision modes

Current supported modes:

- `clarity`
- `pacing`
- `dialogue`
- `voice`
- `tension`
- `show-dont-tell`
- `redundancy`

These are not generic "rewrite better" modes. Each one tries to push the paragraph in a specific direction.

### `clarity`

Use this when the scene is understandable but muddy.

It focuses on:

- trimming filler phrases
- shortening long chained sentences
- making the beat easier to parse on first read

### `pacing`

Use this when the scene drags or over-explains.

It focuses on:

- faster sentence rhythm
- removing slow lead-ins
- trimming repeated beats that stall movement

### `dialogue`

Use this when the speech is hard to follow or the beat spacing is muddy.

It focuses on:

- clearer dialogue beat separation
- tighter narration around spoken lines
- less clutter around the exchange

### `voice`

Use this when the paragraph feels distant from the viewpoint or sounds too generic.

It focuses on:

- reducing filter verbs
- keeping the beat closer to the active viewpoint
- preserving the existing facts while making the voice feel less detached

### `tension`

Use this when the scene should feel sharper, tighter, or more pressured.

It focuses on:

- removing cushioning words
- stronger pressure cues
- shorter sentence rhythm where useful

### `show-dont-tell`

Use this when the paragraph explains the emotional or narrative beat too directly.

It focuses on:

- reducing summary-distance phrasing
- trimming filter constructions
- pushing the prose closer to in-scene language

### `redundancy`

Use this when the paragraph repeats the same emotional or narrative point.

It focuses on:

- removing duplicate emphasis
- collapsing repeated sentence work
- tightening the paragraph around its strongest beat

## Intensity

`revise_paragraph` accepts:

- `light`
- `medium`
- `strong`

Use `light` when the paragraph is already close.

Use `medium` as the default editorial pass.

Use `strong` when the wording needs more serious compression or reshaping, while still staying proposal-only.

## Continuity behavior

This tool does not write canon or state files, but it does try to warn you when the paragraph touches continuity-sensitive material.

If the scene includes things like:

- movement or location changes
- knowledge or revelation beats
- item possession changes
- relationship shifts
- conditions or wounds
- open loops or promises

the result may include:

- `continuityImpact: possible` or `continuityImpact: clear`
- `suggestedStateChanges`

That does **not** mean files were changed. It means:

- if you accept and apply the proposal
- and the revised scene still carries those beats
- you should review the chapter resume `state_changes`

After that, if needed, run `sync_story_state` manually.

## Recommended workflow

Typical flow:

1. read `paragraph_writing_context` so the pass includes `guidelines/writing-style.md`, any chapter-specific `writing-style.md`, and the point-in-time story context
2. run `revise_paragraph`
3. inspect the proposed body and editorial notes
4. if you want it, apply the revision manually with `update_paragraph`
5. if continuity-sensitive beats are involved, review `state_changes`
6. run `sync_story_state` when the rewrite is stable

## MCP example

```json
{
  "tool": "revise_paragraph",
  "arguments": {
    "rootPath": "C:/books/my-book",
    "chapter": "chapter:001-the-arrival",
    "paragraph": "001-at-the-gate",
    "mode": "tension",
    "intensity": "medium",
    "preserveFacts": true
  }
}
```

## Core API example

```ts
import { reviseParagraph } from "narrarium";

const result = await reviseParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  paragraph: "001-at-the-gate",
  mode: "clarity",
  intensity: "medium",
});

console.log(result.proposedBody);
console.log(result.editorialNotes);
console.log(result.suggestedStateChanges);
```

## Limits

`revise_paragraph` is intentionally conservative.

- it proposes, but does not apply
- it is best for targeted passes, not full scene reinvention
- continuity suggestions are heuristics, not automatic canon truth
- if the paragraph changes the story materially after you apply it, you still need to review resumes and state manually

## Related docs

- `docs/revise-chapter.md`
- `docs/query-canon.md`
- `docs/repository-spec.md`
- `packages/core/README.md`
- `packages/mcp-server/README.md`
