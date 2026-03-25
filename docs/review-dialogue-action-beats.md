# Review Dialogue Action Beats Guide

`review_dialogue_action_beats` is a proposal-only editorial tool for final paragraph files in `chapters/`.

It reviews dialogue-adjacent action beats one by one instead of rewriting the entire scene in one pass.

## What it is for

Use it when you want to know whether an action beat:

- clarifies the speaker well
- adds tension, blocking, psychology, or subtext
- fits the character's canon profile
- should be tightened, replaced, removed, or turned into a simple `said` fallback

It can also suggest missing beats and low-confidence recurring tics worth observing for a character.

## Workflow

Typical flow:

1. read `paragraph_writing_context`
2. run `review_dialogue_action_beats`
3. inspect each beat proposal and decide which choices you want
4. apply only the confirmed selections with `apply_dialogue_action_beats`
5. if the beat changes affect continuity-sensitive material, review `state_changes`

## What it returns

- `reviewId`
- `paragraphHash`
- `previewBody`
- beat-level proposals with explicit `choiceId` values
- optional tic suggestions
- source files used for the pass

## What it does not do

- it does not write files
- it does not rewrite the whole paragraph blindly
- it does not auto-update character canon with tic suggestions

## Apply step

`apply_dialogue_action_beats` applies only the selected beat changes after confirmation.

It validates:

- `reviewId`
- `expectedParagraphHash`

If the paragraph changed after review, apply should be treated as stale and the review should be rerun.
