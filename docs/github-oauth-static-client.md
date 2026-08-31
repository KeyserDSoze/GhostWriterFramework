# GitHub OAuth in the static Narrarium client

Narrarium includes the requested GitHub OAuth Web Flow preparation with PKCE:

- one-time random `state`;
- one-time `code_verifier`;
- SHA-256 `code_challenge` with `S256`;
- ten-minute attempt expiry;
- callback state validation and immediate attempt invalidation;
- an isolated triple-Base64 client-secret decoder.

The triple Base64 value is obfuscation only. It is not encryption and does not protect a client secret shipped in a public JavaScript bundle. The decoded value is never persisted or logged.

## Browser verification

On 2026-08-31 the token exchange was tested from a real headless Chromium page whose origin was `https://narrarium.net`.

The browser request to:

```text
POST https://github.com/login/oauth/access_token
```

failed with:

```text
TypeError: Failed to fetch
```

A direct HTTP inspection of the same POST response showed no `Access-Control-Allow-Origin` header. GitHub's OAuth documentation also states that CORS preflight requests are not supported for the flow.

Consequently, a static browser cannot read the token response. `mode: "no-cors"` is intentionally not used because it would return an opaque, unreadable response. No proxy, backend, worker, or serverless function has been introduced.

The PKCE implementation remains isolated for a future GitHub CORS change, but the production UI disables OAuth and presents PAT as the working browser-only option. Account and book repository adapters consume a generic token, so enabling OAuth later will not require another storage or repository refactor.
