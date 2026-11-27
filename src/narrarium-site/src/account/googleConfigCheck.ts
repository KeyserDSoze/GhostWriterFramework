import { googleSignInScopeList } from "@/config/googleAuth";

/**
 * What the check of the Google configuration shows: the permissions every sign-in asks for, and the number of the Google Cloud project that the client id of
 * this build belongs to (the digits before the first dash of a client id; the rest of the id is never shown). Nothing here is secret.
 */
export interface GoogleConfigReport {
  scopes: string[];
  /** The project number, or `null` when the client id does not have the shape of a Google client id. */
  project: string | null;
}

export function googleProjectNumber(clientId: string): string | null {
  const match = /^(\d{6,})-[a-z0-9]+\.apps\.googleusercontent\.com$/i.exec(clientId.trim());
  return match ? match[1] : null;
}

export function googleConfigReport(clientId: string): GoogleConfigReport {
  return { scopes: googleSignInScopeList(), project: googleProjectNumber(clientId) };
}
