export const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ||
  "91477716497-k7n97b2q9ic3nc75jpjmb0d3f73s1vgu.apps.googleusercontent.com";

export const MICROSOFT_CLIENT_ID =
  (import.meta.env.VITE_MICROSOFT_CLIENT_ID as string | undefined)?.trim() ||
  "a80b2024-b9e3-4cb1-8480-aac7f164a6eb";

export const GITHUB_OAUTH_CLIENT_ID =
  (import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID as string | undefined)?.trim() || "";

/** Triple-Base64 is deliberate product-requested obfuscation, not encryption. */
export const GITHUB_OAUTH_CLIENT_SECRET_B64X3 =
  (import.meta.env.VITE_GITHUB_OAUTH_CLIENT_SECRET_B64X3 as string | undefined)?.trim() || "";
