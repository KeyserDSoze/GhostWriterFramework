import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptEditor } from "@/components/script/ScriptEditor";
import { makeNode } from "@/narrarium/script/model";
import type { BookStructure } from "@/types/book";

afterEach(cleanup);

const file = (path: string, name?: string) => ({ path, sha: "", size: 0, name });
const structure = {
  characters: [file("characters/character-0crj2m.md", "李明"), file("characters/ivan-petrov.md", "Иван Петров"), file("characters/lyra-vale.md", "Lyra Vale"), file("characters/mira-solis.md")],
  locations: [file("locations/location-1abcde.md", "海辺の町")],
  items: [], factions: [], secrets: [], timelines: [],
} as unknown as BookStructure;

function showing(speaker: string) {
  render(<ScriptEditor doc={{ nodes: [makeNode("dialogue", { speaker }, "Hello.")] }} structure={structure} bookId="book-1" onChange={() => undefined} />);
}

describe("the characters of a script, listed in the script editor", () => {
  it.each([
    ["character:character-0crj2m", "李明"],
    ["character:ivan-petrov", "Иван Петров"],
    ["character:lyra-vale", "Lyra Vale"],
  ])("shows the name of %s, not the code or the words of its file name", (speaker, name) => {
    showing(speaker);
    expect(screen.getByRole("combobox")).toHaveTextContent(name);
    expect(screen.getByRole("combobox")).not.toHaveTextContent(/character 0crj2m|ivan petrov$/);
  });

  it("keeps showing the words of the file name for a character that has no name", () => {
    showing("character:mira-solis");
    expect(screen.getByRole("combobox")).toHaveTextContent("mira solis");
  });
});
