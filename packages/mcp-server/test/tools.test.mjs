import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      currentIdentity: "Lyra Vale",
      formerNames: ["Livia Sarne"],
      identityShifts: ["Uses a false registry surname in the harbor."],
      identityArc: "Moves from disguise into acknowledged lineage.",
      roleTier: "main",
      speakingStyle: "Measured and guarded.",
      backgroundSummary: "Raised in covert trade circles.",
      functionInBook: "Primary viewpoint anchor.",
      secretRefs: ["secret:lyra-true-name"],
      privateNotes: "She is quietly feeding false data to the harbor registry.",
      knownFrom: "chapter:003-the-signal",
      revealIn: "chapter:008-the-unmasking",
    });

    await callToolText(client, "create_chapter", {
      rootPath,
      number: 1,
      title: "Opening Move",
      frontmatter: {
        timeline_ref: "timeline-event:harbor-lockdown",
      },
    });

    await callToolText(client, "create_timeline_event", {
      rootPath,
      title: "Harbor Lockdown",
      date: "2214-06-12",
      significance: "The city moves into emergency posture before dawn.",
    });

    await callToolText(client, "create_secret", {
      rootPath,
      title: "Lyra forged the harbor arrival ledger",
      functionInBook: "Turns the opening mystery into direct personal risk.",
      stakes: "If exposed, Lyra loses her leverage and her cover.",
      holders: ["character:lyra-vale"],
      revealStrategy: "A customs seal fails during inspection in front of witnesses.",
      revealIn: "chapter:001-opening-move",
      knownFrom: "chapter:001-opening-move",
    });

    await callToolText(client, "create_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-move",
      number: 1,
      title: "First Scene",
    });

    const chapterDraftText = await callToolText(client, "create_chapter_draft", {
      rootPath,
      number: 1,
      title: "Opening Move",
      body: "# Rough Intent\n\nEscalate pressure before the finished prose.",
    });

    const paragraphDraftText = await callToolText(client, "create_paragraph_draft", {
      rootPath,
      chapter: "chapter:001-opening-move",
      number: 1,
      title: "First Scene",
      body: "# Rough Scene\n\nLyra sees the changed watch pattern before she speaks.",
    });

    const chapterContextText = await callToolText(client, "chapter_writing_context", {
      rootPath,
      chapter: "chapter:001-opening-move",
    });

    const paragraphContextText = await callToolText(client, "paragraph_writing_context", {
      rootPath,
      chapter: "chapter:001-opening-move",
      paragraph: "001-first-scene",
    });

    await writeFile(
      path.join(rootPath, "conversations", "RESUME.md"),
      "# Conversation Resume\n\nLatest focus: open with surveillance, pressure, and the altered registry.\n",
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "conversations", "CONTINUATION.md"),
      "# Continuation\n\nResume from the changed watch pattern and the forged records.\n",
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "conversations", "sessions", "20260310-0000--opening-move--abc.md"),
      "# Conversation Export\n\nThe latest session focused on pressure at the gate and the registry seal.\n",
      "utf8",
    );

    const resumeBookContextText = await callToolText(client, "resume_book_context", {
      rootPath,
    });

    const chapterFromDraftText = await callToolText(client, "create_chapter_from_draft", {
      rootPath,
      chapter: "chapter:001-opening-move",
      body: "# Purpose\n\nOpen with pressure, suspicion, and the feeling that the registry has already been touched.",
    });

    const paragraphFromDraftText = await callToolText(client, "create_paragraph_from_draft", {
      rootPath,
      chapter: "chapter:001-opening-move",
      paragraph: "001-first-scene",
      body: "# Scene\n\nLyra paused at the gate when she saw the registry seal had been pressed at the wrong angle.",
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

    await callToolText(client, "update_entity", {
      rootPath,
      kind: "character",
      slugOrId: "lyra-vale",
      frontmatterPatch: {
        secret_refs: ["secret:lyra-true-name", "secret:harbor-registry-fraud"],
        private_notes: "She forged one of the arrival ledgers herself.",
      },
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
    const plotSyncText = await callToolText(client, "sync_plot", { rootPath });
    const movedAssetPrompt = await readFile(path.join(rootPath, "assets", "characters", "lyra-voss", "primary.md"), "utf8");
    const renamedCharacter = await readFile(path.join(rootPath, "characters", "lyra-voss.md"), "utf8");
    const chapterDraft = await readFile(path.join(rootPath, "drafts", "001-opening-move", "chapter.md"), "utf8");
    const paragraphDraft = await readFile(path.join(rootPath, "drafts", "001-opening-move", "001-first-scene.md"), "utf8");
    const plotFile = await readFile(path.join(rootPath, "plot.md"), "utf8");

    assert.match(setupText, /npx create-narrarium-book/);
    assert.match(specText, /Narrarium repository structure/);
    assert.match(assetText, /Created asset prompt/);
    assert.match(chapterDraftText, /Created chapter draft/);
    assert.match(paragraphDraftText, /Created paragraph draft/);
    assert.match(chapterContextText, /Always-read prose guide/);
    assert.match(paragraphContextText, /Target paragraph draft/);
    assert.match(resumeBookContextText, /Resume Book Context/);
    assert.match(resumeBookContextText, /Conversation Resume/);
    assert.match(chapterFromDraftText, /Created or updated chapter from draft/);
    assert.match(paragraphFromDraftText, /Created or updated paragraph from draft/);
    assert.match(finalizeText, /Created chapter/);
    assert.match(searchText, /The Signal/i);
    assert.match(renameEntityText, /Renamed character/);
    assert.match(renameChapterText, /Renamed chapter/);
    assert.match(renameParagraphText, /Renamed paragraph/);
    assert.match(resumeText, /Synced 2 chapter resumes/);
    assert.match(evaluationText, /Synced book evaluation/);
    assert.match(validationText, /Validation passed/);
    assert.match(plotSyncText, /Synced plot at/);
    assert.match(movedAssetPrompt, /subject: character:lyra-voss/);
    assert.match(renamedCharacter, /secret_refs:/);
    assert.match(renamedCharacter, /secret:harbor-registry-fraud/);
    assert.match(renamedCharacter, /private_notes: She forged one of the arrival ledgers herself\./);
    assert.match(renamedCharacter, /known_from: chapter:003-the-signal/);
    assert.match(renamedCharacter, /reveal_in: chapter:008-the-unmasking/);
    assert.match(renamedCharacter, /former_names:/);
    assert.match(renamedCharacter, /Lyra Vale/);
    assert.match(chapterDraft, /type: chapter-draft/);
    assert.match(paragraphDraft, /type: paragraph-draft/);
    assert.match(plotFile, /# Plot Overview/);
    assert.match(plotFile, /Lyra forged the harbor arrival ledger/);
    assert.match(plotFile, /2214-06-12/);
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
