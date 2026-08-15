import assert from "node:assert/strict";
import test from "node:test";
import { isMediaOperationOwned, stopMediaStreamTracks } from "../src/assistant/mediaOwnership.ts";

test("late recorder onstop cannot transcribe or submit after generation cancellation", () => {
  let activeGeneration = 4;
  const expectedGeneration = activeGeneration;
  const controller = new AbortController();
  let transcriptions = 0;
  let submissions = 0;
  const onstop = () => {
    if (!isMediaOperationOwned(activeGeneration, expectedGeneration, controller.signal.aborted)) return;
    transcriptions += 1;
    submissions += 1;
  };

  activeGeneration += 1;
  controller.abort();
  onstop();
  assert.equal(transcriptions, 0);
  assert.equal(submissions, 0);
});

test("late recognition onend cannot submit a captured transcript", () => {
  let activeGeneration = 8;
  const expectedGeneration = activeGeneration;
  const controller = new AbortController();
  let submissions = 0;
  const onend = () => {
    if (isMediaOperationOwned(activeGeneration, expectedGeneration, controller.signal.aborted)) submissions += 1;
  };

  activeGeneration += 1;
  onend();
  assert.equal(submissions, 0);
});

test("late STT or TTS provider responses are ignored after abort", async () => {
  const controller = new AbortController();
  const generation = 12;
  let activeGeneration = generation;
  let appliedResponses = 0;
  let resolveProvider;
  const provider = new Promise((resolve) => { resolveProvider = resolve; });
  const consume = provider.then(() => {
    if (isMediaOperationOwned(activeGeneration, generation, controller.signal.aborted)) appliedResponses += 1;
  });

  activeGeneration += 1;
  controller.abort();
  resolveProvider("late response");
  await consume;
  assert.equal(appliedResponses, 0);
});

test("the active non-aborted media generation retains ownership", () => {
  assert.equal(isMediaOperationOwned(3, 3, false), true);
  assert.equal(isMediaOperationOwned(3, 2, false), false);
  assert.equal(isMediaOperationOwned(3, 3, true), false);
});

test("a stream returned after cancellation has every media track stopped", async () => {
  const stopped = [0, 0];
  const stream = {
    getTracks: () => stopped.map((_, index) => ({ stop: () => { stopped[index] += 1; } })),
  };
  const controller = new AbortController();
  let activeGeneration = 20;
  const generation = activeGeneration;
  let resolveStream;
  const pendingStream = new Promise((resolve) => { resolveStream = resolve; });
  const consume = pendingStream.then((lateStream) => {
    if (!isMediaOperationOwned(activeGeneration, generation, controller.signal.aborted)) stopMediaStreamTracks(lateStream);
  });

  activeGeneration += 1;
  controller.abort();
  resolveStream(stream);
  await consume;
  assert.deepEqual(stopped, [1, 1]);
});
