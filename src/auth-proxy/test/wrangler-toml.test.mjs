import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// wrangler.toml is read only at deploy time: a mistake in it (a key twice, a stray character) passes every other test and fails the deploy.
const lines = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").split(/\r?\n/);

test("wrangler.toml: no key is defined twice in the same table, and every line is a comment, a table header, a key or empty", () => {
  let table = "";
  const seen = new Set();
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const where = `line ${index + 1}: ${raw}`;
    if (line === "" || line.startsWith("#")) return;
    const header = /^\[\[?([A-Za-z0-9_.-]+)\]?\]$/.exec(line);
    if (header) {
      table = header[1];
      if (!raw.trim().startsWith("[[")) seen.delete(table);
      return;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(pair, `not a key, a table or a comment: ${where}`);
    assert.ok(!/[`]/.test(pair[2]), `a stray backtick: ${where}`);
    const key = `${table}::${pair[1]}`;
    assert.ok(!seen.has(key), `the key is defined twice: ${where}`);
    seen.add(key);
  });
});
