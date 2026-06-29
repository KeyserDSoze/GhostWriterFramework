# Getting started

> How to sign in, connect a book, and set up the AI.

## 1. Sign in

Open the site and sign in with **Google** or **Microsoft**.

- With Google, settings go to **Google Drive**.
- With Microsoft, they go to **OneDrive**.

The first time you will be asked to grant Drive permissions (needed to save your settings and chats).

## 2. Create a GitHub token (PAT)

The book lives on GitHub, so you need a token with write access to repositories.

1. Go to GitHub → Settings → Developer settings → Personal access tokens.
2. Create a token (fine-grained is fine) with access to the repositories you will use and **read and write access to contents**.
3. Copy the token.

In Narrarium you can:
- set a **default token** in Settings, or
- give a single book a **dedicated token** (recommended if you use different repositories with different permissions).

## 3. Connect a book

- If you already have a Narrarium repository on GitHub, add it from the Books page.
- If you are starting from scratch, you can create the book repository with the framework tooling (see the reference guides) and then connect it.

One book = one repository. Narrarium reads the structure (chapters, canon, etc.) straight from the files.

## 4. Add your AI (LLM)

Narrarium **does not include a model**: you use your own.

1. Go to Settings → AI integrations.
2. Add an **OpenAI** or **Azure OpenAI** integration with your key.
3. Set the models (writing, optional review, images, speech).
4. Optional: enter **prices** to estimate costs (see the cost guide).

From now on, AI features (Copilot, improve, synonym, script/draft/paragraph generation, images, voice) will use your integration.

## 5. Start writing

- Open a chapter, add a paragraph.
- Use the **script** to plan the scene, then generate the **draft**, then the **final paragraph**.
- Select text and use right-click (desktop) or the button that appears on the selection (mobile) for **Improve** or **Synonym**.
