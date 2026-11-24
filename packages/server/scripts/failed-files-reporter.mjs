// A reporter of node:test for scripts/run-tests.mjs: it writes, as JSON, the test files that had a failing test (or failed themselves), so
// that those files, and only those, can be run once more.
import path from "node:path";

export default async function* failedFiles(source) {
  const failed = new Set();
  for await (const event of source) {
    if (event.type !== "test:fail" || event.data.todo || !event.data.file) continue;
    failed.add(path.resolve(event.data.file));
  }
  yield `${JSON.stringify([...failed].sort())}\n`;
}
