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

The branch of the book on the screen is in the top bar, next to the sync pill. It opens the **branch switcher**: the current branch and what concerns it, every branch you worked on (the newest first) and the other branches GitHub has, found by typing and opened with the arrows and Enter. Each branch keeps its own working copy on this device, so switching never loses anything: the work on a branch stays on that branch.

- **A new branch is one action.** The switcher suggests a name (`draft/<today's date>`); a few words become `feature/<your-words>`. The branch is made on this device from the current one, with what it has now, and opens at once, also without GitHub. It is published on GitHub by the next sync, or at once with **Publish it on GitHub now**. If GitHub already has a branch with that name and other changes, nothing is published or overwritten: create one with another name.
- **Branches follow you.** The branch you worked on last, and every branch you worked on, are kept in your account data (the copy that syncs: Google Drive, OneDrive or `narrarium.settings`), names and dates only. Another device opens the book on the branch you used last and says so; if that branch is not on GitHub (or not yet) and not on that device, the book stays on the branch it had, and the message names both.
- **In the GitHub tab** of the book settings, **Branches and automatic sync** shows the last branch and every branch you worked on. **Rename** gives a branch a name in this list only, **Forget** takes it out of the list (the branch on GitHub and its copy on this device stay), and **Keep in sync** chooses: with the most recent, always, or never by itself. A book kept on this device has a **Name of the branch** (`main` unless you choose another): a repository made for it, or an empty one, gets it as its default branch; a repository that already has commits keeps its branches.
- Copilot and the Git dialogs can also list branches, switch or create them, inspect diffs and commits, and create pull requests.

## Automatic sync

A GitHub book syncs by itself, as you choose in **Settings › Local repositories** for every book, and per book in the switcher and in the GitHub tab: **Off**, **When the book opens and when you come back to it** (the default), or **Also every 5 minutes**.

- It only does what cannot lose or merge anything: it brings GitHub's changes into a branch that has nothing unpublished, and publishes this device's changes (committed with the same message as Sync) only when GitHub did not change meanwhile. When both changed, nothing is overwritten: the button and a message say so, and **Sync now** opens the usual sync, which asks you about any file changed on both sides. A branch GitHub no longer has is never made again by itself.
- It syncs the branch on the screen first, then the four branches you used last and the ones you chose to keep in sync (ten at most). A branch you worked on elsewhere is brought to this device, downloading only the files that differ from the copies already here.
- It asks GitHub one question per book each time (the list of its branches), which costs nothing of GitHub's hourly limit when nothing changed. Near the limit it syncs only the branch on the screen, and stops until the hour starts again. It waits while the autopilot runs the book in the browser (also after a reload, until the autopilot resumes by itself), does not bring changes into a page you are editing, and only brings changes while your personal server runs the book. One tab of the browser syncs for all the others.
- Without a GitHub credential or offline it does nothing, and the menu of the pill says why. The same menu says when the last automatic sync happened and what it did: what it brought from GitHub, what it published, nothing to do, or what needs your attention.

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
| Turn on GitHub Pages | `repo` | Pages and Administration: Read and write | Pages: write, if the app has it; otherwise turn it on at github.com, or use a token |
| Delete a repository | `delete_repo` | Administration: Read and write | not with the app: delete it at github.com, or use a token |

- With the GitHub app, what happens when a permission is missing is told in words: Narrarium names the permission to give the app (for example **Repository creation** to create a repository, **Workflows** to add the Pages workflow) and offers the way out that always works: create the empty repository on github.com yourself, then connect it. A repository the app creates is reachable at once only if the app has the creation permission; if it is not, the card shows the install step.

- A classic token shows its scopes to Narrarium, which reads them before it creates a repository and warns you if one is missing. GitHub does not say in advance what a fine-grained token can do: Narrarium tries, and explains any refusal in words.
- A fine-grained token that only selects some repositories cannot create a new one or use it at once: choose **All repositories** for that. A fine-grained token has one owner: to work in an organization, make the organization its **Resource owner**.
- Organizations with single sign-on need the token authorized for them (**Configure SSO**). A refusal for that reason is reported as such.
- When GitHub's limit on requests is reached, Narrarium stops and tells you at what time to try again; it never retries on its own.

## Reader access: passwords and GitHub Pages

In **Book Settings**, a book on GitHub has an **Reader access** card. It turns GitHub Pages on or off for the book, lists the passwords that open the published reader, adds and removes them, and shows how the last publication went. A book with no password is public: anyone with the address can read it.

- **Add a password** with a label (who it is for) and either a generated password or one you type; the card reads its strength and warns that the encrypted book is published at a public address, so anyone can download it and try passwords on their own computer: use a long random password, like the generated ones. **Remove** takes it away: the reader stops accepting it the next time it is published, and what someone already read or saved with it cannot be taken back.
- GitHub never shows the value of a secret, so Narrarium keeps the passwords in the account data it already syncs (your Google Drive, OneDrive or the private `narrarium.settings` repository), masked until you press **Show**, with a **Copy** button. They are never in the book, in an export, in an AI request or in a log. A password that exists on GitHub but was not made here, and the older single password of a book, are listed as such and can only be removed.
- Every change goes to GitHub in an order that never leaves the published reader pointing at a secret that is not there: adding writes the secret, then lists it in the repository variable `READER_PASSWORD_SECRETS`, then starts the publishing workflow; removing first takes the name off the variable, then deletes the secret, then starts the workflow. The secrets are `READER_PASSWORD_001`, `READER_PASSWORD_002`, and so on. If a step fails the card says which one, what is already done, what the published reader is doing, and offers to try again.
- **Turn off Pages** asks for confirmation. By default the workflow and the passwords stay, so that turning Pages on again publishes with the same ones. A second, separate choice also deletes the password secrets and the variable on GitHub, and a third, again separate, forgets the passwords kept in Narrarium.
- A private repository's Pages site is still reachable by its address on GitHub plans without access control for Pages: the encryption is the only protection. Revoking a password stops everything published afterwards, not what was already read.

- **From the start.** When you create a book on GitHub (or connect one that lives on this device) with **Also turn on GitHub Pages**, you choose **Protected by a password** (the default) or **Public reader**. A protected reader gets a strong first password made for you, shown with **Show** and **Copy** and kept in your Narrarium account. It is put on GitHub right after the repository and Pages exist and before the Pages workflow is added, so that the very first publication already asks for it. If that cannot be done, the workflow is held back: nothing is published, nothing is public, and the result says why and offers to try again. The choice appears only when the reader that the book gets can read passwords.

- **Update the reader.** A book whose reader was published before the passwords with several slots (its workflow does not name `READER_PASSWORD_SECRETS`, or its `reader/` folder is older) is told so, in plain words, in the **Online reader** tab and in the status of the **GitHub** tab. Published with a password and an old reader, a book still exposes its EPUB (`downloads/book.epub`) and the titles of its chapters in clear; updating fixes it. **Update the reader** makes one visible commit on the working branch, never silently: the workflow written by the reader package (the single password you use today stays valid as one of the passwords) and the files of `reader/` from the template the site carries. Your own files are never touched; a workflow with edits of yours shows the lines that differ and needs an explicit **Replace my edits**. The commit goes through the working copy on this device and is published with the book's credential; offline, or without a credential, it stays on this device and publishes at the next sync, and the card says that the published site stays as it is until then. After publishing, the card follows the run and offers **Check from outside**: the address `<pages address>/downloads/book.epub` must answer 404 and `version.json` must say the reader is protected (when the browser cannot read the answer, the card gives the `curl` line to copy).
- **When the update is only on this device.** The card compares the working copy on this device with GitHub: if the workflow or `reader/` are updated here but GitHub still has the old ones (or the changes are in local commits not sent yet), it says **Updated on this device, not yet on GitHub**, never "up to date". **Sync now** sends them as the Sync button does and keeps the reason when GitHub refuses (for example a missing **Workflows** permission, which is told as such, or two copies of a file to choose between). While the published reader is the old one and Pages is on, **Turn GitHub Pages off** takes the site down at once, with the workflow and the passwords kept.
- **When a publication fails.** The card and Reader access name the cause from the annotation of the failed job: the **Actions budget or billing** (with the link to GitHub billing; a job that never started builds nothing, so the published site stays as it was), Actions disabled, a missing permission, or GitHub's own message. Making the repository public gives free minutes but publishes everything in it: do not do it only for this.

## Make the repository public or private

In **Book Settings → GitHub**, the **Repository visibility** card shows whether the repository of the book is public or private (read from the repository, not guessed) and offers **Make public** or **Make private**. It is an action on GitHub, so it needs a connection: offline it is explained and never queued.

- **It needs a permission.** The GitHub app needs **Administration: Read and write**, and only this action needs it: leave it off if you never change a visibility. If the installation does not have it, the card says so and links to the app on GitHub; with a personal access token it is the `repo` scope (classic) or **Administration: Read and write** (fine-grained), and you must be an administrator of the repository. Any refusal is explained (a missing permission, or GitHub's own words for a rule of the organization or the enterprise).
- **Making it public** asks you to type the name of the repository and says what becomes readable by anyone: the whole history, the drafts, the notes, the settings of the book, and what Narrarium keeps in the repository (`secrets/`, `director.md`, `conversations/`, `drafts/`, with the number of files this device sees). That cannot be undone for what is copied meanwhile. If the book has passwords for its online reader, the card says they protect only the reader's encrypted content on GitHub Pages, not the repository.
- **Making it private** says what happens to GitHub Pages (on many plans a private repository is not served) and to Actions minutes, then reads the repository and the Pages state again and tells you what GitHub says.

### Permissions this needs

The token a book uses (the GitHub app, or a personal access token) needs these repository permissions, all **Read and write** (Metadata: Read is always there):

| Permission | What it is for |
| --- | --- |
| Secrets | write and delete the password secrets, and read their names |
| Variables (Actions variables) | the variable that lists them |
| Actions | start the publishing workflow and read its runs |
| Pages | turn Pages on and off, and read its address |
| Contents and Workflows | read and update the reader workflow file |
| Checks (read only) | read why a publication failed: GitHub explains a job that never started only in its annotation |
| Administration (the app: only to change the visibility) | make a repository public or private |

When GitHub refuses a step, the card names the permission that is missing (it reads GitHub's `X-Accepted-GitHub-Permissions` header when there is one) and says where to add it:

- **GitHub app:** the app's permissions are set by whoever runs the app (GitHub › Settings › Developer settings › GitHub Apps › the app › Permissions & events › Repository permissions). After they change, each installation has to accept the new permissions (GitHub › Settings › Applications › the app, or the request GitHub sends). Until then, use a personal access token.
- **Fine-grained token:** GitHub › Settings › Developer settings › Personal access tokens › Fine-grained tokens › the token › Repository permissions: set Actions, Contents, Pages, Secrets, Variables and Workflows to **Read and write**, then save.
- **Classic token:** the `repo` scope, and `workflow` to change the workflow file.

## Creating a repository from a book

The same creator is used by **Add Book** (a new book on GitHub) and by **Book Settings → Connect this book to GitHub** (a book that lives on this device). It makes the repository, sends the book's files in a first commit and the Pages workflow in a second one, and, when you ask, turns on GitHub Pages. If the token cannot write workflows or turn on Pages, the repository is kept and the result page shows the steps to do by hand: see *Create your first book*.

## A book on your personal server

When your personal server runs the autopilot of a GitHub book, it publishes its commits to GitHub and brings in yours before every step. If you and the server changed the same file, the autopilot stops and you choose which version to keep: see *Conflicts with GitHub* in the Autopilot guide.

The server keeps a copy of the book's token (with your consent when you move the book) and cannot renew the GitHub app's 8-hour token: **App tokens last 8 hours; for a book your server runs, use a personal access token (or keep the browser open).** Narrarium warns you when you move such a book and in its settings. While a browser with Narrarium is open it sends the server the fresh token each time it renews it (never the refresh token); a personal access token does not have this limit.
