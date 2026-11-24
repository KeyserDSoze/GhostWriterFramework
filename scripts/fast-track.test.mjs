import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/book-management-system.yml", import.meta.url);

test("the fast track is manual, off by default, and skips only the verification steps", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+fast_track:[\s\S]*?type: boolean\s+default: false/);
  const skipped = [...workflow.matchAll(/- name: ([^\n]+)\n\s+if: \$\{\{ !inputs\.fast_track \}\}/g)].map((match) => match[1]);
  assert.deepEqual(skipped, [
    "Verify dependency security policy",
    "Install Chromium",
    "Test Narrarium site",
    "Run Narrarium site E2E tests",
    "Verify GitHub Pages basename routing",
    "Rebuild root-scope E2E site",
    "Execute Narrarium site E2E tests",
  ]);
  // What is built and published is never conditional: the scaffolder, the site build and the upload run on a fast track too.
  for (const name of ["Build Narrarium core, shared engine and book scaffolder", "Build Narrarium site", "Upload Pages artifact"]) {
    const at = workflow.indexOf(`- name: ${name}`);
    assert.ok(at >= 0, name);
    const end = workflow.indexOf("\n      - name:", at + 1);
    assert.ok(!workflow.slice(at, end < 0 ? undefined : end).includes("fast_track"), name);
  }
});
