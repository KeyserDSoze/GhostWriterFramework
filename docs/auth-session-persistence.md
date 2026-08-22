# OAuth session persistence and security model

Narrarium remains a static client application. It does not operate a backend session and does not store OAuth refresh tokens.

## Selected model

Authentication persistence is explicit and account-scoped:

- Default sign-in is session-only and keeps bearer material in `sessionStorage`.
- **Remember me on this device** opts into `localStorage` persistence for the access token, expiry, provider, and immutable provider account ID.
- Durable account continuity metadata is stored separately and cannot authenticate requests by itself.
- A persistent record is accepted only while unexpired and bound to the same provider and immutable account identity.
- Signing in as another provider account replaces the previous persistent bearer instead of merging credentials.
- Sign out removes volatile auth, persistent auth, token-health state, and account continuity.

## Lifecycle contract

| Event | Expected behavior |
| --- | --- |
| New tab, remember-me off | Explicit sign-in may be required. |
| New tab, remember-me on | Restore the unexpired account-bound access token. |
| Browser or installed PWA restart | Same behavior as a new tab. |
| Token expiry | Delete the persistent bearer and attempt only the provider-safe recovery flow. |
| Google recovery | One `prompt=none` attempt, then interactive login; no automatic retries or popup loop. |
| Microsoft recovery | `acquireTokenSilent` only when the matching immutable MSAL account is available, otherwise interactive login. |
| Account switch | Replace bearer state and preserve strict provider/account repository isolation. |
| Logout | Remove all Narrarium authentication persistence on the device. Provider-side grants may still require revocation at Google or Microsoft. |

## Security review

### XSS

An access token in JavaScript-readable storage is exposed if arbitrary script executes in the Narrarium origin. Remember-me is therefore opt-in, refresh tokens are never stored, expiry is enforced, persisted fields are minimal, and the application applies its existing content sanitization and CSP-oriented controls. Users needing the smallest credential exposure window should leave remember-me disabled.

### Shared devices

Persistent sign-in must not be enabled on shared or untrusted devices. Narrarium cannot determine whether an operating-system account or browser profile is shared. Logout is the local revocation boundary.

### Account isolation

Every bearer is bound to provider plus immutable subject (`sub` for Google or `homeAccountId` for Microsoft). Email is display metadata and is not an authorization identity. Repository state is scoped by the same immutable account identity.

### Expiry and revocation

Expired records are removed before use. Narrarium stores no refresh token and cannot centrally revoke provider grants. Logout clears local state; users can additionally revoke Narrarium access from their Google or Microsoft account security settings.

### Provider differences

Google and Microsoft cannot provide identical static-client recovery. Google token recovery is deliberately one-shot to prevent popup loops. Microsoft silent recovery additionally depends on the MSAL account cache, which remains session-scoped.
