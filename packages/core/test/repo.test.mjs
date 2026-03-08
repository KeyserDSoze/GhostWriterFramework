import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createChapter,
  createCharacterProfile,
  createLocationProfile,
  createParagraph,
  createTimelineEventProfile,
  evaluateBook,
  initializeBookRepo,
  listEntities,
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
