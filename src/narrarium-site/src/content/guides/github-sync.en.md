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

## Two ways to sign in to GitHub

In **Account & Sync**, the GitHub card offers both, and you can use either or both:

- **Connect with GitHub** (recommended, when this site has it). Narrarium's GitHub app signs you in: there is no token to paste. GitHub asks you once; the sign-in is kept by the credential broker, which renews it by itself, and it is never part of your synced settings. The app reaches only the repositories you give it, so after signing in you also **install** it: **Choose repositories on GitHub** opens the page where you pick all your repositories or only some. The card then says where the app is installed, **Check again** reads it again after you come back from GitHub, and a book whose repository is not among them is named, with the same button. For an organization, an owner of the organization has to install or approve the app; if it requires single sign-on (SAML), start your SAML session on GitHub first. The app's token lasts 8 hours and is renewed in the background; if the sign-in lapses, the card says **Reconnect GitHub** and nothing is lost. **Disconnect** also revokes the app's access at GitHub, on every device. If the card says sign-in with GitHub is not enabled on this site yet, use a token: nothing else changes.
- **A personal access token (advanced)**. It does not expire by itself and works for every repository it was given, in any account or organization. Prefer it when a personal server runs your books, when you use several GitHub accounts, or when your organization does not allow the app. Create it as shown in *Create your first book*.

Your books keep working as they are: a token you saved for a book, a named token or the default token always win over the connection. The card shows, for each book, which token it uses (its own token, a named one, the default one, or your GitHub connection), and one switch, **Prefer the GitHub connection over the default token**, puts the connection ahead of the default token for the books that have no token of their own. The same line is in each book's settings.

With the app connected, the same list also offers a book that uses its own token, a named token or the default token the button **Use the GitHub connection**, when the app is installed on that book's repository. Narrarium first checks with the connection that it can read and write the repository, and only if that works does it let go of the book's own token; otherwise nothing changes. Nothing is switched by itself, and a book run by your personal server is not offered the move, because the server cannot renew the app's token. When no book needs the default token any more, the card offers **Remove the default token**, after a confirmation.

## Your settings in a private repository

When you connect GitHub, with the app or with a token, your account settings sync by themselves to **narrarium.settings**, a private repository of your GitHub account that Narrarium creates the first time and keeps up to date. If you switched account sync off on the card, it stays off. With the app, GitHub may refuse to create the repository, or the app may not be installed on one that already exists: the card then says so, with **Choose repositories on GitHub** and a **Try again** button, and nothing is retried on its own. You can also create `narrarium.settings` yourself as a private repository, or connect with a token instead. When the copies differ (this device, GitHub, Google Drive, OneDrive), Narrarium shows when each was last changed, selects the newest and waits for you to confirm with **Use the newest copy**: nothing is overwritten before that, and the other copies stay a choice away.

## Permissions per token type

Each thing Narrarium does on GitHub needs a permission of the token. If a permission is missing, GitHub refuses that one action and Narrarium tells you which one; the rest keeps working.

| Action | Classic token | Fine-grained token | GitHub app (Connect with GitHub) |
| --- | --- | --- | --- |
| Clone, pull and read the book | `repo` (private) or `public_repo` | Contents: Read, Metadata: Read | Contents and Metadata: Read, on the repositories it is installed on |
| Commit and push, branches | `repo` | Contents: Read and write | Contents: Read and write |
| Pull requests | `repo` | Pull requests: Read and write | Pull requests: Read and write |
| Create the repository | `repo` | Administration or Repository creation: Read and write | Repository creation (or Administration): write |
| Write `.github/workflows/*` | `workflow` | Workflows: Read and write | Workflows: Read and write |
| Turn on GitHub Pages | `repo` | Pages and Administration: Read and write | not with the app: turn it on at github.com, or use a token |
| Delete a repository | `delete_repo` | Administration: Read and write | not with the app: delete it at github.com, or use a token |

- With the GitHub app, what happens when a permission is missing is told in words: Narrarium names the permission to give the app (for example **Repository creation** to create a repository, **Workflows** to add the Pages workflow) and offers the way out that always works: create the empty repository on github.com yourself, then connect it. A repository the app creates is reachable at once only if the app has the creation permission; if it is not, the card shows the install step.

- A classic token shows its scopes to Narrarium, which reads them before it creates a repository and warns you if one is missing. GitHub does not say in advance what a fine-grained token can do: Narrarium tries, and explains any refusal in words.
- A fine-grained token that only selects some repositories cannot create a new one or use it at once: choose **All repositories** for that. A fine-grained token has one owner: to work in an organization, make the organization its **Resource owner**.
- Organizations with single sign-on need the token authorized for them (**Configure SSO**). A refusal for that reason is reported as such.
- When GitHub's limit on requests is reached, Narrarium stops and tells you at what time to try again; it never retries on its own.

## Creating a repository from a book

The same creator is used by **Add Book** (a new book on GitHub) and by **Book Settings → Connect this book to GitHub** (a book that lives on this device). It makes the repository, sends the book's files in a first commit and the Pages workflow in a second one, and, when you ask, turns on GitHub Pages. If the token cannot write workflows or turn on Pages, the repository is kept and the result page shows the steps to do by hand: see *Create your first book*.

## A book on your personal server

When your personal server runs the autopilot of a GitHub book, it publishes its commits to GitHub and brings in yours before every step. If you and the server changed the same file, the autopilot stops and you choose which version to keep: see *Conflicts with GitHub* in the Autopilot guide.

The server keeps a copy of the book's token (with your consent when you move the book) and cannot renew the GitHub app's 8-hour token: **App tokens last 8 hours; for a book your server runs, use a personal access token (or keep the browser open).** Narrarium warns you when you move such a book and in its settings. While a browser with Narrarium is open it sends the server the fresh token each time it renews it (never the refresh token); a personal access token does not have this limit.
