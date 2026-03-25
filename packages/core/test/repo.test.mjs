import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  buildChapterWritingContext,
  buildParagraphWritingContext,
  buildResumeBookContext,
  createAssetPrompt,
  createChapter,
  createChapterDraft,
  createChapterFromDraft,
  createCharacterProfile,
  createItemProfile,
  createLocationProfile,
  createParagraph,
  createParagraphDraft,
  createParagraphFromDraft,
  createSecretProfile,
  createTimelineEventProfile,
  doctorBook,
  evaluateBook,
  findWikipediaResearchSnapshot,
  initializeBookRepo,
  listEntities,
  registerAsset,
  renameChapter,
  renameEntity,
  renameParagraph,
  queryCanon,
  readChapter,
  readEntity,
  readTimelineMain,
  reviseChapter,
  reviewDialogueActionBeats,
  reviseParagraph,
  saveBookWorkItem,
  saveChapterDraftWorkItem,
  syncPlot,
  syncAllResumes,
  syncStoryState,
  syncTotalResume,
  promoteBookWorkItem,
  promoteChapterDraftWorkItem,
  upgradeBookRepo,
  updateBookNotes,
  updateChapterDraftNotes,
  updateChapter,
  updateEntity,
  applyDialogueActionBeats,
  updateParagraph,
  validateBook,
  writeWikipediaResearchSnapshot,
} from "../dist/index.js";

test("core book workflow supports canon indexes and structural updates", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-core-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Core Test Book",
      author: "Narrarium",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      currentIdentity: "Lyra Vale",
      formerNames: ["Livia Sarne"],
      identityShifts: ["Travels under a false customs registry name in the opening act."],
      identityArc: "Moves from concealment into acknowledged inheritance.",
      roleTier: "main",
      speakingStyle: "Controlled and observant.",
      backgroundSummary: "Raised around covert trade.",
      functionInBook: "Primary viewpoint anchor.",
      secretRefs: ["secret:lyra-true-name"],
      privateNotes: "Knows the harbor council covered up the archive fire.",
      knownFrom: "chapter:003-signal-in-fog",
      revealIn: "chapter:007-mask-off",
    });

    await createCharacterProfile(rootPath, {
      name: "Taren Dane",
      roleTier: "supporting",
      speakingStyle: "Dry and skeptical.",
      backgroundSummary: "Harbor operative with long memory.",
      functionInBook: "Pressure point and reluctant ally for Lyra.",
    });

    await updateEntity(rootPath, {
      kind: "character",
      slugOrId: "lyra-vale",
      frontmatterPatch: {
        secret_refs: ["secret:lyra-true-name", "secret:harbor-fire-cover-up"],
        private_notes: "Her missing brother is alive and tied to the cover-up.",
      },
    });

    await createLocationProfile(rootPath, {
      name: "Gray Harbor",
      atmosphere: "Cold fog and careful silence.",
      functionInBook: "Pressure-cooker port city for the opening movement.",
    });

    await createItemProfile(rootPath, {
      name: "Brass Key",
      appearance: "A worn brass key with salt-darkened grooves.",
      purpose: "Opens the ledger archive gate.",
      functionInBook: "Turns the harbor mystery into a solvable physical trail.",
    });

    await createTimelineEventProfile(rootPath, {
      title: "Harbor Lockdown",
      date: "2214-06-12",
      participants: ["character:lyra-vale"],
      significance: "The city shifts into an emergency posture.",
      functionInBook: "Establishes external pressure before the first confrontation.",
    });

    await createSecretProfile(rootPath, {
      title: "Lyra knows the harbor ledgers were forged",
      functionInBook: "Turns suspicion into a direct threat to the ruling archive.",
      stakes: "If exposed, the harbor council loses control of the succession narrative.",
      holders: ["character:lyra-vale"],
      revealStrategy: "The forged seal is discovered in front of the customs tribunal.",
      revealIn: "chapter:001-the-arrival",
      knownFrom: "chapter:001-the-arrival",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "The Arrival",
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-the-arrival",
      number: 1,
      title: "At The Gate",
      body: "# Scene\n\nThe harbor watches before it welcomes.",
    });

    const earlyTotalResume = await syncTotalResume(rootPath);

    await updateChapter(rootPath, {
      chapter: "chapter:001-the-arrival",
      frontmatterPatch: {
        summary: "Lyra returns to Gray Harbor and notices the guard routine has changed.",
        pov: ["character:lyra-vale"],
        timeline_ref: "timeline-event:harbor-lockdown",
      },
      appendBody: "## Revision Note\n\nTighten the harbor tension immediately.",
    });

    await updateParagraph(rootPath, {
      chapter: "chapter:001-the-arrival",
      paragraph: "001-at-the-gate",
      frontmatterPatch: {
        summary: "A warning is visible before anyone speaks.",
        viewpoint: "character:lyra-vale",
      },
      body: "# Scene\n\nThe harbor watches before it welcomes.",
    });

    const characters = await listEntities(rootPath, "character");
    const locations = await listEntities(rootPath, "location");
    const events = await listEntities(rootPath, "timeline-event");
    const character = await readEntity(rootPath, "character", "lyra-vale");
    const timelineMain = await readTimelineMain(rootPath);
    const plot = await syncPlot(rootPath);
    const opencodeConfig = await readFile(path.join(rootPath, "opencode.jsonc"), "utf8");
    const contextDocument = await readFile(path.join(rootPath, "context.md"), "utf8");
    const notesDocument = await readFile(path.join(rootPath, "notes.md"), "utf8");
    const storyDesignDocument = await readFile(path.join(rootPath, "story-design.md"), "utf8");
    const conversationsReadme = await readFile(path.join(rootPath, "conversations", "README.md"), "utf8");
    const resumeCommand = await readFile(path.join(rootPath, ".opencode", "commands", "resume-book.md"), "utf8");
    const conversationPlugin = await readFile(path.join(rootPath, ".opencode", "plugins", "conversation-export.js"), "utf8");
    const resumes = await syncAllResumes(rootPath);
    const chapterResumePath = path.join(rootPath, "resumes", "chapters", "001-the-arrival.md");
    const chapterResume = await readFile(chapterResumePath, "utf8");
    await writeFile(
      chapterResumePath,
      chapterResume.replace(
        "chapter: chapter:001-the-arrival\n",
        [
          "chapter: chapter:001-the-arrival",
          "state_changes:",
          '  locations:',
          '    "character:lyra-vale": "location:gray-harbor"',
          '  knowledge_gain:',
          '    "character:lyra-vale":',
          '      - guard-routine-changed',
          '  inventory_add:',
          '    "character:lyra-vale":',
          '      - item:brass-key',
          '  conditions:',
          '    "character:lyra-vale":',
          '      - alert',
          '      - exhausted',
          '  wounds:',
          '    "character:lyra-vale":',
          '      - cut-palm',
          '  relationship_updates:',
          '    "character:lyra-vale":',
          '      "character:taren-dane": wary-trust',
          '  open_loops_add:',
          '    - find-the-ledger',
          '    - warn-taren-about-the-forgery',
          "",
        ].join("\n"),
      ),
      "utf8",
    );
    const refreshedResumes = await syncAllResumes(rootPath);
    const storyState = await syncStoryState(rootPath);
    const evaluation = await evaluateBook(rootPath);
    const validation = await validateBook(rootPath);
    const doctor = await doctorBook(rootPath);
    const locationQuery = await queryCanon(rootPath, "Where is Lyra Vale?");
    const knowledgeQuery = await queryCanon(rootPath, "What does Lyra know after chapter 1?");
    const inventoryQuery = await queryCanon(rootPath, "What does Lyra have?");
    const relationshipQuery = await queryCanon(rootPath, "What is Lyra Vale's relationship with Taren Dane?");
    const conditionQuery = await queryCanon(rootPath, "What condition is Lyra Vale in?");
    const openLoopsQuery = await queryCanon(rootPath, "What open loops are there?");
    const firstAppearanceQuery = await queryCanon(rootPath, "When does the Brass Key first appear?");
    const secretHolderQuery = await queryCanon(rootPath, "Who knows Lyra knows the harbor ledgers were forged?");
    const syncedChapterResume = await readFile(chapterResumePath, "utf8");
    const currentStoryState = await readFile(path.join(rootPath, "state", "current.md"), "utf8");
    const storyStateStatus = await readFile(path.join(rootPath, "state", "status.md"), "utf8");
    const doctorCodes = doctor.issues.map((issue) => issue.code);

    assert.equal(characters.length, 2);
    assert.equal(locations.length, 1);
    assert.equal(events.length, 1);
    assert.equal(character.metadata.name, "Lyra Vale");
    assert.equal(character.metadata.current_identity, "Lyra Vale");
    assert.deepEqual(character.metadata.former_names, ["Livia Sarne"]);
    assert.deepEqual(character.metadata.identity_shifts, ["Travels under a false customs registry name in the opening act."]);
    assert.equal(character.metadata.identity_arc, "Moves from concealment into acknowledged inheritance.");
    assert.deepEqual(character.metadata.secret_refs, ["secret:lyra-true-name", "secret:harbor-fire-cover-up"]);
    assert.equal(character.metadata.private_notes, "Her missing brother is alive and tied to the cover-up.");
    assert.equal(character.metadata.known_from, "chapter:003-signal-in-fog");
    assert.equal(character.metadata.reveal_in, "chapter:007-mask-off");
    assert.ok(timelineMain);
    assert.match(plot.content, /# Chapter Map/);
    assert.match(plot.content, /Lyra knows the harbor ledgers were forged/);
    assert.match(plot.content, /2214-06-12/);
    assert.match(earlyTotalResume.content, /The harbor watches before it welcomes/);
    assert.match(contextDocument, /# Historical And Temporal Frame/);
    assert.match(notesDocument, /# Active Notes/);
    assert.match(storyDesignDocument, /# Core Design/);
    assert.match(opencodeConfig, /"default_agent": "build"/);
    assert.match(opencodeConfig, /\.github\/copilot-instructions\.md/);
    assert.match(opencodeConfig, /"reasoningEffort": "high"/);
    assert.match(opencodeConfig, /"textVerbosity": "high"/);
    assert.match(opencodeConfig, /"watcher"/);
    assert.match(conversationsReadme, /portable exports of OpenCode/);
    assert.match(resumeCommand, /resume_book_context/);
    assert.match(resumeCommand, /chapter:002-ledger-suspicion/);
    assert.match(resumeCommand, /context\.md/);
    assert.match(conversationPlugin, /ConversationExportPlugin/);
    assert.equal(resumes.chapterCount, 1);
    assert.equal(refreshedResumes.chapterCount, 1);
    assert.equal(storyState.chapterCount, 1);
    assert.equal(evaluation.chapterCount, 1);
    assert.equal(validation.valid, true);
    assert.match(syncedChapterResume, /state_changes:/);
    assert.match(currentStoryState, /character:lyra-vale -> location:gray-harbor/);
    assert.match(currentStoryState, /guard-routine-changed/);
    assert.match(currentStoryState, /find-the-ledger/);
    assert.match(storyStateStatus, /dirty: false/);
    assert.match(locationQuery.answer, /Gray Harbor/);
    assert.equal(locationQuery.intent, "state-location");
    assert.match(knowledgeQuery.answer, /guard routine changed/);
    assert.equal(knowledgeQuery.intent, "state-knowledge");
    assert.match(inventoryQuery.answer, /Brass Key/);
    assert.equal(inventoryQuery.intent, "state-inventory");
    assert.match(relationshipQuery.answer, /wary trust/i);
    assert.equal(relationshipQuery.intent, "state-relationship");
    assert.match(conditionQuery.answer, /alert/i);
    assert.match(conditionQuery.answer, /cut palm/i);
    assert.equal(conditionQuery.intent, "state-condition");
    assert.match(openLoopsQuery.answer, /find the ledger/i);
    assert.equal(openLoopsQuery.intent, "state-open-loops");
    assert.match(firstAppearanceQuery.answer, /Chapter 001 The Arrival/);
    assert.equal(firstAppearanceQuery.intent, "first-appearance");
    assert.match(secretHolderQuery.answer, /Lyra Vale/);
    assert.equal(secretHolderQuery.intent, "secret-holders");
    assert.equal(doctor.errors, 0);
    assert.ok(!doctorCodes.includes("stale-story-state"));
    assert.ok(!doctorCodes.includes("stale-story-state-current"));
    assert.ok(!doctorCodes.includes("stale-story-state-chapter"));
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("doctorBook detects broken refs and stale maintenance files", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-doctor-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Doctor Test Book",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Maris Vale",
      roleTier: "main",
      speakingStyle: "Quiet and exact.",
      backgroundSummary: "Raised in the archive quarter.",
      functionInBook: "Perspective anchor for the opening chapter.",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Opening Bell",
    });

    await createChapter(rootPath, {
      number: 2,
      title: "Second Bell",
    });

    await updateEntity(rootPath, {
      kind: "character",
      slugOrId: "maris-vale",
      frontmatterPatch: {
        refs: ["location:missing-hall"],
        reveal_in: "chapter:001-opening-bell",
        known_from: "chapter:002-second-bell",
      },
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-opening-bell",
      number: 1,
      title: "At Dawn",
      body: "The bells reached the harbor before the sun.",
    });

    await writeFile(path.join(rootPath, "plot.md"), "---\ntype: plot\nid: plot:main\ntitle: Broken Plot\n---\n\n# Drift\n", "utf8");
    await writeFile(path.join(rootPath, "resumes", "total.md"), "---\ntype: resume\nid: resume:total\ntitle: Total Resume\n---\n\n# Drift\n", "utf8");

    const doctor = await doctorBook(rootPath);
    const codes = doctor.issues.map((issue) => issue.code);

    assert.ok(doctor.errors >= 1);
    assert.ok(doctor.warnings >= 2);
    assert.ok(codes.includes("broken-reference"));
    assert.ok(codes.includes("spoiler-order"));
    assert.ok(codes.includes("stale-plot"));
    assert.ok(codes.includes("stale-story-state"));
    assert.ok(codes.includes("stale-total-resume"));
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("queryCanon can describe arcs across chapter ranges", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-query-arc-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Arc Query Book",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Measured and alert.",
      backgroundSummary: "Moves carefully through pressure.",
      functionInBook: "Primary viewpoint anchor.",
    });

    await createCharacterProfile(rootPath, {
      name: "Taren Dane",
      roleTier: "supporting",
      speakingStyle: "Dry and skeptical.",
      backgroundSummary: "Keeps score longer than he admits.",
      functionInBook: "Ally under tension.",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Harbor Return",
      frontmatter: {
        summary: "Lyra returns under pressure.",
      },
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-harbor-return",
      number: 1,
      title: "At The Gate",
      body: "Lyra reaches the gate with the harbor already watching.",
    });

    await createChapter(rootPath, {
      number: 2,
      title: "Ledger Fire",
      frontmatter: {
        summary: "Tension becomes alliance.",
      },
    });

    await createParagraph(rootPath, {
      chapter: "chapter:002-ledger-fire",
      number: 1,
      title: "Ash Mark",
      body: "Lyra and Taren compare what the false ledger means.",
    });

    await syncAllResumes(rootPath);

    const chapterOneResumePath = path.join(rootPath, "resumes", "chapters", "001-harbor-return.md");
    const chapterOneResume = await readFile(chapterOneResumePath, "utf8");
    await writeFile(
      chapterOneResumePath,
      chapterOneResume.replace(
        "chapter: chapter:001-harbor-return\n",
        [
          "chapter: chapter:001-harbor-return",
          "state_changes:",
          '  conditions:',
          '    "character:lyra-vale":',
          '      - alert',
          '      - exhausted',
          '  relationship_updates:',
          '    "character:lyra-vale":',
          '      "character:taren-dane": wary-trust',
          '  open_loops_add:',
          '    - find-the-ledger',
          '    - warn-taren-about-the-forgery',
          "",
        ].join("\n"),
      ),
      "utf8",
    );

    const chapterTwoResumePath = path.join(rootPath, "resumes", "chapters", "002-ledger-fire.md");
    const chapterTwoResume = await readFile(chapterTwoResumePath, "utf8");
    await writeFile(
      chapterTwoResumePath,
      chapterTwoResume.replace(
        "chapter: chapter:002-ledger-fire\n",
        [
          "chapter: chapter:002-ledger-fire",
          "state_changes:",
          '  conditions:',
          '    "character:lyra-vale":',
          '      - focused',
          '  relationship_updates:',
          '    "character:lyra-vale":',
          '      "character:taren-dane": guarded-loyalty',
          '  open_loops_add:',
          '    - expose-the-council-ledger',
          '  open_loops_resolved:',
          '    - find-the-ledger',
          "",
        ].join("\n"),
      ),
      "utf8",
    );

    await syncStoryState(rootPath);

    const relationshipArc = await queryCanon(rootPath, "How does Lyra Vale's relationship with Taren Dane change between chapter 1 and chapter 2?");
    const conditionArc = await queryCanon(rootPath, "How does Lyra Vale's condition change between chapter 1 and chapter 2?");
    const openLoopsArc = await queryCanon(rootPath, "What open loops change between chapter 1 and chapter 2?");

    assert.equal(relationshipArc.intent, "state-relationship-arc");
    assert.match(relationshipArc.answer, /wary trust/i);
    assert.match(relationshipArc.answer, /guarded loyalty/i);
    assert.equal(relationshipArc.fromChapter, "chapter:001-harbor-return");
    assert.equal(relationshipArc.toChapter, "chapter:002-ledger-fire");

    assert.equal(conditionArc.intent, "state-condition-arc");
    assert.match(conditionArc.answer, /alert/i);
    assert.match(conditionArc.answer, /focused/i);

    assert.equal(openLoopsArc.intent, "state-open-loops-arc");
    assert.match(openLoopsArc.answer, /find the ledger/i);
    assert.match(openLoopsArc.answer, /expose the council ledger/i);
    assert.match(openLoopsArc.answer, /resolved/i);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("reviseParagraph proposes edits without writing files and suggests continuity review when needed", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-revise-paragraph-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Revision Test Book",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Measured and controlled.",
      backgroundSummary: "Returns to the harbor under pressure.",
      functionInBook: "Primary viewpoint anchor.",
    });

    await createCharacterProfile(rootPath, {
      name: "Taren Dane",
      roleTier: "supporting",
      speakingStyle: "Dry and skeptical.",
      backgroundSummary: "Harbor ally with a long memory.",
      functionInBook: "Pressure point for Lyra's choices.",
    });

    await createLocationProfile(rootPath, {
      name: "Gray Harbor",
      atmosphere: "Salt fog, cold brick, and watchful silence.",
      functionInBook: "Makes every movement feel observed.",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Pressure At The Gate",
      frontmatter: {
        pov: ["character:lyra-vale"],
      },
    });

    const paragraph = await createParagraph(rootPath, {
      chapter: "chapter:001-pressure-at-the-gate",
      number: 1,
      title: "Watching Walls",
      frontmatter: {
        viewpoint: "character:lyra-vale",
      },
      body: "# Scene\n\nLyra was very tired, and she felt cornered in Gray Harbor. She needed to warn Taren before the watch sealed the gate, and she realized that the registry seal had been pressed at the wrong angle.",
    });

    const result = await reviseParagraph(rootPath, {
      chapter: "chapter:001-pressure-at-the-gate",
      paragraph: "001-watching-walls",
      mode: "tension",
      intensity: "medium",
    });
    const currentParagraph = await readFile(paragraph.filePath, "utf8");

    assert.notEqual(result.proposedBody, result.originalBody);
    assert.match(result.proposedBody, /exhausted/i);
    assert.equal(result.continuityImpact, "clear");
    assert.equal(result.shouldReviewStateChanges, true);
    assert.equal(result.mode, "tension");
    assert.equal(result.intensity, "medium");
    assert.match(JSON.stringify(result.suggestedStateChanges), /character:lyra-vale/);
    assert.match(JSON.stringify(result.suggestedStateChanges), /location:gray-harbor/);
    assert.match(JSON.stringify(result.suggestedStateChanges), /warn-taren/);
    assert.match(JSON.stringify(result.suggestedStateChanges), /registry-seal/);
    assert.ok(result.editorialNotes.length > 0);
    assert.match(currentParagraph, /very tired/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("reviseChapter proposes a chapter-level plan without writing files", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-revise-chapter-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Revision Chapter Test Book",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Measured and controlled.",
      backgroundSummary: "Moves under surveillance.",
      functionInBook: "Primary viewpoint anchor.",
    });

    await createCharacterProfile(rootPath, {
      name: "Taren Dane",
      roleTier: "supporting",
      speakingStyle: "Dry and skeptical.",
      backgroundSummary: "Knows the harbor's fault lines.",
      functionInBook: "Pressure point and ally.",
    });

    await createLocationProfile(rootPath, {
      name: "Gray Harbor",
      atmosphere: "Salt fog and watchful stone.",
      functionInBook: "Turns arrival into scrutiny.",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Pressure At The Gate",
      frontmatter: {
        pov: ["character:lyra-vale"],
      },
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-pressure-at-the-gate",
      number: 1,
      title: "Watching Walls",
      frontmatter: {
        viewpoint: "character:lyra-vale",
      },
      body: "# Scene\n\nLyra was very tired, and she felt cornered in Gray Harbor. She needed to warn Taren before the watch sealed the gate, and she realized that the registry seal had been pressed at the wrong angle.",
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-pressure-at-the-gate",
      number: 2,
      title: "Low Voices",
      frontmatter: {
        viewpoint: "character:lyra-vale",
      },
      body: "# Scene\n\nTaren kept his voice very low, and Lyra noticed that the fear in his face did not match the calm in his words. She was very alert, and she knew they had to move before the next bell.",
    });

    const result = await reviseChapter(rootPath, {
      chapter: "chapter:001-pressure-at-the-gate",
      mode: "pacing",
      intensity: "medium",
    });
    const firstParagraph = await readFile(path.join(rootPath, "chapters", "001-pressure-at-the-gate", "001-watching-walls.md"), "utf8");

    assert.equal(result.mode, "pacing");
    assert.equal(result.sceneCount, 2);
    assert.ok(result.changedSceneCount >= 1);
    assert.equal(result.overallContinuityImpact, "clear");
    assert.ok(result.chapterDiagnosis.length > 0);
    assert.ok(result.revisionPlan.length > 0);
    assert.ok(result.proposedParagraphs.length >= 1);
    assert.match(JSON.stringify(result.suggestedStateChanges), /warn-taren/i);
    assert.match(JSON.stringify(result.suggestedStateChanges), /character:lyra-vale/);
    assert.match(result.revisionPlan.join("\n"), /Watching Walls|Low Voices/);
    assert.match(firstParagraph, /very tired/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("asset prompts and renames keep asset folders aligned", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-assets-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Asset Test Book",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Controlled and observant.",
      backgroundSummary: "Raised around covert trade.",
      functionInBook: "Primary viewpoint anchor.",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "The Arrival",
      frontmatter: {
        pov: ["character:lyra-vale"],
      },
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-the-arrival",
      number: 1,
      title: "At The Gate",
      frontmatter: {
        viewpoint: "character:lyra-vale",
      },
    });

    await createAssetPrompt(rootPath, {
      subject: "character:lyra-vale",
      body: "# Prompt\n\nPortrait of Lyra Vale in harbor light.",
    });

    await createAssetPrompt(rootPath, {
      subject: "chapter:001-the-arrival",
      body: "# Prompt\n\nA cinematic portrait scene for the chapter opener.",
    });

    await createAssetPrompt(rootPath, {
      subject: "paragraph:001-the-arrival:001-at-the-gate",
      body: "# Prompt\n\nLyra arriving at the gate in fog.",
    });

    const sourceImagePath = path.join(rootPath, "source-cover.png");
    await writeFile(sourceImagePath, "fake-image", "utf8");
    await registerAsset(rootPath, {
      subject: "book",
      assetKind: "cover",
      sourceFilePath: sourceImagePath,
      body: "# Prompt\n\nBook cover prompt.",
    });

    await renameEntity(rootPath, {
      kind: "character",
      slugOrId: "lyra-vale",
      newNameOrTitle: "Lyra Voss",
    });

    await renameChapter(rootPath, {
      chapter: "chapter:001-the-arrival",
      newTitle: "The Crossing",
    });

    await renameParagraph(rootPath, {
      chapter: "chapter:001-the-crossing",
      paragraph: "001-at-the-gate",
      newTitle: "At The Bridge",
    });

    const character = await readEntity(rootPath, "character", "lyra-voss");
    const chapter = await readChapter(rootPath, "chapter:001-the-crossing");
    const characterAssetPrompt = await readFile(path.join(rootPath, "assets", "characters", "lyra-voss", "primary.md"), "utf8");
    const paragraphAssetPrompt = await readFile(path.join(rootPath, "assets", "chapters", "001-the-crossing", "paragraphs", "001-at-the-bridge", "primary.md"), "utf8");
    const coverImage = await readFile(path.join(rootPath, "assets", "book", "cover.png"), "utf8");
    const validation = await validateBook(rootPath);

    assert.equal(character.metadata.name, "Lyra Voss");
    assert.deepEqual(character.metadata.former_names, ["Lyra Vale"]);
    assert.match(character.metadata.aliases.join(", "), /Lyra Vale/);
    assert.equal(chapter.metadata.id, "chapter:001-the-crossing");
    assert.equal(chapter.paragraphs[0].metadata.id, "paragraph:001-the-crossing:001-at-the-bridge");
    assert.match(characterAssetPrompt, /subject: character:lyra-voss/);
    assert.match(paragraphAssetPrompt, /subject: paragraph:001-the-crossing:001-at-the-bridge/);
    assert.equal(coverImage, "fake-image");
    assert.equal(validation.valid, true);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("upgradeBookRepo refreshes managed scaffolding and preserves author files", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-upgrade-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Upgrade Test Book",
      language: "it",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Upgrade Arrival",
      body: "# Purpose\n\nPlaceholder chapter body.",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:001-upgrade-arrival",
      number: 1,
      title: "Linked Scene",
      body: "# Scene\n\nPlaceholder scene body.",
    });
    await createParagraphDraft(rootPath, {
      chapter: "chapter:001-upgrade-arrival",
      number: 2,
      title: "Linked Draft",
      body: "# Rough Scene\n\nPlaceholder draft body.",
    });

    await writeFile(path.join(rootPath, "opencode.jsonc"), '{"legacy":true}\n', "utf8");
    await writeFile(path.join(rootPath, ".opencode", "commands", "resume-book.md"), "old command\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "writing-style.md"), "# Custom Writing Style\n\nKeep this intact.\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "prose.md"), "# Legacy Prose\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "style.md"), "# Legacy Style\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "voices.md"), "# Legacy Voices\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "chapter-rules.md"), "# Legacy Chapter Rules\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "structure.md"), "# Legacy Structure\n", "utf8");
    await mkdir(path.join(rootPath, "guidelines", "styles"), { recursive: true });
    await writeFile(path.join(rootPath, "guidelines", "styles", "legacy.md"), "# Legacy Style Profile\n", "utf8");
    await writeFile(
      path.join(rootPath, "chapters", "001-upgrade-arrival", "chapter.md"),
      (await readFile(path.join(rootPath, "chapters", "001-upgrade-arrival", "chapter.md"), "utf8")).replace(
        "Placeholder chapter body.",
        "[Lyra Vale](../../characters/lyra-vale/) reaches [Gray Harbor](../../locations/gray-harbor/).",
      ),
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "chapters", "001-upgrade-arrival", "001-linked-scene.md"),
      (await readFile(path.join(rootPath, "chapters", "001-upgrade-arrival", "001-linked-scene.md"), "utf8")).replace(
        "Placeholder scene body.",
        "[Brass Key](../../items/brass-key/) stays hidden beside the [external archive](https://example.com/archive).",
      ),
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "drafts", "001-upgrade-arrival", "002-linked-draft.md"),
      (await readFile(path.join(rootPath, "drafts", "001-upgrade-arrival", "002-linked-draft.md"), "utf8")).replace(
        "Placeholder draft body.",
        "[Mariamne](../../characters/mariamne-ii/) studies the [Harbor Lockdown](../../timelines/events/harbor-lockdown/).",
      ),
      "utf8",
    );

    const result = await upgradeBookRepo(rootPath);
    const opencodeConfig = await readFile(path.join(rootPath, "opencode.jsonc"), "utf8");
    const resumeCommand = await readFile(path.join(rootPath, ".opencode", "commands", "resume-book.md"), "utf8");
    const writingStyle = await readFile(path.join(rootPath, "guidelines", "writing-style.md"), "utf8");
    const chapterFile = await readFile(path.join(rootPath, "chapters", "001-upgrade-arrival", "chapter.md"), "utf8");
    const paragraphFile = await readFile(path.join(rootPath, "chapters", "001-upgrade-arrival", "001-linked-scene.md"), "utf8");
    const draftFile = await readFile(path.join(rootPath, "drafts", "001-upgrade-arrival", "002-linked-draft.md"), "utf8");

    assert.match(opencodeConfig, /"legacy": true/);
    assert.match(opencodeConfig, /\.github\/copilot-instructions\.md/);
    assert.match(resumeCommand, /resume_book_context/);
    assert.equal(writingStyle, "# Custom Writing Style\n\nKeep this intact.\n");
    assert.match(result.updated.join("\n"), /resume-book\.md/);
    assert.match(result.updated.join("\n"), /opencode\.jsonc/);
    assert.match(result.updated.join("\n"), /guidelines\/prose\.md/);
    assert.match(result.updated.join("\n"), /guidelines\/styles/);
    assert.deepEqual(result.migrated, [
      "chapters/001-upgrade-arrival/001-linked-scene.md",
      "chapters/001-upgrade-arrival/chapter.md",
      "drafts/001-upgrade-arrival/002-linked-draft.md",
    ]);
    assert.equal(await access(path.join(rootPath, "guidelines", "prose.md")).then(() => true).catch(() => false), false);
    assert.equal(await access(path.join(rootPath, "guidelines", "styles")).then(() => true).catch(() => false), false);
    assert.match(chapterFile, /Lyra Vale reaches Gray Harbor\./);
    assert.doesNotMatch(chapterFile, /\]\(\.\.\/\.\.\/(characters|locations)\//);
    assert.match(paragraphFile, /Brass Key stays hidden beside the \[external archive\]\(https:\/\/example\.com\/archive\)\./);
    assert.doesNotMatch(paragraphFile, /\]\(\.\.\/\.\.\/items\//);
    assert.match(draftFile, /Mariamne studies the Harbor Lockdown\./);
    assert.doesNotMatch(draftFile, /\]\(\.\.\/\.\.\/(characters|timelines)\//);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("story prose normalizes internal canon markdown links into plain text on write", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-plain-mentions-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Plain Mention Book",
      language: "en",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Linked Arrival",
      body: "# Purpose\n\n[Lyra Vale](../../characters/lyra-vale/) reaches [Gray Harbor](../../locations/gray-harbor/).",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:001-linked-arrival",
      number: 1,
      title: "Gate Ledger",
      body: "# Scene\n\n[Lyra Vale](character:lyra-vale) hides the [Brass Key](../../items/brass-key.md) and keeps an [external archive](https://example.com/archive).",
    });
    await updateParagraph(rootPath, {
      chapter: "chapter:001-linked-arrival",
      paragraph: "001-gate-ledger",
      appendBody: "[Harbor Council](../factions/harbor-council/) waits behind the glass.",
    });
    await createParagraphDraft(rootPath, {
      chapter: "chapter:001-linked-arrival",
      number: 2,
      title: "Draft Watch",
      body: "# Rough Scene\n\n[Mariamne](../../characters/mariamne-ii/) studies the [Harbor Lockdown](../../timelines/events/harbor-lockdown/).",
    });
    await createParagraphFromDraft(rootPath, {
      chapter: "chapter:001-linked-arrival",
      paragraph: "002-draft-watch",
    });

    const chapterFile = await readFile(path.join(rootPath, "chapters", "001-linked-arrival", "chapter.md"), "utf8");
    const paragraphFile = await readFile(path.join(rootPath, "chapters", "001-linked-arrival", "001-gate-ledger.md"), "utf8");
    const draftFile = await readFile(path.join(rootPath, "drafts", "001-linked-arrival", "002-draft-watch.md"), "utf8");
    const promotedFile = await readFile(path.join(rootPath, "chapters", "001-linked-arrival", "002-draft-watch.md"), "utf8");

    assert.match(chapterFile, /Lyra Vale reaches Gray Harbor\./);
    assert.doesNotMatch(chapterFile, /\]\(\.\.\/\.\.\/(characters|locations)\//);
    assert.match(paragraphFile, /Lyra Vale hides the Brass Key/);
    assert.match(paragraphFile, /Harbor Council waits behind the glass\./);
    assert.match(paragraphFile, /\[external archive\]\(https:\/\/example\.com\/archive\)/);
    assert.doesNotMatch(paragraphFile, /character:lyra-vale/);
    assert.doesNotMatch(paragraphFile, /\]\((?:\.\.\/)?(?:characters|items|factions)\//);
    assert.match(draftFile, /Mariamne studies the Harbor Lockdown\./);
    assert.doesNotMatch(draftFile, /\]\(\.\.\/\.\.\/(characters|timelines)\//);
    assert.match(promotedFile, /Mariamne studies the Harbor Lockdown\./);
    assert.doesNotMatch(promotedFile, /\]\(\.\.\/\.\.\/(characters|timelines)\//);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("writing contexts stay scoped to story so far without leaking later scenes or chapters", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-point-in-time-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Point In Time Book",
      language: "en",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Harbor Arrival",
      frontmatter: {
        summary: "Lyra reaches the harbor under rain.",
      },
      body: "# Purpose\n\nOpen with rain and scrutiny.",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:001-harbor-arrival",
      number: 1,
      title: "Rain Gate",
      frontmatter: {
        summary: "Lyra enters through the rain gate.",
      },
      body: "# Scene\n\nRain clung to the harbor gate as Lyra arrived.",
    });

    await createChapter(rootPath, {
      number: 2,
      title: "Ledger Suspicion",
      frontmatter: {
        summary: "Lyra notices the ledger has been touched.",
      },
      body: "# Purpose\n\nTighten suspicion around the records.",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:002-ledger-suspicion",
      number: 1,
      title: "Broken Seal",
      frontmatter: {
        summary: "Lyra spots the broken wax before speaking.",
      },
      body: "# Scene\n\nLyra saw the broken wax before anyone answered her.",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:002-ledger-suspicion",
      number: 2,
      title: "Tense Exchange",
      frontmatter: {
        summary: "Lyra presses the clerk without blinking.",
      },
      body: "# Scene\n\nLyra asked the clerk who had touched the ledger.",
    });
    await createParagraph(rootPath, {
      chapter: "chapter:002-ledger-suspicion",
      number: 3,
      title: "Future Alarm",
      frontmatter: {
        summary: "A bell rings from the tower after the exchange.",
      },
      body: "# Scene\n\nThe bell from the tower rang after the exchange was over.",
    });

    await createChapter(rootPath, {
      number: 3,
      title: "Bell Tower Betrayal",
      frontmatter: {
        summary: "A bell tower betrayal exposes the next move.",
      },
      body: "# Purpose\n\nFuture betrayal at the bell tower.",
    });

    await syncAllResumes(rootPath);
    await syncPlot(rootPath);

    const chapterContext = await buildChapterWritingContext(rootPath, "chapter:002-ledger-suspicion");
    const paragraphContext = await buildParagraphWritingContext(rootPath, "chapter:002-ledger-suspicion", "002-tense-exchange");
    const resumeContext = await buildResumeBookContext(rootPath, {
      chapter: "chapter:002-ledger-suspicion",
      paragraph: "002-tense-exchange",
    });

    assert.match(chapterContext.text, /Story so far before this chapter/);
    assert.match(chapterContext.text, /Stable book context/);
    assert.match(chapterContext.text, /Lyra reaches the harbor under rain/);
    assert.doesNotMatch(chapterContext.text, /bell tower betrayal/i);
    assert.doesNotMatch(chapterContext.text, /Future betrayal at the bell tower/i);

    assert.match(paragraphContext.text, /Prior scenes in this chapter before this paragraph/);
    assert.match(paragraphContext.text, /Lyra spots the broken wax before speaking/);
    assert.match(paragraphContext.text, /Lyra asked the clerk who had touched the ledger/);
    assert.doesNotMatch(paragraphContext.text, /A bell rings from the tower after the exchange/);
    assert.doesNotMatch(paragraphContext.text, /bell tower betrayal/i);

    assert.match(resumeContext.text, /before paragraph 002-tense-exchange/);
    assert.match(resumeContext.text, /Stable book context/);
    assert.match(resumeContext.text, /Lyra spots the broken wax before speaking/);
    assert.doesNotMatch(resumeContext.text, /A bell rings from the tower after the exchange/);
    assert.doesNotMatch(resumeContext.text, /bell tower betrayal/i);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("chapter writing contexts always include the global writing style and surface chapter-specific writing-style files when present", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-writing-style-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Style Profile Test Book",
      language: "en",
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Default Voice Chapter",
    });

    const defaultContext = await buildChapterWritingContext(rootPath, "chapter:001-default-voice-chapter");

    await createChapterDraft(rootPath, {
      number: 2,
      title: "Glass Confession",
      body: "# Rough Intent\n\nMake the confession intimate and immediate.",
    });

    await writeFile(
      path.join(rootPath, "drafts", "002-glass-confession", "writing-style.md"),
      `---
type: guideline
id: guideline:chapter-writing-style
title: Chapter Writing Style
scope: chapter-writing-style
---

# Local Override

- Use first-person confession with clipped pressure.
- Keep physicality close to the speaking body.
`,
      "utf8",
    );

    const styledContext = await buildChapterWritingContext(rootPath, "chapter:002-glass-confession");
    const promoted = await createChapterFromDraft(rootPath, {
      chapter: "chapter:002-glass-confession",
      body: "# Purpose\n\nKeep the narration close and confessional.",
    });
    const styledChapter = await readChapter(rootPath, "chapter:002-glass-confession");

    assert.match(defaultContext.text, /Always-read writing style/);
    assert.match(defaultContext.text, /guidelines\/writing-style\.md/);
    assert.match(defaultContext.text, /Chapter-specific writing style: none in final chapter files/);
    assert.match(styledContext.text, /Always use the global writing style from guidelines\/writing-style\.md/);
    assert.match(styledContext.text, /Draft-specific writing style: drafts\/002-glass-confession\/writing-style\.md/);
    assert.match(styledContext.text, /Use first-person confession with clipped pressure/);
    assert.equal(styledChapter.metadata.title, "Glass Confession");
    assert.match(promoted.filePath, /chapter\.md$/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("findWikipediaResearchSnapshot reuses saved research before a fresh fetch is needed", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-research-reuse-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Research Reuse Book",
      language: "en",
    });

    const savedPath = await writeWikipediaResearchSnapshot(rootPath, {
      title: "Venice",
      pageUrl: "https://en.wikipedia.org/wiki/Venice",
      summary: "Venice is built across a lagoon.",
      body: "Description: Existing research snapshot.",
    });

    const snapshot = await findWikipediaResearchSnapshot(rootPath, {
      title: "Venice",
    });

    assert.equal(snapshot?.filePath, savedPath);
    assert.match(snapshot?.relativePath ?? "", /research\/wikipedia\/venice\.md/);
    assert.equal(snapshot?.sourceUrl, "https://en.wikipedia.org/wiki/Venice");
    assert.match(snapshot?.retrievedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.match(snapshot?.body ?? "", /Existing research snapshot/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("draft workflow can assemble writing context and promote drafts into final prose", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-drafts-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Draft Test Book",
      language: "it",
    });

    await createChapterDraft(rootPath, {
      number: 1,
      title: "La Soglia",
      frontmatter: {
        summary: "Brutta del capitolo di apertura.",
        pov: ["character:livia-sarne"],
      },
      body: "# Rough Intent\n\nAprire con sospetto e controllo.\n\n# Rough Beats\n\n- Livia arriva al varco.\n- Nota un cambio nei registri.",
    });

    await createParagraphDraft(rootPath, {
      chapter: "chapter:001-la-soglia",
      number: 1,
      title: "Il Varco",
      frontmatter: {
        summary: "Brutta della prima scena.",
        viewpoint: "character:livia-sarne",
      },
      body: "# Rough Scene\n\nLivia vede il sigillo sbagliato e capisce che qualcuno ha toccato il registro.",
    });

    await saveBookWorkItem(rootPath, {
      bucket: "notes",
      title: "Registry tension",
      body: "Ricordare che Livia ha un rapporto teso con i registri del porto.",
    });
    await updateBookNotes(rootPath, {
      target: "story-design",
      appendBody: "## Main Arcs\n\n- Il sospetto sui registri deve intrecciarsi con il tema dell'identita nascosta.",
    });
    await saveChapterDraftWorkItem(rootPath, {
      chapter: "chapter:001-la-soglia",
      bucket: "notes",
      title: "Arrival pressure",
      body: "Tenere alta la tensione appena Livia arriva al varco.",
    });

    const context = await buildParagraphWritingContext(rootPath, "chapter:001-la-soglia", "001-il-varco");
    const chapterResult = await createChapterFromDraft(rootPath, {
      chapter: "chapter:001-la-soglia",
      body: "# Purpose\n\nAprire il romanzo con pressione e sospetto.",
    });
    const paragraphResult = await createParagraphFromDraft(rootPath, {
      chapter: "chapter:001-la-soglia",
      paragraph: "001-il-varco",
      body: "# Scene\n\nLivia poso la mano sul registro e capi dal taglio della ceralacca che qualcuno era arrivato prima di lei.",
    });

    await writeFile(
      path.join(rootPath, "conversations", "RESUME.md"),
      "# Conversation Resume\n\nUltimo focus: aprire il romanzo con sospetto e controllo.\n",
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "conversations", "CONTINUATION.md"),
      "# Continuation\n\nRiparti da Livia, dal varco, e dal dubbio sui registri.\n",
      "utf8",
    );
    await writeFile(
      path.join(rootPath, "conversations", "sessions", "20260310-0000--la-soglia--abc.md"),
      "# Conversation Export\n\nLivia deve entrare in scena con tensione immediata.\n",
      "utf8",
    );

    const resumeContext = await buildResumeBookContext(rootPath);

    const chapter = await readChapter(rootPath, "chapter:001-la-soglia");

    assert.match(context.text, /guidelines\/writing-style\.md/);
    assert.match(context.text, /story-design\.md/);
    assert.match(context.text, /notes\.md/);
    assert.match(context.text, /rapporto teso con i registri del porto/);
    assert.match(context.text, /identita nascosta/);
    assert.match(context.text, /Tenere alta la tensione appena Livia arriva al varco/);
    assert.match(context.text, /plot\.md/);
    assert.match(context.text, /Rough Scene/);
    assert.match(resumeContext.text, /Conversation Resume/);
    assert.match(resumeContext.text, /Livia deve entrare in scena/);
    assert.equal(chapterResult.frontmatter.summary, "Brutta del capitolo di apertura.");
    assert.equal(paragraphResult.frontmatter.summary, "Brutta della prima scena.");
    assert.equal(chapter.paragraphs[0].metadata.viewpoint, "character:livia-sarne");
    assert.match(chapter.paragraphs[0].body, /ceralacca/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("structured ideas and notes can be promoted out of active queues while preserving an archive", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-ideas-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Ideas Test Book",
      language: "en",
    });

    await createChapterDraft(rootPath, {
      number: 1,
      title: "Opening Move",
      body: "# Rough Intent\n\nOpen under pressure.",
    });

    const bookIdea = await saveBookWorkItem(rootPath, {
      bucket: "ideas",
      title: "Ledger crack",
      body: "Let the forged ledger crack open the larger conspiracy.",
      tags: ["plot", "mystery"],
      status: "review",
    });

    const promotedIdea = await promoteBookWorkItem(rootPath, {
      source: "ideas",
      entryId: bookIdea.entry.id,
      promotedTo: "story-design",
      target: "story-design",
    });

    const chapterIdea = await saveChapterDraftWorkItem(rootPath, {
      chapter: "chapter:001-opening-move",
      bucket: "ideas",
      title: "Watch pattern",
      body: "Show the altered watch pattern before the first line of dialogue.",
    });

    const promotedChapterIdea = await promoteChapterDraftWorkItem(rootPath, {
      chapter: "chapter:001-opening-move",
      source: "ideas",
      entryId: chapterIdea.entry.id,
      promotedTo: "draft:chapter:001-opening-move",
      target: "notes",
    });

    const context = await buildChapterWritingContext(rootPath, "chapter:001-opening-move");
    const ideasDocument = await readFile(path.join(rootPath, "ideas.md"), "utf8");
    const promotedDocument = await readFile(path.join(rootPath, "promoted.md"), "utf8");
    const chapterIdeasDocument = await readFile(path.join(rootPath, "drafts", "001-opening-move", "ideas.md"), "utf8");
    const chapterPromotedDocument = await readFile(path.join(rootPath, "drafts", "001-opening-move", "promoted.md"), "utf8");
    const storyDesignDocument = await readFile(path.join(rootPath, "story-design.md"), "utf8");
    const chapterNotesDocument = await readFile(path.join(rootPath, "drafts", "001-opening-move", "notes.md"), "utf8");

    assert.match(ideasDocument, /bucket: ideas/);
    assert.doesNotMatch(ideasDocument, /Ledger crack/);
    assert.match(promotedDocument, /Ledger crack/);
    assert.match(promotedDocument, /promoted_to: story-design/);
    assert.match(storyDesignDocument, /Promoted: Ledger crack/);

    assert.doesNotMatch(chapterIdeasDocument, /Watch pattern/);
    assert.match(chapterPromotedDocument, /Watch pattern/);
    assert.match(chapterPromotedDocument, /promoted_to: draft:chapter:001-opening-move/);
    assert.match(chapterNotesDocument, /Watch pattern/);

    assert.match(context.text, /Chapter draft notes/);
    assert.match(context.text, /Watch pattern/);
    assert.doesNotMatch(context.text, /Ledger crack: Let the forged ledger crack open the larger conspiracy/);
    assert.equal(promotedIdea.targetFilePath?.endsWith("story-design.md"), true);
    assert.equal(promotedChapterIdea.targetFilePath?.endsWith(path.join("drafts", "001-opening-move", "notes.md")), true);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("dialogue action beat review works beat by beat and apply updates only confirmed beats", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "narrarium-dialogue-beats-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Dialogue Beat Book",
      language: "it",
    });

    await createCharacterProfile(rootPath, {
      name: "Sergio",
      roleTier: "supporting",
      speakingStyle: "Spinge con calma apparente finche non ottiene una risposta.",
      backgroundSummary: "Usa il contatto fisico per prendere spazio quando sente di perdere il controllo.",
      functionInBook: "Press the emotional boundaries of the scene.",
      traits: ["controllante", "vanitoso"],
      desires: ["ottenere obbedienza emotiva"],
      fears: ["perdere il controllo della situazione"],
      mannerisms: [],
    });
    await createCharacterProfile(rootPath, {
      name: "Federica",
      roleTier: "supporting",
      speakingStyle: "Taglia corto quando viene messa sotto pressione.",
      backgroundSummary: "Difende i propri confini con reazioni fisiche brusche quando si sente invasa.",
      functionInBook: "Resist Sergio's pressure in the exchange.",
      traits: ["guardinga", "reattiva"],
      desires: ["mantenere autonomia"],
      fears: ["essere controllata"],
      mannerisms: [],
    });

    await createChapter(rootPath, {
      number: 1,
      title: "Pressione",
      frontmatter: {
        pov: ["character:federica"],
      },
      body: "# Purpose\n\nAumentare la tensione fisica del confronto.",
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-pressione",
      number: 1,
      title: "Le mani",
      frontmatter: {
        viewpoint: "character:federica",
      },
      body: [
        "Sergio si spostò i suoi bellissimi capelli da un lato.",
        "«Come stai?» esclamò.",
        "Federica si girò di scatto.",
        "«Benissimo, oggi è una grande giornata».",
        "Sergio si avvicinò con la sua mano destra e le prese la sua mano sinistra.",
        "«Vuoi rendermi felice almeno oggi?»",
        "Federica indietreggiò e andò a sbattere contro il muro.",
        "«Ma sei matto, farmi una richiesta del genere proprio oggi».",
      ].join("\n"),
    });

    const review = await reviewDialogueActionBeats(rootPath, {
      chapter: "chapter:001-pressione",
      paragraph: "001-le-mani",
    });

    assert.equal(review.beatProposals.length, 4);
    assert.match(review.sources.join("\n"), /characters\/sergio\.md/);
    assert.match(review.sources.join("\n"), /characters\/federica\.md/);
    assert.ok(review.beatProposals.some((beat) => beat.purposeAssessment !== "strong"));
    assert.ok(review.beatProposals.every((beat) => beat.choices.some((choice) => choice.usesSaidFallback)));
    assert.ok(review.previewBody !== review.originalBody);
    assert.ok(review.ticSuggestions.length >= 1);

    const selections = review.beatProposals.map((beat) => ({
      beatId: beat.beatId,
      choiceId: beat.recommendedChoiceId,
    }));

    const applied = await applyDialogueActionBeats(rootPath, {
      chapter: "chapter:001-pressione",
      paragraph: "001-le-mani",
      reviewId: review.reviewId,
      expectedParagraphHash: review.paragraphHash,
      selections,
    });

    const paragraph = await readChapter(rootPath, "chapter:001-pressione");
    const updatedBody = paragraph.paragraphs[0].body;

    assert.equal(applied.changedBeatCount, 4);
    assert.equal(applied.updatedBody, updatedBody);
    assert.match(updatedBody, /ridusse la distanza|allungò la mano|cercando col muro una distanza/);
    assert.doesNotMatch(updatedBody, /bellissimi capelli/);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
