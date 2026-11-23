# Git, branches and synchronization

Narrarium clones the active branch into an IndexedDB working copy. Editing writes locally first when the working copy is available.

## Repository status

- **Clean:** no local changes or unpushed commits.
- **Local changes:** files changed but not committed.
- **Ahead:** local commits waiting for push.
- **Remote changed:** GitHub has commits that are not local yet.
- **Sync incomplete:** the local clone has not been fully verified.

## Full sync

Full Sync reconciles remote changes, preserves or commits local work when possible, and pushes according to the configured policy. Use the repository status dialog for explicit Fetch, Pull, Commit, Push, backup, reclone and repair operations.

## Branches and pull requests

Each book can select an active branch. Copilot and the Git dialogs can list branches, switch/create branches, inspect diffs and commits, and create pull requests.

## Permissions per token type

Each thing Narrarium does on GitHub needs a permission of the token. If a permission is missing, GitHub refuses that one action and Narrarium tells you which one; the rest keeps working.

| Action | Classic token | Fine-grained token |
| --- | --- | --- |
| Clone, pull and read the book | `repo` (private) or `public_repo` | Contents: Read, Metadata: Read |
| Commit and push, branches | `repo` | Contents: Read and write |
| Pull requests | `repo` | Pull requests: Read and write |
| Create the repository | `repo` | Administration or Repository creation: Read and write |
| Write `.github/workflows/*` | `workflow` | Workflows: Read and write |
| Turn on GitHub Pages | `repo` | Pages and Administration: Read and write |
| Delete a repository | `delete_repo` | Administration: Read and write |

- A classic token shows its scopes to Narrarium, which reads them before it creates a repository and warns you if one is missing. GitHub does not say in advance what a fine-grained token can do: Narrarium tries, and explains any refusal in words.
- A fine-grained token that only selects some repositories cannot create a new one or use it at once: choose **All repositories** for that. A fine-grained token has one owner: to work in an organization, make the organization its **Resource owner**.
- Organizations with single sign-on need the token authorized for them (**Configure SSO**). A refusal for that reason is reported as such.
- When GitHub's limit on requests is reached, Narrarium stops and tells you at what time to try again; it never retries on its own.

## Creating a repository from a book

The same creator is used by **Add Book** (a new book on GitHub) and by **Book Settings → Connect this book to GitHub** (a book that lives on this device). It makes the repository, sends the book's files in a first commit and the Pages workflow in a second one, and, when you ask, turns on GitHub Pages. If the token cannot write workflows or turn on Pages, the repository is kept and the result page shows the steps to do by hand: see *Create your first book*.

## A book on your personal server

When your personal server runs the autopilot of a GitHub book, it publishes its commits to GitHub and brings in yours before every step. If you and the server changed the same file, the autopilot stops and you choose which version to keep: see *Conflicts with GitHub* in the Autopilot guide.
