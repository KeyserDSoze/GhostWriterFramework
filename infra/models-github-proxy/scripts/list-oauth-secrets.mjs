// Prints, as the `names` output of a GitHub Actions step, the Worker secrets that the deploy
// can upload: those whose repository secret exists. wrangler-action stops on a name whose
// value is empty, and a repository secret that does not exist reaches the step as an empty
// string, so listing only the existing ones keeps the deploy from failing. A provider
// without its secret simply answers 501 not_configured (GET /oauth/status says so).
//
// Only names are ever printed, never values. A secret already stored in the Worker is left
// as it is when its repository secret is missing.

import { appendFileSync } from "node:fs";

const SECRETS = [
  { workerName: "GOOGLE_CLIENT_SECRET", repositorySecret: "GOOGLE_OAUTH_CLIENT_SECRET", provider: "Google" },
  { workerName: "MICROSOFT_CLIENT_SECRET", repositorySecret: "MICROSOFT_OAUTH_CLIENT_SECRET", provider: "Microsoft" },
];

const present = [];
for (const { workerName, repositorySecret, provider } of SECRETS) {
  if ((process.env[workerName] ?? "").trim() !== "") {
    present.push(workerName);
  } else {
    console.log(
      `::notice title=${provider} sign-in not uploaded::The repository secret ${repositorySecret} is not set, so this deploy does not upload it. Until the Worker has it, ${provider} sign-in answers 501 not_configured.`,
    );
  }
}

const output = `names<<NAMES_EOF\n${present.map((name) => `${name}\n`).join("")}NAMES_EOF\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
else process.stdout.write(output);
