// Last step of the deploy workflow: asks the live Worker which sign-in providers are configured and
// writes a table to the job summary, with the next action for each one that is not.
//
// Fails soft: whatever happens (no URL, Worker not reachable, odd answer) the step exits 0 with a
// notice, because the deploy itself already succeeded. Only booleans and names of repository
// secrets are printed, never a value.
//
// Environment: WORKER_BASE_URL (the repository variable VITE_GITHUB_MODELS_BASE; only its origin is
// used), UPLOADED_SECRETS (the Worker secret names this run uploaded, one per line, optional),
// GITHUB_STEP_SUMMARY (set by GitHub Actions; without it the table goes to stdout),
// OAUTH_STATUS_ATTEMPTS and OAUTH_STATUS_DELAY_MS (optional, for tests).

import { appendFileSync } from "node:fs";
import { describeStatus, fetchOAuthStatus, normalizeBaseUrl, renderSummary } from "./oauth-status.mjs";

function publish(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.WORKER_BASE_URL);
  if (!baseUrl) {
    console.log("::notice title=Sign-in status not checked::Set the repository variable VITE_GITHUB_MODELS_BASE to the Worker URL (an https URL) to see which sign-in providers are configured after each deploy.");
    publish("### Worker sign-in status\n\nNot checked: the repository variable `VITE_GITHUB_MODELS_BASE` is empty or is not an https URL.\n");
    return;
  }

  const result = await fetchOAuthStatus(baseUrl, {
    attempts: positiveInteger(process.env.OAUTH_STATUS_ATTEMPTS, 4) || 1,
    delayMs: positiveInteger(process.env.OAUTH_STATUS_DELAY_MS, 5000),
  });
  if (!result.ok) {
    console.log(`::warning title=Sign-in status unavailable::${result.reason}. The deploy is not affected; run the workflow again or call ${baseUrl}/oauth/status by hand.`);
    publish(`### Worker sign-in status\n\nCould not read \`${baseUrl}/oauth/status\`: ${result.reason}. The deploy itself succeeded.\n`);
    return;
  }

  const uploaded = (process.env.UPLOADED_SECRETS ?? "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const rows = describeStatus(result.flags, { language: "en", uploaded });
  publish(renderSummary(rows, baseUrl));
  for (const row of rows) {
    if (row.state !== "configured") console.log(`${row.provider.label}: ${row.label}. ${row.action}`);
    else console.log(`${row.provider.label}: ${row.label}.`);
  }
}

try {
  await main();
} catch {
  console.log("::warning title=Sign-in status unavailable::The status check failed unexpectedly. The deploy is not affected.");
}
process.exit(0);
