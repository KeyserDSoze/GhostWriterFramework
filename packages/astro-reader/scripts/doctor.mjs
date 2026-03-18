import { doctorBook } from "narrarium";
import { defaultBookRoot } from "./book-config.mjs";
import { resolveBookRoot } from "./book-dev-utils.mjs";

const bookRoot = resolveBookRoot(defaultBookRoot);
const report = await doctorBook(bookRoot);

if (report.issues.length === 0) {
  console.log(`[narrarium-reader] Doctor passed. Checked ${report.checked} markdown files.`);
  process.exit(0);
}

for (const issue of report.issues) {
  const prefix = issue.severity === "error" ? "ERROR" : "WARN";
  console.log(`[narrarium-reader] ${prefix} ${issue.code} ${issue.path} - ${issue.message}`);
}

console.log(
  `[narrarium-reader] Doctor finished with ${report.errors} error(s) and ${report.warnings} warning(s) after checking ${report.checked} markdown files.`,
);

if (report.errors > 0) {
  process.exit(1);
}
