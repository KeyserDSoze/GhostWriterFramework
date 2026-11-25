/**
 * Names of branches: whether a name can be one (Git's rules for a branch, `git check-ref-format --branch`, as far as a person types), the name a few
 * words become, and the name suggested for a new branch.
 */

export type BranchNameProblem = "empty" | "too-long" | "spaces" | "characters" | "slashes" | "dots" | "lock" | "reserved";

const MAX_LENGTH = 200;

export function branchNameProblem(name: string): BranchNameProblem | null {
  if (!name) return "empty";
  if (name.length > MAX_LENGTH) return "too-long";
  if (/\s/.test(name)) return "spaces";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f~^:?*[\\]/.test(name) || name.includes("@{")) return "characters";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//") || name.startsWith("-")) return "slashes";
  if (name.includes("..") || name.endsWith(".") || name.split("/").some((part) => part.startsWith("."))) return "dots";
  if (name.split("/").some((part) => part.endsWith(".lock"))) return "lock";
  if (name === "@" || name === "HEAD") return "reserved";
  return null;
}

function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, "-")
    .split("/")
    .map((part) => part.replace(/\.+/g, ".").replace(/^[-.]+|[-.]+$/g, "").replace(/-{2,}/g, "-").replace(/\.lock$/, "-lock"))
    .filter(Boolean)
    .join("/")
    .slice(0, 80)
    .replace(/[-./]+$/, "");
}

/**
 * The branch a person's words make: a name that already is a branch name stays as it is; words ("the new ending") become `feature/the-new-ending`, and a
 * path of words keeps its folders ("Draft/Act two" → `draft/act-two`). Empty when nothing usable is left.
 */
export function branchNameFromInput(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (!branchNameProblem(text)) return text;
  const made = slug(text);
  if (!made) return "";
  return made.includes("/") ? made : `feature/${made}`;
}

function datePart(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The name offered for a new branch: `draft/<date>` of the person's day, then `-2`, `-3`… while a branch has it. */
export function suggestBranchName(taken: ReadonlySet<string>, now = new Date()): string {
  const first = `draft/${datePart(now)}`;
  if (!taken.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const next = `${first}-${index}`;
    if (!taken.has(next)) return next;
  }
}
