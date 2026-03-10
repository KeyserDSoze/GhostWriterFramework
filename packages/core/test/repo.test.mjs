import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  buildParagraphWritingContext,
  buildResumeBookContext,
  createAssetPrompt,
  createChapter,
  createChapterDraft,
  createChapterFromDraft,
  createCharacterProfile,
  createLocationProfile,
  createParagraph,
  createParagraphDraft,
  createParagraphFromDraft,
  createSecretProfile,
  createTimelineEventProfile,
  doctorBook,
  evaluateBook,
  initializeBookRepo,
  listEntities,
  registerAsset,
  renameChapter,
  renameEntity,
  renameParagraph,
  readChapter,
  readEntity,
  readTimelineMain,
  syncPlot,
  syncAllResumes,
  syncStoryState,
  syncTotalResume,
  upgradeBookRepo,
  updateChapter,
  updateEntity,
  updateParagraph,
  validateBook,
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
          '  relationship_updates:',
          '    "character:lyra-vale":',
          '      "character:harbor-guard": wary',
          '  open_loops_add:',
          '    - find-the-ledger',
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
    const syncedChapterResume = await readFile(chapterResumePath, "utf8");
    const currentStoryState = await readFile(path.join(rootPath, "state", "current.md"), "utf8");
    const storyStateStatus = await readFile(path.join(rootPath, "state", "status.md"), "utf8");
    const doctorCodes = doctor.issues.map((issue) => issue.code);

    assert.equal(characters.length, 1);
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
    assert.match(opencodeConfig, /"default_agent": "build"/);
    assert.match(opencodeConfig, /"reasoningEffort": "high"/);
    assert.match(opencodeConfig, /"textVerbosity": "high"/);
    assert.match(opencodeConfig, /"watcher"/);
    assert.match(conversationsReadme, /portable exports of OpenCode/);
    assert.match(resumeCommand, /resume_book_context/);
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

    await writeFile(path.join(rootPath, "opencode.jsonc"), '{"legacy":true}\n', "utf8");
    await writeFile(path.join(rootPath, ".opencode", "commands", "resume-book.md"), "old command\n", "utf8");
    await writeFile(path.join(rootPath, "guidelines", "prose.md"), "# Custom Prose\n\nKeep this intact.\n", "utf8");

    const result = await upgradeBookRepo(rootPath);
    const opencodeConfig = await readFile(path.join(rootPath, "opencode.jsonc"), "utf8");
    const resumeCommand = await readFile(path.join(rootPath, ".opencode", "commands", "resume-book.md"), "utf8");
    const proseGuide = await readFile(path.join(rootPath, "guidelines", "prose.md"), "utf8");

    assert.match(opencodeConfig, /"default_agent": "build"/);
    assert.match(resumeCommand, /resume_book_context/);
    assert.equal(proseGuide, "# Custom Prose\n\nKeep this intact.\n");
    assert.match(result.updated.join("\n"), /opencode\.jsonc/);
    assert.ok(result.backedUp.length >= 2);
    assert.ok(result.backupRoot);
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

    assert.match(context.text, /guidelines\/prose\.md/);
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
