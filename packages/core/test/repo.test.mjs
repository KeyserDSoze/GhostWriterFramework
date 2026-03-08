import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createAssetPrompt,
  createChapter,
  createCharacterProfile,
  createLocationProfile,
  createParagraph,
  createTimelineEventProfile,
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
  syncAllResumes,
  updateChapter,
  updateParagraph,
  validateBook,
} from "../dist/index.js";

test("core book workflow supports canon indexes and structural updates", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ghostwriter-core-"));

  try {
    await initializeBookRepo(rootPath, {
      title: "Core Test Book",
      author: "GhostWriter",
      language: "en",
    });

    await createCharacterProfile(rootPath, {
      name: "Lyra Vale",
      roleTier: "main",
      speakingStyle: "Controlled and observant.",
      backgroundSummary: "Raised around covert trade.",
      functionInBook: "Primary viewpoint anchor.",
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

    await createChapter(rootPath, {
      number: 1,
      title: "The Arrival",
    });

    await createParagraph(rootPath, {
      chapter: "chapter:001-the-arrival",
      number: 1,
      title: "At The Gate",
    });

    await updateChapter(rootPath, {
      chapter: "chapter:001-the-arrival",
      frontmatterPatch: {
        summary: "Lyra returns to Gray Harbor and notices the guard routine has changed.",
        pov: ["character:lyra-vale"],
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
    const resumes = await syncAllResumes(rootPath);
    const evaluation = await evaluateBook(rootPath);
    const validation = await validateBook(rootPath);

    assert.equal(characters.length, 1);
    assert.equal(locations.length, 1);
    assert.equal(events.length, 1);
    assert.equal(character.metadata.name, "Lyra Vale");
    assert.ok(timelineMain);
    assert.equal(resumes.chapterCount, 1);
    assert.equal(evaluation.chapterCount, 1);
    assert.equal(validation.valid, true);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("asset prompts and renames keep asset folders aligned", async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ghostwriter-assets-"));

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
