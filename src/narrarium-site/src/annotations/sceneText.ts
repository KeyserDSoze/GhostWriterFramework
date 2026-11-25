import { readerSceneHtml } from "@/narrarium/readerText";
import { plainTextOfHtml } from "./textModel";

/** The plain text of a scene from its Markdown file, the same the reader shows and the anchors are written in (outside the reader: the list of a chapter). */
export function sceneTextOfMarkdown(raw: string, filePath: string): string {
  return plainTextOfHtml(readerSceneHtml(raw, filePath));
}
