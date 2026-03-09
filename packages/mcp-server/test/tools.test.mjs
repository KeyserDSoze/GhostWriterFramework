import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "..", "..");

test("mcp server tools support guided creation and structural updates", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, "dist", "index.js")],
    cwd: workspaceRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "narrarium-test", version: "0.1.0" });

  try {
    await client.connect(transport);

    const setupText = await callToolText(client, "setup_framework", {
      projectName: "mcp-test-book",
      title: "MCP Test Book",
      language: "en",
      withReader: true,
    });
    const specText = await callToolText(client, "repository_spec", {});

    await callToolText(client, "init_book_repo", {
      rootPath,
      title: "MCP Test Book",
      language: "en",
    });

    await callToolText(client, "create_character", {
      rootPath,
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Measured and guarded.",
      backgroundSummary: "Raised in covert trade circles.",
      functionInBook: "Primary viewpoint anchor.",
    });

    await callToolText(client, "create_chapter", {
      rootPath,
      number: 1,
      title: "Opening Move",
    });

    await callToolText(client, "create_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-move",
      number: 1,
      title: "First Scene",
    });

    const assetText = await callToolText(client, "create_asset_prompt", {
      rootPath,
      subject: "character:lyra-vale",
      body: "# Prompt\n\nPortrait of Lyra Vale.",
    });

    const wizardStart = await callToolText(client, "start_wizard", {
      kind: "chapter",
      rootPath,
      seed: {
        number: 2,
        title: "The Signal",
      },
    });
    const sessionId = extractSessionId(wizardStart);

    await callToolText(client, "wizard_answer", { sessionId, answer: "A warning reaches Lyra before dawn." });
    await callToolText(client, "wizard_answer", { sessionId, answer: ["character:lyra-vale"] });
    await callToolText(client, "wizard_answer", { sessionId, skip: true });
    await callToolText(client, "wizard_answer", { sessionId, answer: ["warning", "setup"] });
    await callToolText(client, "wizard_answer", { sessionId, answer: "# Purpose\n\nEscalate pressure before sunrise." });
    const finalizeText = await callToolText(client, "wizard_finalize", { sessionId });

    await callToolText(client, "update_chapter", {
      rootPath,
      chapter: "chapter:001-opening-move",
      frontmatterPatch: {
        summary: "The protagonist realizes the city has changed posture.",
        tags: ["hook", "opening"],
      },
    });

    await callToolText(client, "update_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-move",
      paragraph: "001-first-scene",
      frontmatterPatch: {
        summary: "The opening establishes surveillance and threat.",
      },
      body: "# Scene\n\nThe walls watch first.",
    });

    const renameEntityText = await callToolText(client, "rename_entity", {
      rootPath,
      kind: "character",
      slugOrId: "lyra-vale",
      newNameOrTitle: "Lyra Voss",
    });

    const renameChapterText = await callToolText(client, "rename_chapter", {
      rootPath,
      chapter: "chapter:001-opening-move",
      newTitle: "Opening Gambit",
    });

    const renameParagraphText = await callToolText(client, "rename_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-gambit",
      paragraph: "001-first-scene",
      newTitle: "Watching Walls",
    });

    const searchText = await callToolText(client, "search_book", {
      rootPath,
      query: "signal",
      limit: 5,
    });

    const resumeText = await callToolText(client, "sync_all_resumes", { rootPath });
    const evaluationText = await callToolText(client, "evaluate_book", { rootPath });
    const validationText = await callToolText(client, "validate_book", { rootPath });
    const movedAssetPrompt = await readFile(path.join(rootPath, "assets", "characters", "lyra-voss", "primary.md"), "utf8");

    assert.match(setupText, /npx create-narrarium-book/);
    assert.match(specText, /Narrarium repository structure/);
    assert.match(assetText, /Created asset prompt/);
    assert.match(finalizeText, /Created chapter/);
    assert.match(searchText, /The Signal/i);
    assert.match(renameEntityText, /Renamed character/);
    assert.match(renameChapterText, /Renamed chapter/);
    assert.match(renameParagraphText, /Renamed paragraph/);
    assert.match(resumeText, /Synced 2 chapter resumes/);
    assert.match(evaluationText, /Synced book evaluation/);
    assert.match(validationText, /Validation passed/);
    assert.match(movedAssetPrompt, /subject: character:lyra-voss/);
  } finally {
    await transport.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});

async function callToolText(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result.content?.[0]?.text ?? "";
}

function extractSessionId(text) {
  const match = text.match(/Session: (.+)/);
  assert.ok(match, "wizard response should include a session id");
  return match[1].trim();
}
