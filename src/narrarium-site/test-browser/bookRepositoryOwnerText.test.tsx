import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@/i18n/githubCreateBook";
import "@/i18n/githubApp";
import i18n from "@/i18n";
import { bookRepositoryErrorText } from "@/github/bookRepositoryTexts";
import { BookRepositoryError } from "@/github/bookRepository";
import { GitHubCreateFailure } from "@/components/book/GitHubRepositoryOutcome";

afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

const text = (error: BookRepositoryError, context: { owner: string; repo: string; accountLogin?: string }) => bookRepositoryErrorText(i18n.t.bind(i18n) as never, error, context);

describe.each(["en", "it"] as const)("the failure of a creation, when the owner was left on «your account», in %s", (language) => {
  const yourAccount = language === "en" ? "your account" : "tuo account";
  const cannot = () => new BookRepositoryError("cannot-create", { status: 403 });
  const taken = () => new BookRepositoryError("name-taken", { status: 422 });
  const app = () => new BookRepositoryError("cannot-create", { status: 403, tokenKind: "app" });

  it("names the login of the token when it is known", async () => {
    await i18n.changeLanguage(language);
    for (const error of [cannot(), taken(), app()]) {
      const sentence = text(error, { owner: "", repo: "glass", accountLogin: "ada" });
      expect(sentence).toContain("ada");
      expect(sentence).not.toContain(yourAccount);
    }
  });

  it("says «your account» when no login is known, and never leaves the name empty", async () => {
    await i18n.changeLanguage(language);
    for (const error of [cannot(), taken(), app()]) {
      for (const context of [{ owner: "", repo: "glass" }, { owner: "  ", repo: "glass", accountLogin: " " }]) {
        const sentence = text(error, context);
        expect(sentence).toContain(yourAccount);
        expect(sentence).not.toMatch(/ (for|per|in|nel|su) \./);
        expect(sentence).not.toMatch(/ \./);
      }
    }
  });

  it("keeps the owner that was chosen, an organization's name, as it is", async () => {
    await i18n.changeLanguage(language);
    const sentence = text(cannot(), { owner: "acme", repo: "glass", accountLogin: "ada" });
    expect(sentence).toContain("acme");
    expect(sentence).not.toContain("ada");
    expect(sentence).not.toContain(yourAccount);
  });

  it("is what the person sees on the screen, in the alert", async () => {
    await i18n.changeLanguage(language);
    render(<GitHubCreateFailure error={cannot()} owner="" repo="glass" busy={false} onRetry={() => undefined} onDelete={async () => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(yourAccount);
    cleanup();
    render(<GitHubCreateFailure error={cannot()} owner="" accountLogin="ada" repo="glass" busy={false} onRetry={() => undefined} onDelete={async () => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(language === "en" ? "for ada." : "per ada.");
  });
});
