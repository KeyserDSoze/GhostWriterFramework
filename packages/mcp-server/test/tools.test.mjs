import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

    const createChapterText = await callToolText(client, "create_chapter", {
      rootPath,
      number: 1,
      title: "Opening Move",
      styleRefs: ["style:first-person-show"],
      narrationPerson: "first",
      proseMode: ["show-dont-tell"],
      timelineRef: "timeline-event:harbor-lockdown",
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

    const createParagraphText = await callToolText(client, "create_paragraph", {
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
    await writeFile(
      path.join(rootPath, "research", "wikipedia", "venice.md"),
      [
        "---",
        "type: research-note",
        "id: research:wikipedia:venice",
        "title: Venice",
        "language: en",
        "source_url: https://en.wikipedia.org/wiki/Venice",
        "retrieved_at: 2026-03-10T00:00:00.000Z",
        "---",
        "",
        "# Summary",
        "",
        "Venice existing snapshot.",
      ].join("\n"),
      "utf8",
    );
    const reusedHistoricalLocationText = await callToolText(client, "create_location", {
      rootPath,
      name: "Venice",
      atmosphere: "Water, stone, and pressure.",
      functionInBook: "Anchors the real-world reference point.",
      historical: true,
      wikipediaTitle: "Venice",
      maxWikipediaSnapshotAgeDays: 365,
    });

    const resumeBookContextText = await callToolText(client, "resume_book_context", {
      rootPath,
    });
    const reusedWikipediaText = await callToolText(client, "wikipedia_page", {
      title: "Venice",
      lang: "en",
      rootPath,
      saveToResearch: true,
      maxWikipediaSnapshotAgeDays: 365,
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
    await callToolText(client, "wizard_answer", { sessionId, skip: true });
    await callToolText(client, "wizard_answer", { sessionId, skip: true });
    await callToolText(client, "wizard_answer", { sessionId, skip: true });
    await callToolText(client, "wizard_answer", { sessionId, skip: true });
    await callToolText(client, "wizard_answer", { sessionId, answer: ["warning", "setup"] });
    await callToolText(client, "wizard_answer", { sessionId, answer: "# Purpose\n\nEscalate pressure before sunrise." });
    const finalizeText = await callToolText(client, "wizard_finalize", { sessionId });

    const updateChapterText = await callToolText(client, "update_chapter", {
      rootPath,
      chapter: "chapter:001-opening-move",
      frontmatterPatch: {
        summary: "The protagonist realizes the city has changed posture.",
        tags: ["hook", "opening"],
      },
    });

    const updateParagraphText = await callToolText(client, "update_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-move",
      paragraph: "001-first-scene",
      frontmatterPatch: {
        summary: "The opening establishes surveillance and threat.",
      },
      body: "# Scene\n\nLyra was very tired, and she felt cornered in Gray Harbor. She needed to warn Taren before the watch closed the gate, and she realized that the registry seal had been pressed at the wrong angle.",
    });
    const reviseParagraphText = await callToolText(client, "revise_paragraph", {
      rootPath,
      chapter: "chapter:001-opening-move",
      paragraph: "001-first-scene",
      mode: "tension",
      intensity: "medium",
    });
    const reviseChapterText = await callToolText(client, "revise_chapter", {
      rootPath,
      chapter: "chapter:001-opening-move",
      mode: "pacing",
      intensity: "medium",
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
    const chapterResumeDirectory = path.join(rootPath, "resumes", "chapters");
    const chapterResumeFile = (await readdir(chapterResumeDirectory)).find((entry) => entry.startsWith("001-"));
    const chapterTwoResumeFile = (await readdir(chapterResumeDirectory)).find((entry) => entry.startsWith("002-"));
    assert.ok(chapterResumeFile, "expected a chapter 1 resume file after sync_all_resumes");
    assert.ok(chapterTwoResumeFile, "expected a chapter 2 resume file after sync_all_resumes");
    const chapterResumePath = path.join(chapterResumeDirectory, chapterResumeFile);
    const chapterResumeSlug = chapterResumeFile.replace(/\.md$/i, "");
    const chapterResume = await readFile(chapterResumePath, "utf8");
    await writeFile(
      chapterResumePath,
      chapterResume.replace(
        `chapter: chapter:${chapterResumeSlug}\n`,
        [
          `chapter: chapter:${chapterResumeSlug}`,
          "state_changes:",
          '  locations:',
          '    "character:lyra-voss": "location:gray-harbor"',
          '  knowledge_gain:',
          '    "character:lyra-voss":',
          '      - registry-seal-is-false',
          '  conditions:',
          '    "character:lyra-voss":',
          '      - cornered',
          '  open_loops_add:',
          '    - prove-the-ledger-was-forged',
          "",
        ].join("\n"),
      ),
      "utf8",
    );
    const chapterTwoResumePath = path.join(chapterResumeDirectory, chapterTwoResumeFile);
    const chapterTwoResumeSlug = chapterTwoResumeFile.replace(/\.md$/i, "");
    const chapterTwoResume = await readFile(chapterTwoResumePath, "utf8");
    await writeFile(
      chapterTwoResumePath,
      chapterTwoResume.replace(
        `chapter: chapter:${chapterTwoResumeSlug}\n`,
        [
          `chapter: chapter:${chapterTwoResumeSlug}`,
          "state_changes:",
          '  conditions:',
          '    "character:lyra-voss":',
          '      - steady',
          '  relationship_updates:',
          '    "character:lyra-voss":',
          '      "character:harbor-lockdown": strategic-focus',
          '  open_loops_add:',
          '    - warn-the-watch-captain',
          '  open_loops_resolved:',
          '    - prove-the-ledger-was-forged',
          "",
        ].join("\n"),
      ),
      "utf8",
    );
    const storyStateText = await callToolText(client, "sync_story_state", { rootPath });
    const queryCanonText = await callToolText(client, "query_canon", {
      rootPath,
      question: "Where is Lyra Voss?",
    });
    const queryConditionText = await callToolText(client, "query_canon", {
      rootPath,
      question: "What condition is Lyra Voss in?",
    });
    const queryConditionArcText = await callToolText(client, "query_canon", {
      rootPath,
      question: "How does Lyra Voss's condition change between chapter 1 and chapter 2?",
    });
    const queryOpenLoopsText = await callToolText(client, "query_canon", {
      rootPath,
      question: "What open loops are there?",
    });
    const queryOpenLoopsArcText = await callToolText(client, "query_canon", {
      rootPath,
      question: "What open loops change between chapter 1 and chapter 2?",
    });
    const evaluationText = await callToolText(client, "evaluate_book", { rootPath });
    const validationText = await callToolText(client, "validate_book", { rootPath });
    const plotSyncText = await callToolText(client, "sync_plot", { rootPath });
    const movedAssetPrompt = await readFile(path.join(rootPath, "assets", "characters", "lyra-voss", "primary.md"), "utf8");
    const renamedCharacter = await readFile(path.join(rootPath, "characters", "lyra-voss.md"), "utf8");
    const chapterDraft = await readFile(path.join(rootPath, "drafts", "001-opening-move", "chapter.md"), "utf8");
    const paragraphDraft = await readFile(path.join(rootPath, "drafts", "001-opening-move", "001-first-scene.md"), "utf8");
    const plotFile = await readFile(path.join(rootPath, "plot.md"), "utf8");
    const currentStoryState = await readFile(path.join(rootPath, "state", "current.md"), "utf8");
    const storyStateStatus = await readFile(path.join(rootPath, "state", "status.md"), "utf8");

    assert.match(setupText, /npx create-narrarium-book/);
    assert.match(specText, /Narrarium repository structure/);
    assert.match(assetText, /Created asset prompt/);
    assert.match(createChapterText, /sync_story_state/);
    assert.match(createParagraphText, /sync_story_state/);
    assert.match(chapterDraftText, /Created chapter draft/);
    assert.match(paragraphDraftText, /Created paragraph draft/);
    assert.match(chapterContextText, /Always-read prose guide/);
    assert.match(chapterContextText, /Explicit chapter override: yes/);
    assert.match(chapterContextText, /style:first-person-show/);
    assert.match(paragraphContextText, /Target paragraph draft/);
    assert.match(resumeBookContextText, /Resume Book Context/);
    assert.match(resumeBookContextText, /Conversation Resume/);
    assert.match(reusedHistoricalLocationText, /Reused existing research snapshot/);
    assert.match(reusedWikipediaText, /Reused saved research snapshot/);
    assert.match(reusedWikipediaText, /research\/wikipedia\/venice\.md/);
    assert.match(chapterFromDraftText, /Created or updated chapter from draft/);
    assert.match(paragraphFromDraftText, /Created or updated paragraph from draft/);
    assert.match(chapterFromDraftText, /Chapter resume synced at/);
    assert.match(chapterFromDraftText, /Total resume synced at/);
    assert.match(chapterFromDraftText, /sync_story_state/);
    assert.match(paragraphFromDraftText, /Chapter resume synced at/);
    assert.match(paragraphFromDraftText, /Total resume synced at/);
    assert.match(paragraphFromDraftText, /sync_story_state/);
    assert.match(finalizeText, /Created chapter/);
    assert.match(finalizeText, /Chapter resume synced at/);
    assert.match(finalizeText, /sync_story_state/);
    assert.match(searchText, /The Signal/i);
    assert.match(updateChapterText, /sync_story_state/);
    assert.match(updateParagraphText, /sync_story_state/);
    assert.match(reviseParagraphText, /Files written: no/);
    assert.match(reviseParagraphText, /Continuity impact: clear/);
    assert.match(reviseParagraphText, /Suggested state_changes:/);
    assert.match(reviseParagraphText, /warn-taren/i);
    assert.match(reviseChapterText, /Files written: no/);
    assert.match(reviseChapterText, /Revision plan:/);
    assert.match(reviseChapterText, /Overall continuity impact: clear/);
    assert.match(reviseChapterText, /Scene proposals:/);
    assert.match(renameEntityText, /Renamed character/);
    assert.match(renameChapterText, /Renamed chapter/);
    assert.match(renameParagraphText, /Renamed paragraph/);
    assert.match(renameChapterText, /Total resume synced at/);
    assert.match(renameParagraphText, /Total resume synced at/);
    assert.match(renameChapterText, /sync_story_state/);
    assert.match(renameParagraphText, /sync_story_state/);
    assert.match(resumeText, /Synced 2 chapter resumes/);
    assert.match(storyStateText, /Synced story state at/);
    assert.match(queryCanonText, /Answer: Lyra Voss is in gray harbor/i);
    assert.match(queryCanonText, /Matched target: character:lyra-voss/);
    assert.match(queryCanonText, /Intent: state-location/);
    assert.match(queryConditionText, /Intent: state-condition/);
    assert.match(queryConditionText, /steady/i);
    assert.match(queryConditionArcText, /Intent: state-condition-arc/);
    assert.match(queryConditionArcText, /cornered/i);
    assert.match(queryConditionArcText, /steady/i);
    assert.match(queryOpenLoopsText, /Intent: state-open-loops/);
    assert.match(queryOpenLoopsText, /warn the watch captain/i);
    assert.match(queryOpenLoopsArcText, /Intent: state-open-loops-arc/);
    assert.match(queryOpenLoopsArcText, /prove the ledger was forged/i);
    assert.match(queryOpenLoopsArcText, /warn the watch captain/i);
    assert.match(queryOpenLoopsArcText, /resolved/i);
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
    assert.match(currentStoryState, /Current Story State/);
    assert.match(storyStateStatus, /dirty: false/);
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
