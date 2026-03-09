# Narrarium Reader Site

This site was scaffolded from `narrarium-astro-reader`.

## Configure

Set the book root in a local environment file:

```bash
NARRARIUM_BOOK_ROOT=..
```

## Run

```bash
npm install
npm run dev
```

The dev server exports a fresh EPUB to `public/downloads/book.epub` before Astro starts.
It also watches the linked book repository, regenerates the EPUB when canon files change, and triggers a full browser reload.

## Build

```bash
npm run build
```

The build also refreshes the EPUB automatically and ships a ready-to-deploy static site.

## GitHub Pages

A starter workflow already exists in `.github/workflows/deploy-pages.yml`.
By default it deploys to standard GitHub Pages using the repository name as the base path.
