# Reader Password Protection

Narrarium Reader supports AES-256-GCM build-time content encryption.
When enabled, all prose is encrypted before the static site is generated.
Visitors must enter the correct password in the browser before any text is revealed.
The password never leaves the browser — all decryption runs client-side via the Web Crypto API.

## How it works

1. At build time, `NARRARIUM_READER_PASSWORD` is read from the environment.
2. A 16-byte random salt is generated once for the entire build (module-level singleton).
3. Every prose block is encrypted with AES-256-GCM using a PBKDF2-derived key (100 000 iterations, SHA-256, 32-byte key).
4. The ciphertext and IV are embedded in the HTML as `data-enc-iv` / `data-enc-ct` attributes.
5. The PBKDF2 salt and a SHA-256 hash of the password are embedded in `<body>` for the client.
6. The client runs a fast SHA-256 pre-check on the entered password, then derives the AES key via PBKDF2 and decrypts all content in place.
7. The derived AES key is stored in `localStorage` so the reader auto-decrypts on subsequent page loads.

## Local development

Add the variable to the reader's `.env` file (not committed to git):

```bash
NARRARIUM_READER_PASSWORD=your-secret-password
```

Run `npm run dev` as usual. The build log will confirm:

```
[narrarium-reader] Content encryption enabled (AES-256-GCM).
```

If the variable is absent, the log instead says:

```
[narrarium-reader] NARRARIUM_READER_PASSWORD not set — building without encryption.
```

## GitHub Pages deployment

### 1. Store the password as a repository secret

In the book repository on GitHub:
**Settings → Secrets and variables → Actions → New repository secret**

- Name: `NARRARIUM_READER_PASSWORD`
- Value: your password

### 2. Pass the secret to the build step

Open `.github/workflows/deploy-pages.yml` (created by `reader:init`).
Find the `Build site` step and add the secret to the `env:` block:

```yaml
- name: Build site
  env:
    SITE_BASE: /${{ github.event.repository.name }}/
    NARRARIUM_READER_PASSWORD: ${{ secrets.NARRARIUM_READER_PASSWORD }}
  run: npm run build
```

Without the explicit `env:` mapping, GitHub Actions will **not** pass the secret to `process.env`, so the build will silently produce an unencrypted site.

### 3. Verify

After the next workflow run, check the build log for:

```
[narrarium-reader] Content encryption enabled (AES-256-GCM).
```

If you see the `not set` message instead, the secret is not reaching the build step.

## Scaffolded workflows

Readers scaffolded from `narrarium-astro-reader` v0.1.31 and later include the `NARRARIUM_READER_PASSWORD` line as a comment in the generated workflow, ready to uncomment:

```yaml
- name: Build site
  env:
    SITE_BASE: /${{ github.event.repository.name }}/
    # NARRARIUM_READER_PASSWORD: ${{ secrets.NARRARIUM_READER_PASSWORD }}
  run: npm run build
```

For readers scaffolded with an earlier version, add the line manually.

## Security notes

- The salt is public and embedded in the HTML — its purpose is to prevent rainbow tables, not to hide the encryption parameters.
- Security comes entirely from the password entropy. Use a strong, randomly generated password.
- Content on pages that have never been visited will not be cached by the browser, but the derived AES key is stored in `localStorage`. Clearing site data removes it.
- There is no server-side component. This feature is designed for static hosting (GitHub Pages, Netlify, Vercel, etc.).
