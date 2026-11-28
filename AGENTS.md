# Narrarium Agent Rules

Use Narrarium as a book-writing framework where the repository is the source of truth.

## Default workflow

1. Search canon before inventing new facts.
2. Prefer Narrarium MCP tools over ad-hoc filesystem edits when creating or updating book structure.
3. Use rich creation tools for major canon files:
   - `create_character`
   - `create_location`
   - `create_faction`
   - `create_item`
   - `create_secret`
   - `create_timeline_event`
4. If the brief is incomplete, start a guided flow with:
   - `start_wizard`
   - `wizard_answer`
   - `wizard_finalize`
5. After significant structural changes, refresh maintenance files:
   - `sync_plot`
   - `sync_resume` or `sync_all_resumes`
   - `evaluate_chapter` or `evaluate_book`

Narrarium MCP already auto-refreshes `plot.md` and the resume files after final chapter or paragraph mutations. Evaluations remain manual unless explicitly requested.

## Versioning and patch notes

- Every application change that is committed and pushed must bump `src/narrarium-site/package.json` and the root lockfile version according to the repository release workflow.
- Before the version bump is committed, add a matching entry to `src/narrarium-site/src/content/patch-notes.json`.
- Every patch-note entry must contain a title, summary, and non-empty change list in both English (`en`) and Italian (`it`).
- Patch notes must describe user-visible behavior and navigation, not only internal implementation details.
- Never commit or push a Narrarium site version without a matching bilingual patch note. `npm run bms:build` enforces this rule.
- The site keeps a snapshot of what the real book scaffolder writes (`src/narrarium-site/src/narrarium/bookTemplate.generated.json`, used to create complete book repositories on GitHub). Whenever `packages/core`, `packages/astro-reader` or `packages/create-narrarium-book` change what a new book contains, or the core version changes (the reader pins it), regenerate it with `npm run template:generate -w narrarium-site` (after `npm run build:cli -w narrarium-astro-reader && npm run build -w create-narrarium-book`) and commit it; the site's tests and build fail on a stale snapshot.
- After each versioned commit, push `main` and monitor the `Deploy Narrarium Site` GitHub Actions workflow until completion, unless the user explicitly requests otherwise. That run holds the full checks of the commit (see Release lanes); a push outside its paths is checked by `CI`.
- `narrarium-server` is released only by pushing a `narrarium-server-v<version>` tag after bumping `packages/server/package.json` and `packages/server/src/version.ts` together; the `Publish narrarium-server` workflow publishes it through npm Trusted Publishing with provenance. Apart from the one-time bootstrap publish of `0.1.0` described in `packages/server/README.md`, never publish it by hand or add it back to the generic publish workflow: the server's updater installs only releases attested by that workflow.

## Release lanes

Every run of `Deploy Narrarium Site` first decides its lane (`scripts/release-lane.mjs`; `npm run release:lane -- --base <ref>` tells it locally). The full checks are one reusable workflow (`.github/workflows/checks.yml`: dependency policy; packages build, types and tests; site typecheck and unit tests; site component tests in four shards with one coverage gate over all of them; E2E in three shards; GitHub Pages basename). `CI` runs them for pull requests and for the pushes to `main` that the deploy does not check (its `paths-ignore` is the deploy's `paths`), so a commit is never checked twice for nothing and never not at all.

- **Full lane (the default).** A push without the trailer, and every push the quick lane refuses: the site is published only after the full checks pass. Required for features, the engine, the server, core, the reader, any published package, workflows and scripts, accounts, authentication and security, dependencies, and whenever in doubt. Before pushing, run the full check as today: `npm run release:check` and both E2E suites on the exact commit.
- **Quick lane.** A small, already reviewed fix of the site (a wrong text or translation, a style, a contained bug in a component), docs or patch notes. Put a `Fast-Track: <reason>` trailer in the last paragraph of the head commit message of the push, and run `npm run check:quick` before pushing (typecheck, the site's unit tests, the component tests related to the changed files, the production build with its bundle budgets, the smoke E2E and the basename routing: a few minutes; it refuses the same changes the lane refuses). The deploy then publishes after the same quick checks, while the full checks run in the same run: when they fail after the publication, fix forward at once or roll back. The trailer is refused, with a warning in the run, and the push takes the full lane, when the push touches `packages/**` (engine, server, core, reader, every published package and its README), `.github/**`, `scripts/**`, the configuration of the checks (`playwright.config.ts`, the site's Vite, Vitest and TypeScript configuration, `src/narrarium-site/scripts/`, `e2e/helpers/`), authentication or security code (`src/narrarium-site/auth/`; in `src/narrarium-site/src/`: `auth/`, `account/`, `github/`, `readerAccess/`; the CSP and the sign-in callbacks; any file named for auth, tokens, credentials, secrets, crypto, passwords, permissions or sanitizing), another service (`src/auth-proxy/`, `api/`, `vercel.json`), a dependency (any `package.json` change besides its version, any lockfile change besides the workspace versions), or when the changed files cannot be known (a new branch, a force push). The site's version bump and bilingual patch note are required as in every lane.
- **Express lane (manual, no tests).** `gh workflow run book-management-system.yml --ref main -f fast_track=true` builds and publishes the tip of `main` without any test. Only for texts, docs, translations and patch notes already reviewed, and for a rollback; never for code. It is never automatic.
- **Rollback.** `gh workflow run book-management-system.yml --ref main -f fast_track=true -f ref=<sha>` publishes again a commit that `main` already has (the run refuses any other, and refuses a `ref` without `fast_track`), as it was verified when it went live. Then fix forward: the next push publishes the tip again.
- A run of any branch other than `main` (for example a `workflow_dispatch` of a test branch) runs its checks and builds the site, but never publishes: the publication job runs only for `refs/heads/main`, and the `github-pages` environment accepts `main` only.
- The release rules of `narrarium-server` do not change with the lanes: the tag, the attested `Publish narrarium-server` workflow and the `Personal server` matrix.

## Canon discipline

- Do not duplicate canon if the fact already exists in another markdown file.
- Keep structured facts in frontmatter and prose in markdown body.
- In chapter and scene prose, write character, item, location, faction, secret, and timeline-event names as plain text. Do not insert markdown links to canon files or reader routes; the reader will link visible canon mentions.
- Do not reveal a secret before its `known_from` or `reveal_in` threshold.
- A frozen chapter (a `frozen` record in its `chapter.md`) that was changed after it was approved must never be ignored: ask the author whether to review it (autopilot: `frozenStatus` / `resolveFrozenChange`).
- Treat `guidelines/`, `drafts/`, `plot.md`, `conversations/`, `resumes/`, `evaluations/`, and `secrets/` as first-class context, not optional notes.
- Treat `director.md` (the director profile: the author's stand-in) and `evaluations/director/` as first-class context when judging or revising prose.
- `outline/` (the Synopsis, «Sinossi», once called the Scaletta: `outline/book.md` and one `outline/chapters/<NNN>.md` per chapter, with hypothetical title, what happens and ghostwriter) is the author's chapter-by-chapter plan of the book: the autopilot follows it as binding and only fills the entries that are missing (`origin: autopilot`). It is not `plot.md`, which is generated: to change the plan, change the outline.
- `autopilot/state.json`, `autopilot/activity.json`, and `autopilot/plan.md` belong to the autopilot. Read them for context, but do not edit them while an autopilot run is active; change the autopilot through its interventions instead.

## Historical or factual content

- If a request is historical, factual, or based on a real place, use Wikipedia research first.
- Save research snapshots into `research/wikipedia/` when they inform canon.

## Chapter and scene updates

- Use `create_chapter` and `create_paragraph` for new structure.
- After creating or updating any file in `scripts/**/*.md`, run `sync_script_ledger` or `npm run sync:script-ledger -- <book-root>` and inspect reported errors or warnings.
- Use `create_chapter_draft` and `create_paragraph_draft` for rough scaffolding before final prose.
- Use `chapter_writing_context` and `paragraph_writing_context` before drafting polished prose from rough material.
- Use `resume_book_context` when restarting work from exported conversation history or a fresh session.
- Use `update_chapter` and `update_paragraph` for existing files.
- Use `update_chapter_draft` and `update_paragraph_draft` when refining rough material.
- Use `create_chapter_from_draft` and `create_paragraph_from_draft` when turning rough drafts into final story files.
- Avoid renumbering or renaming chapter and paragraph files unless the user explicitly asks for structural migration.
- Before writing new chapter or paragraph prose, read the selected `ghostwriters/<slug>.md` profile, the relevant prior story context, and any matching draft files. Resolve the selection from paragraph, chapter, then `book.md`.
- Keep `plot.md` updated whenever chapter progression, timeline anchors, or reveal timing changes.
- Before planning or writing a chapter, read its entry in `outline/chapters/` and follow it (title, events, ghostwriter); an entry you write or edit on the author's behalf is `origin: author`, without `digest`, and the autopilot never overwrites it.

## Reader and publishing

- Use `npm run create:book` to scaffold a new book repository.
- Use `npm run reader:init` or `narrarium-reader-init` to scaffold a standalone reader app.
- Keep package naming aligned with the public package set:
  - `narrarium`
  - `narrarium-sdk`
  - `narrarium-mcp-server`
  - `create-narrarium-book`
  - `narrarium-astro-reader`
  - `narrarium-engine`
  - `narrarium-server`
- Autopilot, director, simulated readers, and personal-server sync live once in `packages/engine` (`narrarium-engine`). The web app and `narrarium-server` only provide adapters (book store, AI port); never duplicate that logic in either host.
- Every AI call of the web app, the Copilot included, goes through the engine's client (`createFetchAi`, in the site through `createBrowserAi`): streaming, the three deadlines, thinking and the debug and cost records are the engine's. Never add a second path with its own SDK or timers.
- A series of edits of the Synopsis (`outline/`) is composed by the engine (`composeOutlineEdits`), and what happens when the entry of a written chapter changes is `changeOfWritten`: the site and the server call them and never copy them.
