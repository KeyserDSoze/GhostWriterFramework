import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const patchNotes = JSON.parse(await readFile(new URL("../src/content/patch-notes.json", import.meta.url), "utf8"));
const current = patchNotes.find((note) => note.version === packageJson.version);

if (!current) {
  console.error(`[patch-notes] Missing patch note for narrarium-site@${packageJson.version}.`);
  process.exit(1);
}

for (const language of ["en", "it"]) {
  const localized = current[language];
  if (!localized?.title || !localized?.summary || !Array.isArray(localized.changes) || localized.changes.length === 0) {
    console.error(`[patch-notes] Incomplete ${language} patch note for narrarium-site@${packageJson.version}.`);
    process.exit(1);
  }
}

console.log(`[patch-notes] Found bilingual patch note for narrarium-site@${packageJson.version}.`);
