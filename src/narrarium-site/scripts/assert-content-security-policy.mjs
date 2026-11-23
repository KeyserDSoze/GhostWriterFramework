import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NARRARIUM_E2E_BUILD === "1") process.exit(0);

const distRoot = path.join(fileURLToPath(new URL("..", import.meta.url)), "dist");
const indexHtml = await readFile(path.join(distRoot, "index.html"), "utf8");
const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(indexHtml)?.[1];
if (!policy) throw new Error("[content-security-policy] The built index.html has no Content-Security-Policy.");
if (policy.includes("%")) throw new Error("[content-security-policy] The Content-Security-Policy placeholder of index.html was not filled in.");
const frames = (/(?:^|;)\s*frame-src ([^;]*)/.exec(policy)?.[1] ?? "").split(/\s+/);
// MSAL's silent renewal frames login.microsoftonline.com, and login.live.com for a personal account: blocked, it waits 10 seconds and fails with `timed_out`.
for (const host of ["https://accounts.google.com", "https://login.microsoftonline.com", "https://login.live.com"]) {
  if (!frames.includes(host)) throw new Error(`[content-security-policy] The built policy does not let ${host} be framed (the sign-in renewal would time out).`);
}
if (/unsafe-eval/.test(policy) || policy.split(/\s+/).includes("*")) throw new Error("[content-security-policy] The built policy allows eval or a wildcard source.");
console.log(`[content-security-policy] frame-src: ${frames.join(" ")}`);
