import { defineMiddleware } from "astro:middleware";
import { readerCanonModeFromCookieHeader, runWithReaderCanonMode } from "./lib/reader-mode.js";

// Keep development canon selection request-scoped. Mutating process.env here
// would let concurrent requests inherit another author's canon mode.
export const onRequest = defineMiddleware(async (context, next) => {
  if (!import.meta.env.DEV) return next();

  const cookie = context.request.headers.get("cookie") ?? "";
  return runWithReaderCanonMode(readerCanonModeFromCookieHeader(cookie), next);
});
