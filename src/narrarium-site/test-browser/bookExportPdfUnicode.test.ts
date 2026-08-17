import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildBookExportArtifacts } from "@/export/bookExport";
import { resolveBookExportSettings } from "@/types/settings";

describe("PDF book export Unicode", () => {
  it("embeds extractable multilingual text and typographic punctuation", async () => {
    const multilingual = "Italiano: città, perché. Ελληνικά: Καλημέρα. Кириллица: Привет. Punctuation: “quoted” — it’s fine…";
    const snapshot = {
      title: "Storie — multilingual",
      author: "Zoë D’Angelo",
      language: "it",
      frontmatterRecord: {},
      chapters: [{
        slug: "001-test", number: 1, title: "Capitolo — Καλημέρα", frontmatterRecord: {}, body: "",
        paragraphs: [{ number: "001", title: "Test", frontmatterRecord: {}, body: multilingual }],
      }],
      wordCount: 12,
    };
    const settings = resolveBookExportSettings({} as Parameters<typeof resolveBookExportSettings>[0]);
    const [artifact] = await buildBookExportArtifacts({ snapshot, scope: "full", settings: { ...settings, includeTitlePage: false }, formats: ["pdf"] });
    const pdf = await getDocument({ data: new Uint8Array(await artifact.blob.arrayBuffer()), useSystemFonts: false }).promise;
    const extracted: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      extracted.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    const text = extracted.join(" ");
    expect(pdf.numPages).toBe(1);
    expect(text).toContain("città, perché");
    expect(text).toContain("Καλημέρα");
    expect(text).toContain("Привет");
    expect(text).toContain("“quoted” — it’s fine…");
  }, 30_000);
});
