# Writing Style Guide

Narrarium now uses a simpler writing-style model.

## Primary file

The main always-on writing and review contract for a book lives in:

- `guidelines/writing-style.md`

This file should contain everything the model needs while drafting or revising prose, including:

- narration rules
- dialogue rules
- person and tense expectations
- scene rhythm
- show vs tell balance
- review constraints
- what to preserve during revision
- what to improve during revision

## Chapter-specific overrides

If a chapter needs a local exception or addendum, add one of these files:

- `chapters/<slug>/writing-style.md`
- `drafts/<slug>/writing-style.md`

These chapter-local files are layered on top of the global `guidelines/writing-style.md`.

## How writing context works

`chapter_writing_context` and `paragraph_writing_context` now do this:

1. read `guidelines/writing-style.md`
2. read the chapter-specific `writing-style.md` if it exists in the final chapter or draft folder
3. read the relevant point-in-time canon and draft context

This means the writing style is always visible during both drafting and revision.

## Review flow

For paragraph review:

1. read `paragraph_writing_context`
2. run `revise_paragraph`
3. inspect the proposal
4. ask the user for confirmation
5. apply with `update_paragraph` only after confirmation

The same global and chapter-local writing-style files should guide both writing and review.

## Legacy note

Older repositories may still contain:

- `guidelines/prose.md`
- `guidelines/style.md`
- `guidelines/voices.md`
- `guidelines/chapter-rules.md`
- `guidelines/styles/`

Those are now considered legacy. New repositories should rely on `guidelines/writing-style.md` plus optional chapter-local `writing-style.md` files instead.
