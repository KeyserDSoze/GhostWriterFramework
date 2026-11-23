import type { BookRepositoryError } from "@/github/bookRepository";

/** The words for a failure of the creation of a repository, from its code (the texts are `github.createBook.error.*`). */
export function bookRepositoryErrorText(t: (key: string, options?: Record<string, unknown>) => string, error: BookRepositoryError, context: { owner: string; repo: string }, locale?: string): string {
  const reset = error.resetAt ? new Date(error.resetAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : undefined;
  const params = { owner: context.owner, repo: context.repo, reset, status: error.status };
  switch (error.code) {
    case "cannot-create":
      if (error.tokenKind === "app" && error.reason !== "sso-required") return t("github.createBook.app.cannotCreate", params);
      return t(error.reason === "sso-required" ? "github.createBook.error.cannot-create-sso" : "github.createBook.error.cannot-create", params);
    case "rate-limit":
      return t(reset ? "github.createBook.error.rate-limit" : "github.createBook.error.rate-limit-unknown", params);
    case "first-commit-failed": {
      const base = t("github.createBook.error.first-commit-failed", params);
      const kind = error.reason;
      // A repository the app just made but cannot write to: the app is not installed on it yet.
      if (error.tokenKind === "app" && (kind === "permission" || kind === "permission-unverified")) return `${base} ${t("github.createBook.app.notReachable", params)}`;
      const reasonKey = kind === "rate-limit" ? (reset ? "rate-limit" : "rate-limit-unknown")
        : kind === "abuse-limit" || kind === "credential-invalid" || kind === "permission" || kind === "permission-unverified" || kind === "network" || kind === "service-unavailable" ? kind
          : "other";
      return `${base} ${t(`github.createBook.error.reason.${reasonKey}`, params)}`;
    }
    case "unknown":
      return t(error.status ? "github.createBook.error.unknown" : "github.createBook.error.unknown-nostatus", params);
    default:
      return t(`github.createBook.error.${error.code}`, params);
  }
}
