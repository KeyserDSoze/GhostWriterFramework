# Chapter Style Profiles

Narrarium supports book-level prose defaults with explicit chapter-level style overrides.

That means:

- if a chapter does not declare a style override, the book default applies
- if a chapter should sound different, it must say so explicitly
- the agent should not guess that a chapter wants a different style

## Default vs override

The default writing voice for a book lives in:

- `guidelines/prose.md`
- `guidelines/style.md`
- `guidelines/voices.md`
- `guidelines/chapter-rules.md`

These files define the book-level baseline.

If a chapter needs something different, declare it in chapter frontmatter.

## Chapter frontmatter fields

Use these fields on `chapters/<slug>/chapter.md` or `drafts/<slug>/chapter.md`:

- `style_refs`: explicit style profile ids to load
- `narration_person`: first, second, third, or another declared mode
- `narration_tense`: past, present, future, or a declared custom label
- `prose_mode`: explicit prose behaviors such as `show-dont-tell`, `tight-interiority`, or `descriptive-wide-lens`

Example:

```yaml
style_refs:
  - style:first-person-show
narration_person: first
narration_tense: past
prose_mode:
  - show-dont-tell
  - tight-interiority
```

## Where style profiles live

Explicit style profiles live in `guidelines/styles/`.

They are normal guideline markdown files with ids such as:

- `style:first-person-show`
- `style:third-person-descriptive`

Narrarium scaffolds two starter examples:

- `guidelines/styles/first-person-show.md`
- `guidelines/styles/third-person-descriptive.md`

You can replace, rewrite, or add more profiles for your own book.

## How writing context works

`chapter_writing_context` and `paragraph_writing_context` now do this:

1. read the default book-level prose and style guides
2. inspect the chapter frontmatter and draft frontmatter
3. if explicit chapter style fields exist, surface them as the effective style
4. load any referenced style profile files from `guidelines/styles/`

This makes the override visible and auditable.

If no explicit override exists, the context says so clearly and falls back to the default book-level rules.

## Recommended workflow

Use the default book-level guides for most chapters.

Only declare a chapter override when the difference matters structurally, for example:

- a confessional first-person chapter inside a mostly third-person book
- a chapter with intentionally wider, more descriptive narration
- a chapter that should be unusually sparse, clipped, or interior

Recommended flow:

1. define the global default in `guidelines/prose.md`, `guidelines/style.md`, and `guidelines/voices.md`
2. create a style profile in `guidelines/styles/` if a recurring alternate mode is needed
3. reference it explicitly in chapter frontmatter
4. use `chapter_writing_context` or `paragraph_writing_context` before drafting or revising prose

## Example patterns

### First-person, show-don't-tell chapter

```yaml
style_refs:
  - style:first-person-show
narration_person: first
narration_tense: past
prose_mode:
  - show-dont-tell
  - tight-interiority
```

### Third-person, descriptive chapter

```yaml
style_refs:
  - style:third-person-descriptive
narration_person: third
narration_tense: past
prose_mode:
  - descriptive-wide-lens
  - slower-pacing
```

## Limits

Style profiles guide drafting and revision context, but they do not automatically rewrite chapters on their own.

They become most useful when combined with:

- `chapter_writing_context`
- `paragraph_writing_context`
- `revise_paragraph`
- `revise_chapter`

## Related docs

- `docs/repository-spec.md`
- `docs/revise-paragraph.md`
- `docs/revise-chapter.md`
