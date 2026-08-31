/** Authenticated Graph reads must never reuse browser HTTP cache entries. */
export function fetchMicrosoftGraph(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, cache: "no-store" });
}
