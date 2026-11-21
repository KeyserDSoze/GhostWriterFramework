import test from "node:test";
import assert from "node:assert/strict";
import * as testing from "../dist/testing.mjs";

const LOCAL = "C:\\Users\\writer\\AppData\\Local\\Narrarium\\server";
const ROAMING = "C:\\Users\\writer\\AppData\\Roaming\\Narrarium\\server";
const env = { LOCALAPPDATA: "C:\\Users\\writer\\AppData\\Local", APPDATA: "C:\\Users\\writer\\AppData\\Roaming", USERPROFILE: "C:\\Users\\writer" };
const present = (...folders) => (folder) => folders.includes(folder);

test("R14: on Windows a new data folder lives under LocalAppData, which is not copied around with the roaming profile", () => {
  const { resolveDataRoot } = testing;
  assert.equal(resolveDataRoot(env, "win32", present()), LOCAL);
  assert.equal(resolveDataRoot({ ...env, LOCALAPPDATA: undefined }, "win32", present()), "C:\\Users\\writer\\AppData\\Local\\Narrarium\\server", "without LOCALAPPDATA: the usual place under the profile");
  assert.equal(resolveDataRoot({ ...env, LOCALAPPDATA: undefined, USERPROFILE: undefined, HOME: undefined, APPDATA: undefined }, "win32", present()).endsWith("\\AppData\\Local\\Narrarium\\server"), true);
});

test("R14: an install that already keeps its data under the roaming folder keeps using it (nothing is moved, nothing is lost)", () => {
  const { resolveDataRoot } = testing;
  assert.equal(resolveDataRoot(env, "win32", present(ROAMING)), ROAMING);
  assert.equal(resolveDataRoot(env, "win32", present(LOCAL)), LOCAL);
  assert.equal(resolveDataRoot(env, "win32", present(LOCAL, ROAMING)), LOCAL, "the new place wins once it exists");
});

test("R14: an explicit data folder wins everywhere, and the other systems keep their places", () => {
  const { resolveDataRoot, defaultDataRoot } = testing;
  assert.equal(resolveDataRoot({ ...env, NARRARIUM_SERVER_HOME: "D:\\books\\server" }, "win32", present(ROAMING)), "D:\\books\\server");
  assert.equal(resolveDataRoot({ NARRARIUM_SERVER_HOME: "/srv/books" }, "linux", present()), "/srv/books");
  for (const [environment, platform] of [[{ HOME: "/home/a" }, "linux"], [{ HOME: "/home/a", XDG_DATA_HOME: "/data/xdg" }, "linux"], [{ HOME: "/Users/a" }, "darwin"]]) {
    assert.equal(resolveDataRoot(environment, platform, present()), defaultDataRoot(environment, platform), platform);
  }
});
