import { describe, expect, it } from "vitest";
import { isConfirmedMutationOwned } from "@/assistant/sessionOwnership";

const owner = { account: "google:writer@example.com", sessionId: "session", bookId: "book", branch: "draft", pathname: "/app/books/book/chapters/001" };

describe("confirmed Copilot mutation ownership", () => {
  it.each([
    ["account", { account: "google:other@example.com" }],
    ["session", { sessionId: "other" }],
    ["book", { bookId: "other" }],
    ["branch", { branch: "main" }],
    ["route", { pathname: "/app/books/book/chapters/002" }],
  ])("rejects a changed %s", (_label, patch) => {
    expect(isConfirmedMutationOwned(owner, { ...owner, ...patch }, false)).toBe(false);
  });

  it("rejects cancellation and accepts only the exact live owner", () => {
    expect(isConfirmedMutationOwned(owner, owner, true)).toBe(false);
    expect(isConfirmedMutationOwned(owner, owner, false)).toBe(true);
  });
});
