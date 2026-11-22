import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

const router = await readFile(new URL("../src/router.tsx", import.meta.url), "utf8");

function get(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

function keys(value, prefix = "") {
  return Object.entries(value ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

test("the configuration of the autopilot is a route of its own, loaded only when it is opened, with the texts of the autopilot", () => {
  assert.match(router, /\{ path: "books\/:bookId\/autopilot\/settings", lazy: component\(withAutopilotTranslations\(\(\) => import\("@\/pages\/AutopilotSettingsPage"\)\), "AutopilotSettingsPage"\) \}/);
  // The live page keeps its address.
  assert.match(router, /\{ path: "books\/:bookId\/autopilot", lazy: component\(withAutopilotTranslations\(\(\) => import\("@\/pages\/AutopilotPage"\)\), "AutopilotPage"\) \}/);
});

/** The menu is drawn before the texts of the autopilot are loaded: its few labels are in the always-loaded catalogue. */
const MENU = ["nav.groupBook", "nav.groupProfiles", "nav.groupTools", "nav.autopilotLive", "nav.autopilotSettings", "nav.outline"];

test("the labels of the menu are in the always-loaded catalogue, in both languages, and short", () => {
  for (const key of MENU) {
    for (const [language, locale] of [["en", en], ["it", it]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim().length > 0 && get(locale, key).length <= 24, `${language}: ${key} is a short label`);
    }
    assert.equal(get(autopilotEn, key), undefined, `${key} is not repeated in the lazily loaded catalogue`);
  }
  assert.deepEqual(MENU.map((key) => get(it, key)), ["Libro", "Profili", "Strumenti", "In diretta", "Configurazione", "Scaletta"]);
  assert.deepEqual(MENU.map((key) => get(en, key)), ["Book", "Profiles", "Tools", "Live", "Configuration", "Outline"]);
  assert.equal(get(it, "nav.bookOverview"), "Panoramica");
  assert.equal(get(en, "nav.bookOverview"), "Overview");
});

test("the texts of the two pages of the autopilot are in the catalogue loaded with them, in both languages, and nowhere else", () => {
  const lazy = [...keys(autopilotEn.autopilot.config, "autopilot.config."), ...keys(autopilotEn.autopilot.live, "autopilot.live.")];
  assert.ok(lazy.length >= 30, `the configuration and the live page have their texts (${lazy.length})`);
  assert.deepEqual([...keys(autopilotIt.autopilot.config, "autopilot.config."), ...keys(autopilotIt.autopilot.live, "autopilot.live.")].sort(), [...lazy].sort());
  for (const key of lazy) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) assert.ok(String(get(locale, key) ?? "").trim(), `${language}: ${key}`);
    assert.equal(get(en, key), undefined, `${key} is not in the always-loaded catalogue`);
  }
  for (const code of ["rule_changed", "rule_not_found", "rule_too_long", "rule_duplicate", "rule_empty"]) {
    assert.ok(get(autopilotEn, `autopilot.config.rules.errors.${code}`), code);
    assert.ok(get(autopilotIt, `autopilot.config.rules.errors.${code}`), code);
  }
});
