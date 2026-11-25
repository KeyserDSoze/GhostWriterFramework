# Create your first book

## 1. Create a GitHub account

Create an account at [github.com](https://github.com). Narrarium stores each book as a GitHub repository.

## 2. Sign in to GitHub

There are two ways, and you can use either or both.

**Connect with GitHub (no token to paste).** Open **Account & Sync**, in the GitHub card choose **Connect with GitHub**, and sign in on GitHub. Then **install** the app: **Choose repositories on GitHub** opens the page where you pick all your repositories or only some; the card says where the app is installed, and **Check again** reads it after you come back. With the app, Narrarium can read and write the book, open pull requests, create the repository (the app needs the **Repository creation** permission) and add the Pages workflow (the app needs **Workflows**); it cannot turn on GitHub Pages or delete a repository: do those at github.com. If the card says sign-in with GitHub is not enabled on this site yet, use a token (below). The app's sign-in lasts 8 hours and renews itself; if it lapses the card says **Reconnect GitHub**.

**A personal access token (PAT), advanced.** It does not expire by itself, works in any account or organization, and is what to use when your personal server runs your books or you use several GitHub accounts. Open **GitHub → Settings → Developer settings → Personal access tokens** and choose one of the two kinds. What the token is allowed to do decides what Narrarium can do for you, so read the table before you create it.

| What Narrarium does | Classic token | Fine-grained token |
| --- | --- | --- |
| Read and write the book's files, branches and commits | `repo` | Contents: Read and write (Metadata: Read is added by GitHub) |
| Open and merge pull requests | `repo` | Pull requests: Read and write |
| **Create the repository** (your account or an organization) | `repo` (`public_repo` only for public repositories) | Administration: Read and write, or Repository creation: Read and write |
| **Add the GitHub Pages workflow** file | `workflow` | Workflows: Read and write |
| **Turn on GitHub Pages** | `repo` | Pages: Read and write, and Administration: Read and write |
| Delete an empty repository (only when you ask for it) | `delete_repo` | Administration: Read and write |

How much of the account the token can see matters as much as its permissions:

- **Classic token:** it works on every repository you can reach. For an organization that uses single sign-on, authorize the token for it (**Configure SSO** next to the token).
- **Fine-grained token, all repositories:** choose **All repositories** to let Narrarium create a new repository and use it at once. A token limited to **Only select repositories** cannot see a repository that does not exist yet, so it can connect a book that is already there but cannot create one.
- **Fine-grained token and organizations:** a fine-grained token belongs to one owner. To create in an organization, choose that organization as the **Resource owner** when you create the token; the organization must allow fine-grained tokens.

Copy the token immediately. GitHub will not show it again.

## 3. Configure the token

Only for a token: in Narrarium open **Settings → GitHub** and save the token as the default PAT, or add a dedicated PAT while connecting a book. A token you save for a book, a named one or the default one always win over the GitHub connection; **Account & Sync** shows which one each book uses.

## 4. Create or connect a book

Open **My Books → Add Book**.

- Choose GitHub as the storage, then pick one of the two modes of the repository:
  - **Connect an existing repository**: a searchable list of the repositories your credential can use (type to filter, arrow keys and Enter to pick; it reads a few at a time and loads more when you ask or when a search needs them). It shows whether each is private or public, whether you can write to it and when it was last pushed. What happens next depends on what you pick: a repository that is **already a Narrarium book** is added as it is (nothing in it is written); an **empty** one is filled with the new book; one with **other files** is never touched unless you turn on «Replace what is in the repository».
  - **Create a new repository**: choose its name (proposed from the title; if the name is taken you get the next free one), the **owner** (your account or an organization the token can create in), the **visibility** (private by default) and whether to turn on GitHub Pages. Before you start, a short list says what will be created and what the credential seems unable to do; it never blocks you.
- With the **GitHub app**, the list shows only the repositories the app is installed on. If the one you expected is missing, use «Change repositories on GitHub» (the app needs the permissions «Repository creation», «Contents» and «Workflows»), then reload the list.

### What the creator makes

A new repository holds the same files as a book made with the framework's own starter (`create-narrarium-book`):

- the book: canon files, notes, plot, the synopsis of the size you chose, the default ghostwriter and the simulated readers;
- the reader: an Astro site that shows the book, with the scripts to export an EPUB and a manuscript;
- the instructions for the writing assistants (OpenCode, Claude, Copilot) and the VS Code settings;
- the **GitHub Pages workflow**, sent as a second commit on its own.

The repository is created empty and filled in a few requests (the files go inline, not one request each). If something is refused, the repository is kept: it is never left half-made without telling you.

### What the creator does not do

- It does not install anything on your computer: the reader is built by GitHub Actions when the workflow runs.
- It does not turn on Pages for a **private** repository unless you ask for it: a free GitHub account cannot publish Pages from a private repository (make it public, or use a paid plan).
- It does not set the optional reader password, protect branches or invite people.
- It never deletes a repository by itself. If the first commit fails, the empty repository is still there and you choose: send the files again, or delete it (with a confirmation).

### When part of it could not be done

The result page says what was done and what was not. Nothing is lost; do the missing part by hand:

1. **The Pages workflow was not added** (the token has no *workflow* permission). Use the **Copy the workflow** button, open the repository on GitHub, choose **Add file → Create new file**, name it `.github/workflows/deploy-reader-pages.yml`, paste the text and commit it to the main branch. Or add the permission to the token (classic: `workflow`; fine-grained: *Workflows: Read and write*) and create the book again.
2. **Pages is not on.** On GitHub open the repository → **Settings → Pages** and set **Source** to **GitHub Actions**. Then open the **Actions** tab and wait for the run *Deploy Reader To GitHub Pages* to finish. The reader is at `https://<owner>.github.io/<repository>/`.
3. **The token cannot create repositories.** Create an empty repository on github.com and connect it: on a book that lives on this device, **Book Settings → Connect this book to GitHub** lets you pick the empty repository from the list (or an existing Narrarium book, which is added as a book of its own while the book of this device stays as it is).

The workflow does not cache npm: a repository made in a browser has no lock file, and the cache step would fail without one. The first run installs the packages from scratch, a few seconds slower.

## 5. Configure the book

Use **Book Settings** for the active branch, export metadata, paragraph separators, Drive destination and repository-specific credentials.
