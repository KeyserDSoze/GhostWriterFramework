# GitHub, Drive and costs

> Branches, commits, pull requests, where data goes, and how spend is estimated.

## The book on GitHub

Each book is a repository. As you work, Narrarium writes Markdown files and makes **real commits** to the active branch.

- **Working branch**: to avoid writing directly to `main`, the app uses a personal branch of yours. You can see the active branch at the top of the book pages.
- **Commit**: every save (chapter, paragraph, canon, script, etc.) is a commit with a descriptive message.
- **Pull request**: from the book's Actions menu you can open/view PRs to bring your branch into `main`.
- **Commit history**: also from the Actions menu you can browse the history.

Git actions (Commit, PR, Export, Image) are gathered in the **Actions** button on the book page.

## Contextual navigation

The (hamburger) menu populates based on where you are:

- in the **book**: overview, dashboard, ghostwriters, style, assets, reader, settings, canon (characters, locations, ...);
- in the **chapter**: scripts, drafts, resume, evaluation, chapter style;
- in the **paragraph**: script, draft, final, evaluation.

There is also a contextual floating **Actions** button, and you can hide the floating buttons from the eye icon at the top.

## Personal data on Drive

On Drive (Google Drive or OneDrive, depending on the account) the following live:

- App **settings** (including the AI keys and PATs you enter): kept by the provider, encrypted by the provider itself.
- **Copilot chats**: each conversation is a file.
- **Clipboard history**: the last 20 copies/cuts.
- **Costs**: one aggregate file per book.

The book (your text) is **not** on Drive: it is on GitHub. Drive is only for your configuration and app data.

## Export

You can export the book to **DOCX, PDF, EPUB** or as a **submission package**, entirely in the browser, with configurable presets and local download or upload to Drive.

## AI costs

Narrarium can estimate how much you are spending, **only if you set prices** in the AI integrations.

- Prices are set per integration, in **euro**.
- Tokens (chat and images) are per **1,000,000** tokens; STT is per **hour**; TTS is per **1M characters**.
- The app reads from the API the tokens used on each request and adds the cost to the current book.
- The **Costs** page (last menu item) shows the grand total and the per-book total, split by chat, images, TTS, STT.
- Only the **aggregate** (totals) is kept, not the cost of each individual request. If you don't set prices, nothing is computed.

## Session and sign-in

- Microsoft keeps the session for a long time thanks to the refresh token in the browser.
- Google, because of how browser sign-in works, may occasionally require a new login when the hour expires; during use you are not signed out mid-work.
