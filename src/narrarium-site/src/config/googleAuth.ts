/**
 * What Narrarium asks Google for, in one place. The scopes are the client's to choose: the auth proxy Worker only exchanges the code the browser got and
 * renews the refresh token, it never names a scope (see `src/auth-proxy/test/oauth-google.test.mjs`).
 *
 *  - `openid profile email` (added by the sign-in itself): who the account is.
 *  - `drive.appdata`: the hidden app-data folder (the copies of the calls).
 *  - `drive.file`: the files and folders this app creates in the user's Drive: the «Narrarium» folder that holds the account data (settings, chats, costs)
 *    and the folder the exports go to. It is a NON-sensitive scope: Google needs no verification for it and shows no «unverified app» warning.
 *
 * `drive` (all the files of the user's Drive) is a RESTRICTED scope. It is never asked at sign-in: only when the person chooses, in a screen that says
 * what Google will say about it, to open a folder Narrarium did not create (an export into an existing folder, the chats of an older version).
 */
export const GOOGLE_SCOPE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";
export const GOOGLE_SCOPE_FILE = "https://www.googleapis.com/auth/drive.file";
/** RESTRICTED: never part of a default flow. */
export const GOOGLE_SCOPE_FULL_DRIVE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = ["openid", "profile", "email"];

/** The scopes of every sign-in and connection (AuthGuard, the login, Account & Sync, the migration, the silent renewal). `useGoogleLogin` adds the identity ones. */
export const GOOGLE_SIGN_IN_SCOPES = [GOOGLE_SCOPE_APPDATA, GOOGLE_SCOPE_FILE].join(" ");

/**
 * `include_granted_scopes`: Google's sign-in library sends it as TRUE by default, and then merges every scope this account ever granted to this client into the
 * consent screen. An account that allowed full access to Drive under an older version would see the restricted scope again, and the «Google has not verified
 * this app» warning with it. Every default flow sends FALSE, so the consent is for the scopes above and nothing else. Only the incremental request of a person's
 * choice (`requestGoogleScope`) sends TRUE, because it asks for one more permission on top of what was allowed.
 */
export const GOOGLE_INCLUDE_GRANTED_SCOPES = false;

/** Everything a sign-in asks for, identity included, one by one: what the diagnostic shows and what the tests hold to the console's list. */
export function googleSignInScopeList(): string[] {
  return [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_SIGN_IN_SCOPES.split(" ")];
}

/** The scopes Google calls restricted (full access to files): none may be in the list of a default flow. */
export const GOOGLE_RESTRICTED_SCOPES: readonly string[] = [GOOGLE_SCOPE_FULL_DRIVE];

export function includesRestrictedGoogleScope(scopes: string | readonly string[]): boolean {
  const list = typeof scopes === "string" ? scopes.split(/\s+/) : scopes;
  return list.some((scope) => GOOGLE_RESTRICTED_SCOPES.includes(scope));
}
