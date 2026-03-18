import { defineMiddleware } from "astro:middleware";

// Reads the `narrarium-canon=full` cookie and temporarily sets
// process.env.NARRARIUM_READER_CANON_MODE for the duration of the request.
// This lets the dev server honour the in-browser canon-mode toggle without
// restarting the server. It is a no-op during production static builds
// because there are no cookies at build time.
export const onRequest = defineMiddleware(async (context, next) => {
  const cookie = context.request.headers.get("cookie") ?? "";
  const cookieRequiresFull = cookie.split(";").some((part) => part.trim() === "narrarium-canon=full");
  const envAlreadyFull = Boolean(process.env.NARRARIUM_READER_CANON_MODE);

  if (cookieRequiresFull && !envAlreadyFull) {
    process.env.NARRARIUM_READER_CANON_MODE = "full";
  }

  const response = await next();

  if (cookieRequiresFull && !envAlreadyFull) {
    delete process.env.NARRARIUM_READER_CANON_MODE;
  }

  return response;
});
