import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../src/content/guides/${name}`, import.meta.url), "utf8");

test("the guide says which Google permissions are asked, that full access to Drive is a choice, and the checklist of the Google Cloud project, in both languages", () => {
  for (const [file, needles] of [
    ["privacy-settings.en.md", ["What Narrarium asks Google for", "`drive.appdata`", "`drive.file`", "never asked at sign-in", "Sign in to Google Drive again on this device", "Check Google configuration", "“In production”", "7 days", "myaccount.google.com/connections"]],
    ["privacy-settings.it.md", ["Cosa chiede Narrarium a Google", "`drive.appdata`", "`drive.file`", "non viene mai chiesto all'accesso", "Accedi di nuovo a Google Drive su questo dispositivo", "Controlla la configurazione di Google", "«In produzione»", "7 giorni", "myaccount.google.com/connections"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});
