import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";
import callsEn from "../src/i18n/locales/autopilotCalls.en.ts";
import callsIt from "../src/i18n/locales/autopilotCalls.it.ts";

const SITE = new URL("../", import.meta.url);

function leaves(value, prefix = "") {
  return Object.entries(value ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]));
}
const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)[\s,}]/g)].map((match) => match[1]).sort();

test("the task view speaks both languages, with the same texts and the same placeholders, all under autopilot.calls", () => {
  const english = new Map(leaves(callsEn));
  const italian = new Map(leaves(callsIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  assert.ok(english.size > 80, `the texts are read (saw ${english.size})`);
  for (const [key, text] of english) {
    assert.ok(key.startsWith("autopilot.calls."), key);
    assert.equal(typeof text, "string", key);
    assert.ok(text.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(text), `${key}: the same placeholders`);
  }
});

test("the Italian of the task view is written in Italian, not copied from English", () => {
  const italian = new Map(leaves(callsIt));
  // The same in both languages because they are figures, names or punctuation.
  const same = new Set(["autopilot.calls.attemptFacts.http", "autopilot.calls.pane.copyOf"]);
  assert.deepEqual(leaves(callsEn).filter(([key, text]) => !same.has(key) && italian.get(key) === text).map(([key]) => key), []);
});

test("the owner's words for the messages that are not recorded", () => {
  assert.equal(callsEn.autopilot.calls.unavailable["server-outdated"], "This run's messages are not being recorded on this server: update it.");
  assert.equal(callsEn.autopilot.calls.unavailable["no-store"], "This run's messages are not recorded in this browser (private window?).");
  for (const locale of [callsEn, callsIt]) for (const reason of ["server-outdated", "server-offline", "no-store", "recording-off"]) assert.ok(locale.autopilot.calls.unavailable[reason], reason);
});

test("the texts of the task view are in their own files: not in the app entry, not in the autopilot bundle", () => {
  for (const locale of [en, it, autopilotEn, autopilotIt]) assert.equal("calls" in (locale.autopilot ?? {}), false);
});

async function sources() {
  const files = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    const relative = `src/${entry.split("\\").join("/")}`;
    if (/\.(ts|tsx)$/.test(relative)) files.push({ file: relative, text: await readFile(new URL(relative, SITE), "utf8") });
  }
  return files;
}

test("the task view is a chunk of its own, loaded the first time a step is opened: only its entry imports it, and only with import()", async () => {
  const files = await sources();
  const importers = files.filter(({ text }) => /components\/autopilot\/calls\/TaskCalls["']/.test(text)).map(({ file }) => file).sort();
  assert.deepEqual(importers, ["src/components/autopilot/calls/TaskCallsEntry.tsx"]);
  const entry = files.find(({ file }) => file === "src/components/autopilot/calls/TaskCallsEntry.tsx").text;
  assert.match(entry, /lazy\(\(\) => import\("@\/components\/autopilot\/calls\/TaskCalls"\)\)/);
  assert.doesNotMatch(entry, /^import[^;]*["']@\/components\/autopilot\/calls\/(TaskCalls|CallSection|CallPanes|TextPane|useCallText|useCallTask|callFacts|textBuffer|textWindow)["']/m, "the entry imports none of the view's parts");
  // The parts of the view are imported by the view and by one another, never by what the page loads with itself.
  const parts = /components\/autopilot\/calls\/(CallSection|CallPanes|TextPane|useCallText|useCallTask|callFacts|textBuffer|textWindow)["']/;
  const outside = files.filter(({ file, text }) => parts.test(text) && !file.startsWith("src/components/autopilot/calls/")).map(({ file }) => file);
  assert.deepEqual(outside, []);
  const inside = files.filter(({ file, text }) => parts.test(text) && file.startsWith("src/components/autopilot/calls/")).map(({ file }) => file.replace("src/components/autopilot/calls/", "")).sort();
  assert.ok(!inside.includes("TaskCallsEntry.tsx") && !inside.includes("callsView.ts") && !inside.includes("anchors.ts"), `the entry, the page's state and the anchors stay small: ${inside.join(", ")}`);
});

test("the task view and its entry bring their texts with them, and the polite voice of the page is the band's", async () => {
  for (const file of ["src/components/autopilot/calls/TaskCallsEntry.tsx", "src/components/autopilot/calls/TaskCalls.tsx"]) {
    assert.match(await readFile(new URL(file, SITE), "utf8"), /^import "@\/i18n\/autopilotCalls";$/m, file);
  }
  const panes = await readFile(new URL("src/components/autopilot/calls/CallPanes.tsx", SITE), "utf8");
  assert.match(panes, /sayInLiveVoice\(/);
  for (const file of ["CallPanes.tsx", "CallSection.tsx", "TaskCalls.tsx", "TextPane.tsx"]) {
    const text = await readFile(new URL(`src/components/autopilot/calls/${file}`, SITE), "utf8");
    assert.doesNotMatch(text, /aria-live|role="status"|role="log"|useToast|toast\(/, `${file}: no live region of its own, and never a toast`);
    assert.doesNotMatch(text, /behavior:\s*"smooth"|scroll-smooth/, `${file}: jumps, never a smooth scroll`);
  }
});
