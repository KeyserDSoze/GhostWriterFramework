import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../src/content/guides/${name}`, import.meta.url), "utf8");

test("the GitHub guide lists the exact permissions of Reader access, and where to add them for the app and for a fine-grained token, in both languages", () => {
  for (const [file, needles] of [
    ["github-sync.en.md", ["Reader access", "READER_PASSWORD_SECRETS", "READER_PASSWORD_001", "Secrets", "Variables (Actions variables)", "Actions", "Pages", "Contents and Workflows", "X-Accepted-GitHub-Permissions", "Permissions & events", "Fine-grained tokens", "Repository permissions", "Read and write", "public address"]],
    ["github-sync.it.md", ["Accesso al lettore", "READER_PASSWORD_SECRETS", "READER_PASSWORD_001", "Secrets", "Variables (Actions variables)", "Actions", "Pages", "Contents e Workflows", "X-Accepted-GitHub-Permissions", "Permissions & events", "Fine-grained tokens", "Repository permissions", "Read and write", "indirizzo pubblico"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});

test("the guide says passwords are kept in the account data, shown on request, and never exported or logged", () => {
  assert.match(read("github-sync.en.md"), /never in the book, in an export, in an AI request or in a log/);
  assert.match(read("github-sync.it.md"), /Non finiscono mai nel libro, in un'esportazione, in una richiesta a un'IA o in un log/);
});
