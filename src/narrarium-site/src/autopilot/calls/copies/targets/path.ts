/** `2026/11/23/123456-activity_x.ndjson.gz` to the folders it is in and its name. */
export function splitPath(path: string): { folders: string[]; name: string } {
  const parts = path.split("/").filter(Boolean);
  return { folders: parts.slice(0, -1), name: parts[parts.length - 1] ?? "" };
}
