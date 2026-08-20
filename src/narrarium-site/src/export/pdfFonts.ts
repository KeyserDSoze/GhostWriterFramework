import liberationSerifRegular from "@/export/fonts/LiberationSerif-Regular.ttf?inline";
import liberationSerifBold from "@/export/fonts/LiberationSerif-Bold.ttf?inline";
import liberationSerifItalic from "@/export/fonts/LiberationSerif-Italic.ttf?inline";
import liberationSerifBoldItalic from "@/export/fonts/LiberationSerif-BoldItalic.ttf?inline";

export function registerPdfUnicodeFonts(doc: import("jspdf").jsPDF): void {
  const fonts = [
    ["LiberationSerif-Regular.ttf", liberationSerifRegular, "normal"],
    ["LiberationSerif-Bold.ttf", liberationSerifBold, "bold"],
    ["LiberationSerif-Italic.ttf", liberationSerifItalic, "italic"],
    ["LiberationSerif-BoldItalic.ttf", liberationSerifBoldItalic, "bolditalic"],
  ] as const;
  for (const [fileName, dataUrl, style] of fonts) {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    doc.addFileToVFS(fileName, base64);
    doc.addFont(fileName, "LiberationSerif", style);
  }
}
