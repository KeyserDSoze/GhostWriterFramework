import { docMarkdown, type DocEntry, type DocLang } from "@/lib/generated-docs";
import { localizedDoc } from "@/lib/docs";

const loaded = new Map<string, Promise<string>>();

/**
 * The text of a document in a language: the chunk of its source file, imported the first time a page shows it (a document written once is one
 * chunk for both languages). A load that failed is forgotten, so that the next call (Retry) tries again.
 */
export function loadDocMarkdown(entry: DocEntry, lang: DocLang): Promise<string> {
  const { sourcePath } = localizedDoc(entry, lang);
  let text = loaded.get(sourcePath);
  if (!text) {
    const load = docMarkdown[sourcePath];
    text = load ? load().then((module) => module.default) : Promise.reject(new Error(`No text is known for ${sourcePath}.`));
    loaded.set(sourcePath, text);
    text.catch(() => loaded.delete(sourcePath));
  }
  return text;
}
