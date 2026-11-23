import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/mcp";
import { appDocEntries } from "@/lib/appDocs";
import { guideText, loadGuides } from "./helpers/guides";

type Language = "en" | "it";

const entryOf = () => {
  const entry = appDocEntries.find((candidate) => candidate.slug === "book-mcp");
  if (!entry) throw new Error("the help of the MCP server of a book is missing");
  return entry;
};
const helpOf = (language: Language) => guideText(entryOf().slug, language);

beforeAll(loadGuides);

/** The controls of the section that the help names in bold: the help and the section must call them the same thing. */
const LABELS = [
  "bookSettings.title",
  "personalServer.title",
  "mcp.title",
  "mcp.switch",
  "mcp.address.label",
  "mcp.slug.label",
  "mcp.slug.change",
  "mcp.connect.token.title",
  "mcp.connect.oauth.title",
  "mcp.apps.title",
  "mcp.apps.revoke",
  "mcp.apps.refresh",
];

describe.each<Language>(["en", "it"])("the help of the MCP server of a book (%s)", (language) => {
  const t = i18n.getFixedT(language);

  it("is a guide with a title and a summary of its own", () => {
    const entry = entryOf();
    expect(entry.group).toBe("guides");
    expect(entry.translations?.[language]?.title).toMatch(/MCP/);
    expect(entry.translations?.[language]?.summary.length).toBeGreaterThan(40);
    expect(entry.translations?.en?.title).not.toBe(entry.translations?.it?.title);
  });

  it("names the controls of the section the way the section does", () => {
    const help = helpOf(language);
    expect(LABELS.map((key) => t(key)).filter((label) => !help.includes(`**${label}**`) && !help.includes(`\n## ${label}\n`))).toEqual([]);
  });

  it("gives the address, both ways of connecting, where the passkeys and the log are, and the risk", () => {
    const help = helpOf(language);
    expect(help).toContain("/mcp/");
    expect(help).toContain("Authorization: Bearer");
    for (const client of ["Claude Code", "Cursor", "VS Code", "ChatGPT", "Claude.ai"]) expect(help).toContain(client);
    expect(help).toMatch(/passkey/);
    expect(help).toContain("prompt injection");
    expect(help).toContain("commit");
  });
});
