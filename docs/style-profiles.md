# Ghostwriter Profiles

Narrarium uses ghostwriters as its single prose-style model.

## Default profile

Every book selects a default ghostwriter in `book.md`:

```yaml
ghostwriter: default
```

The corresponding profile lives at `ghostwriters/default.md`. Narrarium creates and selects this profile automatically when it is missing.

A ghostwriter contains the complete prose contract, including:

- writing and punctuation style
- voice and tone
- person and tense expectations
- sentence rhythm and dialogue treatment
- vocabulary and influences
- strengths and patterns to avoid

## Overrides

Set `ghostwriter` in chapter or paragraph frontmatter to select another profile for that scope. Resolution order is explicit selection, paragraph, chapter, then book default.

## How writing context works

`chapter_writing_context` and `paragraph_writing_context` resolve the selected profile from `ghostwriters/` and combine it with the relevant point-in-time canon, summaries and draft context.

## Review flow

For paragraph review:

1. read `paragraph_writing_context`
2. run `revise_paragraph`
3. inspect the proposal
4. ask the user for confirmation
5. apply with `update_paragraph` only after confirmation

The same selected ghostwriter guides drafting, revision and review. Standalone writing-style and punctuation-style files are not part of the active model.
