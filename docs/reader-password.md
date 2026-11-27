# Reader Password Protection

Narrarium Reader supports AES-256-GCM build-time content encryption. When enabled, all prose is encrypted before the static site is generated. Visitors must enter the correct password in the browser before any text is revealed. The password never leaves the browser — all decryption runs client-side via the Web Crypto API.

A book is published either public (no password, nothing encrypted) or protected by one or several passwords. The passwords are repository secrets; the repository variable `READER_PASSWORD_SECRETS` lists their names. Adding or removing a password and publishing again is all it takes: a removed password stops opening the book from that publication on.

## What a protected build publishes

Only the reader and encrypted files:

- `index.html`, the shell: the reader's code, its labels and the title of the book, never a line of it;
- `version.json`: which build is current, where its bundle is, and the key slots;
- `content/<kind>-<hash>.bin`: the bundle of the book (compressed, then encrypted), its EPUB and its images, each encrypted.

Nothing else is published: the canon pages (characters, places, timeline...), `downloads/book.epub` and the files of `public/` are left out, and the build stops if a page or a file in clear would remain. A public book keeps its canon pages under `book/` and the reader at the root.

## How it works: one key, one slot per password

1. Each build draws a random 256-bit content key K and encrypts every artifact once with it (AES-256-GCM, a random IV each).
2. Each password gets a slot: K wrapped with AES-256-GCM under a key derived from the password with PBKDF2-SHA256, 600,000 iterations and a random 16-byte salt of that slot.
3. The browser derives against the slots (the one that opened last time first) until one unwraps K, then decrypts the bundle.
4. K is new at every publication: a password removed from the list has no slot any more, and the K it could unwrap before opens nothing published afterwards.

Passwords are compared after Unicode NFC normalization and without the spaces around them. The same password listed twice is one slot.

## The passwords on GitHub

- Each password is a repository secret, for example `READER_PASSWORD_001`, `READER_PASSWORD_002`.
- The repository variable `READER_PASSWORD_SECRETS` lists their names: `READER_PASSWORD_001,READER_PASSWORD_002` (commas, spaces or new lines between them).
- The Pages workflow (`.github/workflows/deploy-reader-pages.yml`, version 3) gives the build step, and only it, the password SLOTS: `READER_PASSWORD_001: ${{ secrets.READER_PASSWORD_001 }}` up to `READER_PASSWORD_024`, one environment variable each (expressions cannot index the secrets with a variable, and the workflow must not hand the build every secret of the repository). So a book has **24 passwords at most**, and the secret of a password has to be one of those 24 names; Narrarium picks the first free one. The build reads only the listed names and never prints a value; the log names the secrets it used.
- **Workflow version 2** (reader up to 0.1.61) gave the build step `${{ toJSON(secrets) }}`, every secret of the repository as JSON, which is the pattern of a workflow that steals secrets: GitHub can hold such a file at **Action required** (“GitHub detected that this workflow file may be malicious… Approve and run”) until someone with write access approves it. GitHub does not document its heuristic, so removing `toJSON(secrets)` is the probable cure, not a proven one. The reader still reads that JSON input, so a book on version 2 keeps working; updating the reader (the **Update the reader** card, or `npx create-narrarium-book --upgrade . --update-pages-workflow`) replaces the workflow with version 3. No secret is renamed.
- If the list names secrets the build did not receive, or none of them has a value, the build stops instead of publishing the book in clear. A listed secret that is missing while others exist is left out and named in the log.
- After the build, a step checks that `version.json` says the book is protected whenever the list is not empty: a reader too old to read the list cannot publish the book in clear.

Narrarium manages the list and the secrets. By hand: **Settings → Secrets and variables → Actions**, a secret per password and the variable on the **Variables** tab; then run the workflow again.

## Books published with `NARRARIUM_READER_PASSWORD`

The single password of the earlier readers keeps working: `NARRARIUM_READER_PASSWORD` in the environment of the build is one slot. Narrarium's update of the workflow keeps the line `NARRARIUM_READER_PASSWORD: ${{ secrets.NARRARIUM_READER_PASSWORD }}` when it finds it, so the book stays protected by that password, together with the ones of the list.

Readers of such a book type the password once more after the update (the earlier reader kept a key derived for one build only); from then on the device remembers it.

> **Update the reader of a protected book.** Readers up to `narrarium-astro-reader` 0.1.60 also published `downloads/book.epub` in clear, and the titles and summaries of the chapters in the HTML, even with a password. Building with this version removes them from the published site.

## On the reader's device

- The password can be remembered on the device («Remember the password on this device», checked by default). It is kept as it was typed in `localStorage`, under the id of the book.
- At every opening the remembered password is tried against the CURRENT slots. If it opens none, the reader says it is no longer valid, forgets it and asks for a new one. Offline, with only the slots of the copy in the browser, a password that does not open them is not forgotten.
- Settings → «Forget the password on this device» removes it.

## Always the latest publication

There is no service worker. GitHub Pages lets browsers keep every file for 10 minutes and that cannot be changed, so on every opening the shell fetches `version.json` with `cache: "no-store"` and a query no cache has seen. If its own version is not the current one it reloads once, under an address with `?nrv=<version>`; the artifacts have names that change with their bytes, so the current text is read even if an old shell came back. The book can be read offline only as far as the browser's cache allows.

## Local development

Either the single password, in the reader's `.env`:

```bash
NARRARIUM_READER_PASSWORD=your-secret-password
```

or the same variables the workflow passes (version 3):

```bash
READER_PASSWORD_SECRETS=READER_PASSWORD_001,READER_PASSWORD_002
READER_PASSWORD_001=first password
READER_PASSWORD_002=second password
```

(`NARRARIUM_READER_SECRETS={"READER_PASSWORD_001":"first password"}`, a JSON object of name → password, is still read: it is what a workflow of version 2 passes.)

The build log says which secrets protect the book:

```
[narrarium-reader] Protected with 2 passwords (READER_PASSWORD_001, READER_PASSWORD_002).
```

or that it is public:

```
[narrarium-reader] No reader password: the book is published without encryption.
```

## Limits

- A GitHub Pages site is reachable by its address even when the repository is private (only GitHub Enterprise Cloud can restrict it): the encryption is the only protection. The encrypted files are public, so anyone can try passwords offline; PBKDF2 only slows that down. Use long random passwords.
- Revoking a password cannot take back what someone already read or saved with it; it stops everything published afterwards.
- The title of the book, the size of the encrypted bundle and EPUB, and the number and size of the images are visible.
- `localStorage` belongs to the origin: on `https://<owner>.github.io` every Pages site of the same account or organization can read it, so a page published by another repository of the same owner could read a remembered password. A custom domain gives the book an origin of its own.
