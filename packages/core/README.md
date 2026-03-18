# narrarium

Core Narrarium helpers for local-first book repositories.

## Includes

- repository scaffolding and managed book structure
- markdown frontmatter schemas and rich canon templates
- canon search, related-link discovery, and validation
- draft promotion, plot sync, and resume or evaluation helpers
- manual story-state sync helpers built from chapter resume deltas
- `doctorBook()` checks for broken references, spoiler thresholds, asset metadata, and stale maintenance files
- EPUB export helpers with opening matter, scene navigation, and optional canon index generation

## Install

```bash
npm install narrarium
```

## What it does

- scaffold the canonical book repository structure
- validate markdown frontmatter and file placement
- create rich canon files for characters, locations, factions, items, secrets, and timeline events
- create and update chapters, scenes, chapter drafts, and paragraph drafts
- answer natural-language canon questions with `queryCanon()`
- propose targeted scene revisions with `reviseParagraph()` without writing files yet
- propose chapter-level editorial plans with `reviseChapter()` without mutating files
- sync `plot.md`, chapter resumes, and total resume files
- sync `state/current.md`, `state/status.md`, and `state/chapters/` from `state_changes`
- export the book to EPUB
- diagnose repository drift with `doctorBook()`

## Quick example

```js
import {
  initializeBookRepo,
  createCharacterProfile,
  createChapter,
  createParagraph,
  doctorBook,
} from "narrarium";

await initializeBookRepo("my-book", {
  title: "My Book",
  author: "Author Name",
  language: "en",
});

await createCharacterProfile("my-book", {
  name: "Lyra Vale",
  roleTier: "main",
  speakingStyle: "Measured and observant.",
  backgroundSummary: "Raised in covert trade circles.",
  functionInBook: "Primary viewpoint anchor.",
});

await createChapter("my-book", {
  number: 1,
  title: "The Arrival",
});

await createParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  number: 1,
  title: "At The Gate",
});

const report = await doctorBook("my-book");
console.log(report.ok, report.issues);
```

## Hidden canon and assets

- use `known_from` and `reveal_in` to mark when canon is safe for public reader views
- use `secret_refs` and `private_notes` for author-facing hidden canon
- store asset metadata in markdown beside images and prefer `alt_text` plus `caption` so web and EPUB output stay accessible

## Remote book manager foundations

`narrarium` now also exports the first SDK foundations for remote book access:

- `BookManager` as the high-level entry point
- `LocalStorageBookProfileStore` and `InMemoryBookProfileStore` for connection profiles
- `NarrariumBookWorkspace` for in-memory edits before commit and push
- `NarrariumRemoteProvider` so GitHub and Azure DevOps adapters can plug into the same flow
- `GitHubRemoteProvider` with real GitHub snapshot loading plus direct commit/push scaffolding
- `AzureDevOpsRemoteProvider` with matching Azure DevOps snapshot loading and direct push support
- high-level workspace helpers like `upsertCharacter`, `updateChapter`, and `updateParagraph`

Quick example:

```js
import {
  AzureDevOpsRemoteProvider,
  BookManager,
  GitHubRemoteProvider,
  LocalStorageBookProfileStore,
} from "narrarium";

const manager = new BookManager({
  profileStore: new LocalStorageBookProfileStore(),
  providers: [new GitHubRemoteProvider()],
});

const profile = await manager.createGitHubProfile({
  name: "Primary Book",
  owner: "your-org",
  repository: "your-book",
  branch: "main",
  token: "github-token",
});

const snapshot = await manager.loadBook(profile);
const workspace = manager.beginWorkspace(snapshot);

workspace.updateChapter("chapter:001-the-arrival", {
  frontmatter: { title: "The Arrival Revised" },
});
workspace.updateParagraph("paragraph:001-the-arrival:001-at-the-gate", {
  body: "# Scene\n\nThe harbor measures every returning face.",
});
```

`GitHubRemoteProvider` can now resolve the branch head, read the Narrarium markdown tree, build a typed snapshot, and push workspace changes back with GitHub commits. `AzureDevOpsRemoteProvider` now supports the same load and direct push flow through the Azure DevOps Git REST API.

For Azure DevOps, register `new AzureDevOpsRemoteProvider()` and create a profile with `organization`, `project`, `repository`, `branch`, and PAT token.

## Story state and continuity

Narrarium keeps structured continuity separate from the narrative summaries:

- `resumes/chapters/*.md` stays readable and can include a `state_changes` frontmatter block
- `state/current.md` stores the latest consolidated continuity snapshot
- `state/chapters/*.md` stores the snapshot after each chapter
- `state/status.md` tracks whether story state is stale and why

Story mutations mark the state as stale, but they do not auto-sync the snapshots. That is deliberate: you decide when a rewrite is stable enough to refresh continuity state.

Typical flow:

```js
import {
  syncAllResumes,
  syncStoryState,
  updateParagraph,
} from "narrarium";

await updateParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  paragraph: "001-at-the-gate",
  body: "# Scene\n\nThe harbor watches before it welcomes.",
});

await syncAllResumes("my-book");
await syncStoryState("my-book");
```

You can also query the repository semantically:

```js
import { queryCanon } from "narrarium";

const result = await queryCanon("my-book", "What does Lyra know after chapter 4?");
console.log(result.answer);
console.log(result.sources);
```

Typical `queryCanon()` prompts:

- `Where is Lyra right now?`
- `What does Lyra know after chapter 4?`
- `What is Lyra's relationship with Taren?`
- `What condition is Lyra in?`
- `What open loops are still active?`
- `How does Lyra's relationship with Taren change between chapter 3 and chapter 8?`
- `How does Lyra's condition change between chapter 3 and chapter 8?`
- `What open loops change between chapter 3 and chapter 8?`
- `Who knows this secret?`
- `When does the brass key first appear?`

For exact control, `queryCanon()` also accepts `fromChapter`, `toChapter`, and `throughChapter` options.

See `docs/query-canon.md` for a fuller guide with use cases, scope rules, output fields, and limitations.

You can also run proposal-only editorial passes on a final paragraph:

```js
import { reviseParagraph } from "narrarium";

const revision = await reviseParagraph("my-book", {
  chapter: "chapter:001-the-arrival",
  paragraph: "001-at-the-gate",
  mode: "tension",
  intensity: "medium",
});

console.log(revision.proposedBody);
console.log(revision.editorialNotes);
console.log(revision.suggestedStateChanges);
```

See `docs/revise-paragraph.md` for the modes, continuity behavior, and manual apply workflow.

For broader chapter-level passes:

```js
import { reviseChapter } from "narrarium";

const revision = await reviseChapter("my-book", {
  chapter: "chapter:001-the-arrival",
  mode: "pacing",
  intensity: "medium",
});

console.log(revision.chapterDiagnosis);
console.log(revision.revisionPlan);
console.log(revision.proposedParagraphs);
```

See `docs/revise-chapter.md` for the chapter workflow and output model.

Narrarium also supports explicit chapter-level style overrides with a global book fallback. See `docs/style-profiles.md`.

Recommended `state_changes` keys inside chapter resumes:

- `locations`
- `knowledge_gain` and `knowledge_loss`
- `inventory_add` and `inventory_remove`
- `relationship_updates`
- `conditions`
- `wounds`
- `open_loops_add` and `open_loops_resolved`

See the root `README.md` and `docs/repository-spec.md` for the full repo model.
