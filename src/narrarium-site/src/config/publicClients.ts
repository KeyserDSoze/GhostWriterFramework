export const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ||
  "91477716497-k7n97b2q9ic3nc75jpjmb0d3f73s1vgu.apps.googleusercontent.com";

export const MICROSOFT_CLIENT_ID =
  (import.meta.env.VITE_MICROSOFT_CLIENT_ID as string | undefined)?.trim() ||
  "a80b2024-b9e3-4cb1-8480-aac7f164a6eb";

/**
 * The public Client ID of Narrarium's GitHub App (not its App ID), and its URL name (`https://github.com/apps/<slug>`). Both are empty until the app is
 * registered; «Connect with GitHub» is offered only when this is set and the token broker says GitHub sign-in is on. The app's client SECRET
 * lives in the Cloudflare Worker and never in this site.
 */
export const GITHUB_APP_CLIENT_ID =
  (import.meta.env.VITE_GITHUB_APP_CLIENT_ID as string | undefined)?.trim() || "";

export const GITHUB_APP_SLUG =
  (import.meta.env.VITE_GITHUB_APP_SLUG as string | undefined)?.trim() || "";
