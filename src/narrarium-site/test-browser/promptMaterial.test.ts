import { describe, expect, it } from "vitest";
import { classifyMutationIntent } from "@/assistant/mutationIntent";
import { looksLikeDocument, splitPrompt } from "@/assistant/promptMaterial";
import { longSynopsis } from "./fixtures/longSynopsis";

// #121: a long text the author pastes is material, and the rules that decide what the author asked read the instruction only. The fixture is a 63,000-character synopsis of
// 37 chapters full of «non … crea», «senza aggiungere», «non ho modificato alcun file».

const DOC = longSynopsis();

describe("a long pasted synopsis, as the rules read it", () => {
  it("is 63,000 characters of 37 chapters, and decided «negated» when the whole message was classified (the cause of #121)", () => {
    expect(DOC.length).toBeGreaterThan(60_000);
    expect(DOC.match(/^## Capitolo \d+/gm)).toHaveLength(37);
    const whole = `Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`;
    for (const tool of ["edit-outline", "create-entity", "write-resume", "create-chapter"]) expect(classifyMutationIntent(whole, tool), tool).toBe("negated");
  });

  it("is material, and the instruction the author typed before it, or after it, is what the rules read: a positive request", () => {
    for (const [message, instruction] of [
      [`Creami i capitoli basandoti esattamente su questo riassunto:\n\n${DOC}`, "Creami i capitoli basandoti esattamente su questo riassunto:"],
      [`Creami i capitoli basandoti esattamente su questo riassunto:\n${DOC}`, "Creami i capitoli basandoti esattamente su questo riassunto:"],
      [`${DOC}\n\ncrea i capitoli basandoti esattamente su questo testo`, "crea i capitoli basandoti esattamente su questo testo"],
      [`Create the chapters based exactly on this text:\n\n${DOC}`, "Create the chapters based exactly on this text:"],
    ] as const) {
      const parts = splitPrompt(message);
      expect(parts.instruction).toBe(instruction);
      expect(parts.material).toBe(DOC.trim());
      expect(classifyMutationIntent(parts.instruction, "edit-outline")).toBe("positive");
    }
  });

  it("has no instruction when it is pasted alone: the closing note of the document is not the author's request", () => {
    expect(splitPrompt(DOC)).toEqual({ instruction: "", material: DOC.trim() });
  });

  it("keeps a negative instruction negative: «non creare i capitoli» alone, and before the long text", () => {
    expect(splitPrompt("non creare i capitoli")).toEqual({ instruction: "non creare i capitoli", material: "" });
    expect(classifyMutationIntent("non creare i capitoli", "edit-outline")).toBe("negated");
    const parts = splitPrompt(`Non creare i capitoli: dimmi solo cosa ne pensi di questo testo.\n\n${DOC}`);
    expect(parts.instruction).toBe("Non creare i capitoli: dimmi solo cosa ne pensi di questo testo.");
    expect(classifyMutationIntent(parts.instruction, "edit-outline")).toBe("negated");
  });
});

describe("the instruction and the material of a message", () => {
  it("leaves a short message whole, as it always was", () => {
    for (const message of ["crea il capitolo 3", "Sposta il capitolo 5 dopo il 7", "What can you do?", "Riscrivi la scena del porto in modo che Elena sia più decisa."]) {
      expect(splitPrompt(message)).toEqual({ instruction: message, material: "" });
    }
  });

  it("reads a fenced or a quoted block as material, wherever it is", () => {
    expect(splitPrompt("Usa questo come trama del capitolo 2:\n```\nElena non crea problemi. Non ho modificato nulla.\n```")).toEqual({ instruction: "Usa questo come trama del capitolo 2:", material: "Elena non crea problemi. Non ho modificato nulla." });
    expect(splitPrompt("Cosa ne pensi?\n> Non ho modificato nulla.\n> Il capitolo 1 è lungo.")).toEqual({ instruction: "Cosa ne pensi?", material: "Non ho modificato nulla.\nIl capitolo 1 è lungo." });
  });

  it("takes the first sentence of a long text with no line break when it speaks to the assistant", () => {
    const flat = `Crea i capitoli da questo testo: ${DOC.replace(/\n+/g, " ")}`;
    const parts = splitPrompt(flat);
    expect(parts.instruction).toBe("Crea i capitoli da questo testo:");
    expect(parts.material.length).toBeGreaterThan(60_000);
  });

  it("keeps a long request of the author's own, a paragraph or two of plain words, a request", () => {
    const long = "Riscrivi il capitolo 3 in modo che Elena sia più decisa, che la scena del porto duri di più e che il dialogo con Marco non risolva nulla. ".repeat(14);
    expect(long.length).toBeGreaterThan(1_500);
    expect(splitPrompt(long)).toEqual({ instruction: long.trim(), material: "" });
  });

  it("tells a document from a request by its shape", () => {
    expect(looksLikeDocument("## Capitolo 1\n\nElena arriva.")).toBe(true);
    expect(looksLikeDocument("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(looksLikeDocument("**Riassunto:** x\n**Eventi:** y\n**Chiusura:** z")).toBe(true);
    expect(looksLikeDocument("Crea il capitolo 3, con Elena al porto.")).toBe(false);
  });
});
