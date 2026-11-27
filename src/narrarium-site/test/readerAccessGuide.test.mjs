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

test("the guide describes the update of an old reader: the exposure, the one commit, the offline case and the check from outside, in both languages", () => {
  for (const [file, needles] of [
    ["github-sync.en.md", ["Update the reader", "downloads/book.epub", "Replace my edits", "publishes at the next sync", "Check from outside", "version.json"]],
    ["github-sync.it.md", ["Aggiorna il lettore", "downloads/book.epub", "Sostituisci le mie modifiche", "si pubblica alla prossima sincronizzazione", "Controllo da fuori", "version.json"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});

test("the guide says when an update is only on this device and names the causes of a failed publication, in both languages", () => {
  for (const [file, needles] of [
    ["github-sync.en.md", ["Updated on this device, not yet on GitHub", "Sync now", "Turn GitHub Pages off", "Actions budget or billing", "Checks (read only)"]],
    ["github-sync.it.md", ["Aggiornato su questo dispositivo, non ancora su GitHub", "Sincronizza ora", "Spegni GitHub Pages", "budget di Actions o la fatturazione", "Checks (sola lettura)"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});

test("the guide explains how to make the repository public or private, with the permission, the typed confirmation and the effect on Pages, in both languages", () => {
  for (const [file, needles] of [
    ["github-sync.en.md", ["Repository visibility", "Administration: Read and write", "type the name of the repository", "`secrets/`, `director.md`, `conversations/`, `drafts/`", "never queued", "what happens to GitHub Pages"]],
    ["github-sync.it.md", ["Visibilità del repository", "Administration: Read and write", "scrivere il nome del repository", "`secrets/`, `director.md`, `conversations/`, `drafts/`", "mai messa in coda", "cosa succede a GitHub Pages"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});
