import type { TFunction } from "i18next";
import { ServerRequestError } from "narrarium-engine";
import "@/i18n/serverGitHub";
import i18n from "@/i18n";
import { knownProblemCode } from "@/autopilot/serverGitHub";
import { ServerIdentityError } from "@/autopilot/serverIdentity";

/**
 * A problem of the server's connection, in the language of the app: a code that this site knows is told with its own sentence (never the server's English one), and a code it does not know (a
 * newer server may have more) with the server's own message. A connection that was lost says it in its own words, since the same code (`renewal-failed`) is also a renewal that did not go through.
 */
export function serverGitHubProblemText(t: TFunction, problem: { code: string; message: string }, state?: string): string {
  if (!knownProblemCode(problem.code)) return problem.message;
  const key = problem.code === "renewal-failed" && state === "needs-reconnect" ? "renewal-failed-lost" : problem.code;
  return t(`serverGitHub.problems.${key}`);
}

/** What a request about the connection answered when it failed, in the language of the app. */
export function describeServerGitHubError(error: unknown): string {
  if (error instanceof ServerIdentityError) return i18n.t(`personalServer.identity.${error.reason}`);
  if (error instanceof ServerRequestError) {
    if (error.code === "unreachable") return i18n.t("serverGitHub.errors.unreachable");
    if (error.code === "github_connection_exists") return i18n.t("serverGitHub.errors.exists");
    if (error.code === "invalid_url") return i18n.t("serverGitHub.errors.badBroker");
    if (error.code === "invalid_request") return i18n.t("serverGitHub.errors.invalid");
    if (error.code === "maintenance") return i18n.t("serverGitHub.errors.busy");
  }
  return error instanceof Error ? error.message : String(error);
}
