# narrarium-sdk

Dedicated TypeScript SDK package for loading, editing, and pushing Narrarium repositories over GitHub or Azure DevOps.

`narrarium` remains the lower-level base package. `narrarium-sdk` re-exports the remote SDK surface on top of it so npm consumers can install a focused package.

## Install

```bash
npm install narrarium-sdk
```

## Includes

- `BookManager`
- `GitHubRemoteProvider`
- `AzureDevOpsRemoteProvider`
- `NarrariumApiClient` for calling the server endpoints exposed by `Narrarium.Sdk.AspNetCore`
- profile stores for memory and localStorage
- in-memory book snapshots and workspaces
- high-level workspace helpers for chapters, paragraphs, and characters
- markdown snapshot builders and serializers for Narrarium documents

## Quick example

```ts
import {
  BookManager,
  GitHubRemoteProvider,
  LocalStorageBookProfileStore,
} from "narrarium-sdk";

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
workspace.upsertCharacter({
  slug: "lyra-vale",
  frontmatter: {
    type: "character",
    id: "character:lyra-vale",
    name: "Lyra Vale",
    canon: "draft",
    tags: [],
    refs: [],
    sources: [],
    historical: false,
    secret_refs: [],
    aliases: [],
    former_names: [],
    identity_shifts: [],
    role_tier: "supporting",
    story_role: "other",
    traits: [],
    mannerisms: [],
    desires: [],
    fears: [],
    relationships: [],
    factions: [],
    timeline_ages: {},
  },
  body: "# Overview\n\nA careful broker.",
});

await manager.commitAndPush(profile, snapshot, workspace, {
  message: "Add Lyra character profile",
});
```

## Relationship with `narrarium`

- `narrarium`: base package with schemas, repo helpers, and shared SDK internals
- `narrarium-sdk`: focused remote SDK package for npm consumers
