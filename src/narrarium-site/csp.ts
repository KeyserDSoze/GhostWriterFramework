/**
 * The Content-Security-Policy of the app shell, the one place it is written. `index.html` carries the placeholder
 * `%NARRARIUM_CSP%` and vite.config.ts fills it in with `APP_CONTENT_SECURITY_POLICY` for every page it builds from it.
 *
 * `frame-src` lists what a sign-in may load in an iframe, and only that:
 * - accounts.google.com: Google Identity Services;
 * - login.microsoftonline.com: MSAL's hidden iframe for the silent renewal of a Microsoft token (work and school accounts);
 * - login.live.com: the same iframe for personal Microsoft accounts, which are sent on to login.live.com. Without it the
 *   browser blocks the frame, MSAL waits its 10 seconds and the renewal fails with `timed_out`.
 * The token endpoints, Microsoft Graph and the Google APIs are requests, not frames: `connect-src https:` already covers them.
 */
export const FRAME_SOURCES = ["'self'", "https://accounts.google.com", "https://login.microsoftonline.com", "https://login.live.com"] as const;

export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'none'",
  `frame-src ${FRAME_SOURCES.join(" ")}`,
  "script-src 'self' 'unsafe-inline' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

export const CSP_PLACEHOLDER = "%NARRARIUM_CSP%";
