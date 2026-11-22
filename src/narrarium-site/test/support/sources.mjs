// Shared by the style tests: the sources of the app and the string literals that carry Tailwind classes.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const SITE = new URL("../../", import.meta.url);
export const SRC = new URL("../../src/", import.meta.url);

export const read = (file) => readFile(new URL(file, SITE), "utf8");

/** The TypeScript sources of the app (paths relative to `src/`), without declarations, translations and generated files. */
export async function sourceFiles() {
  const entries = await readdir(SRC, { recursive: true });
  return entries
    .filter((entry) => /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts"))
    .filter((entry) => !entry.startsWith(`i18n${path.sep}locales`) && !/generated-/.test(entry))
    .sort();
}

/** `dark:hover:bg-x` → variants ["dark", "hover"], utility "bg-x"; brackets (`data-[state=open]:`, `[&>svg]:`) may contain colons. */
export function splitVariants(token) {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  if (cut < 0) return { variants: [], utility: token };
  return { variants: token.slice(0, cut).split(/:(?![^[]*\])/), utility: token.slice(cut + 1) };
}

/** The utilities of a class list that apply without any variant. */
export const baseUtilities = (list) => list.split(/\s+/).filter(Boolean).map(splitVariants).filter(({ variants }) => variants.length === 0).map(({ utility }) => utility);

/** Every string literal of the sources whose text matches `pattern`, with its position (template literals are read piece by piece). */
export async function stringLiterals(pattern) {
  const found = [];
  for (const file of await sourceFiles()) {
    const text = await read(`src/${file}`);
    if (!pattern.test(text)) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (pattern.test(node.text)) found.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, list: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}
