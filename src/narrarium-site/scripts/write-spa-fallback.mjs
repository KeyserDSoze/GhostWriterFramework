import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, "dist");

await copyFile(path.join(distRoot, "index.html"), path.join(distRoot, "404.html"));
