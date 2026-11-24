/**
 * What the address GitHub sent the browser back to means. The authorization the site starts always comes back with the state it made up. Installing the app
 * with «Request user authorization during installation» on comes back as well, but with the installation (`installation_id`, `setup_action`) and no state:
 * that is a finished installation, not a broken sign-in, and the code in it cannot be used because the site did not ask for it.
 */
export type GitHubCallbackKind = "refused" | "authorization" | "installation-return" | "incomplete";

export function classifyGitHubCallback(params: URLSearchParams): GitHubCallbackKind {
  if (params.get("error")) return "refused";
  if (params.get("code") && params.get("state")) return "authorization";
  if (!params.get("state") && (params.get("installation_id") || params.get("setup_action"))) return "installation-return";
  return "incomplete";
}
