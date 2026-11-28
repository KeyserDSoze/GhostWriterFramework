import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The analysis of the whole structure of a design: a specialist reads every chapter together for what does not hold together and says where it is, which chapters must be
// revised to fix it, and what to do; its findings are merged with the checks that need no model under one id each, so that a decision about a finding holds when the analysis
// is made again; the director decides about them, and what is critical and not dismissed blocks the approval of the design.

const {
  COHERENCE_FINDINGS_KEPT,
  COHERENCE_FINDINGS_PER_CALL,
  COHERENCE_OVERLAP,
  COHERENCE_WINDOW,
  AutopilotSession,
  applyFindingDecisions,
  blockingFindings,
  checkFindings,
  coherenceId,
  coherenceKindOf,
  coherenceSection,
  coherenceSignature,
  coherenceWindows,
  findingNote,
  loadBookSnapshot,
  mergeCoherence,
  nextDesignReview,
  normalizeAutopilotState,
  normalizeCoherence,
  normalizeDesignStart,
  ownerOf,
  parseAutopilotState,
  readCoherenceFindings,
  readFindingDecisions,
  serializeAutopilotState,
  serializeOutlineChapter,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";

const finding = (extra = {}) => ({
  id: "a-00000001",
  source: "ai",
  kind: "contradiction",
  severity: "major",
  chapters: [2],
  requires: [2],
  text: "Orrin is in the harbor and in the capital on the same day.",
  owner: "autopilot",
  status: "open",
  round: 1,
  seen: 1,
  ...extra,
});

const owners = (map = {}) => new Map(Object.entries(map).map(([number, owner]) => [Number(number), owner]));

test("a kind is named by its id or by what a model says for it, and the id of a finding is the same for the same parts", () => {
  assert.equal(coherenceKindOf("plot-hole"), "plot-hole");
  assert.equal(coherenceKindOf("Plot hole"), "plot-hole");
  assert.equal(coherenceKindOf("premature reveal"), "early-reveal");
  assert.equal(coherenceKindOf("Inconsistency"), "contradiction");
  assert.equal(coherenceKindOf("timeline"), "timeline");
  assert.equal(coherenceKindOf("impossible knowledge"), "knowledge");
  assert.equal(coherenceKindOf("humour"), "other");
  assert.equal(coherenceKindOf(undefined), "other");
  assert.equal(coherenceId("ai", ["a", 1, undefined]), coherenceId("ai", ["a", 1, undefined]));
  assert.notEqual(coherenceId("ai", ["a", 1]), coherenceId("ai", ["a", 2]));
  assert.match(coherenceId("check", ["x"]), /^c-[0-9a-f]{8}$/);
  assert.match(coherenceId("ai", ["x"]), /^a-[0-9a-f]{8}$/);
});

test("who a fix concerns is told from the chapters it revises: the autopilot's, the author's, or both", () => {
  const map = owners({ 1: "autopilot", 2: "author", 3: "autopilot" });
  assert.equal(ownerOf([1, 3], map), "autopilot");
  assert.equal(ownerOf([2], map), "author");
  assert.equal(ownerOf([1, 2], map), "both");
  assert.equal(ownerOf([9], map), "autopilot", "a chapter the book does not know is left out");
  assert.equal(ownerOf([], map), "autopilot");
});

test("the checks of the threads, the timeline and what is told too early are findings of the analysis too, each of its own kind and under an id of its own", () => {
  const checks = [
    { code: "thread-without-payoff", severity: "warning", chapter: 3, thread: { id: "th-1", title: "The missing ledger" } },
    { code: "thread-without-payoff", severity: "warning", chapter: 3, thread: { id: "th-2", title: "The lighthouse debt" } },
    { code: "thread-payoff-before-setup", severity: "warning", chapter: 2, other: 4, thread: { id: "th-1", title: "The missing ledger" } },
    { code: "timeline-order", severity: "info", chapter: 5, other: 4 },
    { code: "character-in-two-places", severity: "warning", chapter: 2, other: 2, name: "Mira Vale", places: ["Glass Harbor", "The Lighthouse"] },
    { code: "reveal-too-early", severity: "warning", chapter: 1, other: 3, secret: { slug: "the-wall", title: "The Wall" } },
    { code: "unknown-secret", severity: "info", chapter: 4, name: "The Tide Key" },
  ];
  const found = checkFindings(checks, "en", owners({ 1: "autopilot", 2: "autopilot", 3: "autopilot", 4: "autopilot", 5: "autopilot" }), 1);
  assert.deepEqual(found.map((entry) => [entry.kind, entry.severity, entry.chapters]), [
    ["subplot", "major", [3]],
    ["subplot", "major", [3]],
    ["subplot", "major", [2, 4]],
    ["timeline", "minor", [5, 4]],
    ["timeline", "major", [2]],
    ["early-reveal", "major", [1, 3]],
    ["secret", "minor", [4]],
  ]);
  assert.equal(new Set(found.map((entry) => entry.id)).size, found.length, "two threads of one chapter are two findings");
  assert.match(found[0].text, /The thread «The missing ledger» is set up in chapter 3 and has no payoff/);
  assert.match(found[4].text, /Mira Vale is in two places at the same time/);
});

test("the findings of the checks that need no model are findings of the analysis: a warning is major, a note minor, never critical, under a stable id", () => {
  const checks = [
    { code: "reveal-before-known", severity: "warning", secret: { slug: "the-wall", title: "The Wall" }, chapter: 2, other: 5 },
    { code: "design-incomplete", severity: "info", chapter: 3, fields: ["ending"] },
    { code: "reveal-missing", severity: "warning", secret: { slug: "the-gift", title: "The Gift" } },
  ];
  const found = checkFindings(checks, "en", owners({ 2: "author", 3: "autopilot", 5: "autopilot" }), 2);
  assert.deepEqual(found.map((entry) => [entry.kind, entry.severity, entry.chapters, entry.requires, entry.owner]), [
    ["early-reveal", "major", [2, 5], [2, 5], "both"],
    ["structure", "minor", [3], [3], "autopilot"],
    ["secret", "major", [], [], "autopilot"],
  ]);
  assert.ok(found.every((entry) => entry.source === "check" && entry.status === "open" && entry.round === 2 && entry.seen === 2 && /^c-[0-9a-f]{8}$/.test(entry.id)));
  assert.match(found[0].text, /«The Wall» is revealed in chapter 2, before the chapter from which the reader may know it \(5\)\./);
  assert.deepEqual(checkFindings(checks, "en", owners(), 7).map((entry) => entry.id), found.map((entry) => entry.id), "the same check, the same id, in any round");
  assert.match(checkFindings(checks, "it", owners(), 1)[2].text, /^Il segreto «The Gift»/);
  assert.equal(new Set(found.map((entry) => entry.id)).size, 3);
});

test("the findings of a reply are checked and read: where, what, what to do, within their limits, naming only the chapters that were read; the rest is rejected, never cut", () => {
  const input = { chapters: new Set([1, 2, 3, 4]), owners: owners({ 1: "autopilot", 2: "author", 3: "autopilot", 4: "autopilot" }), round: 2 };
  const good = { severity: "Critical", kind: "Plot hole", chapters: [2, "3"], requires: [3], text: "Nobody explains how the ledger left the vault.", proposal: "Show the keeper taking it in chapter 3." };
  const [read] = readCoherenceFindings([good], input);
  assert.deepEqual([read.severity, read.kind, read.chapters, read.requires, read.owner, read.status, read.round, read.seen, read.source], ["critical", "plot-hole", [2, 3], [3], "autopilot", "open", 2, 2, "ai"]);
  assert.equal(read.proposal, "Show the keeper taking it in chapter 3.");
  assert.match(read.id, /^a-[0-9a-f]{8}$/);
  assert.equal(readCoherenceFindings([{ ...good, requires: [] }], input)[0].requires.join(), "2,3", "what must be revised is where it is when the reply says nothing");
  assert.equal(readCoherenceFindings([{ ...good, requires: [2] }], input)[0].owner, "author");
  assert.equal(readCoherenceFindings([{ ...good, proposal: "" }], input)[0].proposal, undefined);
  assert.deepEqual(readCoherenceFindings([], input), [], "a structure that holds together");
  const rejected = (value) => {
    try {
      readCoherenceFindings(value, input);
    } catch (error) {
      assert.equal(error.name, "AiReplyRejectedError");
      assert.doesNotMatch(error.message, /secret-token/);
      return error.message;
    }
    return assert.fail("not rejected");
  };
  assert.match(rejected("secret-token"), /^The analysis of the structure was rejected: the field "findings" must be a list/);
  assert.match(rejected(Array.from({ length: COHERENCE_FINDINGS_PER_CALL + 1 }, () => good)), /26 findings were returned, over the 25 allowed: return the most important ones\./);
  assert.match(rejected([{ ...good, severity: "grave" }]), /finding 1 has no severity \(critical, major or minor\)/);
  assert.match(rejected([{ ...good, text: " " }]), /finding 1 says nothing is wrong/);
  assert.match(rejected([{ ...good, text: "x".repeat(501) }]), /the text of finding 1 is 501 characters long, over the 500 allowed: return it shorter, whole/);
  assert.match(rejected([{ ...good, proposal: "x".repeat(351) }]), /the proposal of finding 1 is 351 characters long, over the 350 allowed/);
  assert.match(rejected([{ ...good, chapters: [2, 9] }]), /finding 1 names chapter 9, which was not read/);
  assert.match(rejected([{ ...good, chapters: ["two"] }]), /finding 1 names a chapter that is not a number/);
  assert.match(rejected([{ ...good, chapters: [] }]), /finding 1 does not say which chapters it is about/);
  assert.match(rejected([{ ...good, requires: [7] }]), /finding 1 names chapter 7, which was not read/);
});

test("a later analysis keeps what was decided about what it finds again, fixes what it does not find any more, and opens what is new", () => {
  const dismissed = finding({ id: "a-aaaaaaaa", status: "dismissed", decision: { by: "director", reason: "The design answers it.", at: "t" }, round: 1, seen: 1 });
  const mine = finding({ id: "a-bbbbbbbb", status: "mine", chapters: [4], requires: [4], text: "The ferry runs on a day the harbor is closed.", kind: "timeline", round: 1, seen: 1 });
  const gone = finding({ id: "a-cccccccc", chapters: [6], requires: [6], text: "A subplot about the brothers is never finished.", kind: "subplot" });
  const asking = finding({ id: "a-dddddddd", status: "fixing", chapters: [7], requires: [7], text: "The mayor learns the truth twice.", kind: "repetition", severity: "critical" });
  const fixed = finding({ id: "a-eeeeeeee", status: "fixed", chapters: [8], requires: [8], text: "An old finding that is already fixed.", kind: "other" });
  const dropped = finding({ id: "a-ffffffff", status: "dismissed", chapters: [9], requires: [9], text: "A dismissed one that is not found any more." });
  const previous = [dismissed, mine, gone, asking, fixed, dropped, finding({ id: "a-99999999", status: "mine", chapters: [5], requires: [5], text: "The author's own note about chapter five." })];
  const fresh = [
    // The same trouble, told in other words, with another id and another severity.
    finding({ id: "a-11111111", severity: "minor", text: "Orrin is in the harbor and in the capital on the same day, which cannot be.", round: 3, seen: 3 }),
    finding({ id: "a-22222222", chapters: [4], requires: [4], text: "The ferry runs on a day the harbor is closed, as the calendar says.", kind: "timeline", round: 3, seen: 3 }),
    finding({ id: "a-dddddddd", chapters: [7], requires: [7], text: "The mayor learns the truth twice.", severity: "critical", round: 3, seen: 3 }),
    finding({ id: "a-33333333", chapters: [1, 9], requires: [1], text: "A new problem with the opening.", round: 3, seen: 3, kind: "character" }),
    // The same words, other chapters: a different finding.
    finding({ id: "a-44444444", chapters: [8], requires: [8], text: "An old finding that is already fixed.", round: 3, seen: 3 }),
  ];
  const merged = mergeCoherence(previous, fresh, 3);
  const by = (id) => merged.find((entry) => entry.id === id);
  assert.equal(by("a-aaaaaaaa").status, "dismissed", "a dismissal holds when it is found again, told in other words");
  assert.deepEqual(by("a-aaaaaaaa").decision, { by: "director", reason: "The design answers it.", at: "t" });
  assert.equal(by("a-aaaaaaaa").severity, "minor", "the new reading of its severity");
  assert.equal(by("a-aaaaaaaa").round, 1, "found the first time in the first round");
  assert.equal(by("a-aaaaaaaa").seen, 3);
  assert.equal(by("a-bbbbbbbb").status, "mine");
  assert.equal(by("a-dddddddd").status, "fixing", "what the author asked to be fixed stays asked while it is found");
  assert.equal(by("a-cccccccc").status, "fixed", "not found any more");
  assert.equal(by("a-cccccccc").seen, 1);
  assert.equal(by("a-33333333").status, "open");
  assert.equal(by("a-33333333").round, 3);
  assert.equal(by("a-ffffffff"), undefined, "a dismissed finding that is not found any more is dropped");
  assert.equal(by("a-99999999"), undefined, "so is one the author took");
  assert.equal(by("a-44444444"), undefined, "a fixed finding found again keeps the id it had");
  assert.equal(by("a-eeeeeeee").status, "open", "and is open again");
  assert.equal(merged.filter((entry) => entry.chapters[0] === 8).length, 1);
  // The ones that matter come first.
  const rank = { open: 0, fixing: 0, mine: 0, dismissed: 1, fixed: 2 };
  assert.deepEqual(merged.map((entry) => rank[entry.status]), merged.map((entry) => rank[entry.status]).sort((left, right) => left - right), "the ones still open, then the dismissed, then the fixed");
  assert.equal(merged.at(-1).status, "fixed");
  // The checks keep their ids: the same finding is the same.
  const check = (extra = {}) => finding({ id: "c-12345678", source: "check", kind: "structure", ...extra });
  const again = mergeCoherence([check({ status: "dismissed", decision: { by: "author", at: "t" } })], [check({ round: 2, seen: 2 })], 2);
  assert.equal(again[0].status, "dismissed");
  // A fixed finding found again is open again.
  assert.equal(mergeCoherence([finding({ status: "fixed" })], [finding()], 2)[0].status, "open");
});

test("the findings kept are bounded, and the ones that matter are kept", () => {
  const many = Array.from({ length: COHERENCE_FINDINGS_KEPT + 20 }, (_, index) => finding({ id: `a-${String(index).padStart(8, "0")}`, severity: index === 90 ? "critical" : "minor", chapters: [index + 1], requires: [index + 1], text: `Problem number ${index} about chapter ${index + 1}.` }));
  const merged = mergeCoherence([], many, 1);
  assert.equal(merged.length, COHERENCE_FINDINGS_KEPT);
  assert.equal(merged[0].severity, "critical", "the critical one is kept, and first");
  const old = Array.from({ length: COHERENCE_FINDINGS_KEPT }, (_, index) => finding({ id: `a-${String(index).padStart(8, "0")}`, status: "fixed", chapters: [index + 1], requires: [index + 1], text: `Old problem ${index}.` }));
  const withNew = mergeCoherence(old, [finding({ id: "a-ffffffff", chapters: [500], requires: [500], text: "A new problem that matters." })], 2);
  assert.equal(withNew.length, COHERENCE_FINDINGS_KEPT);
  assert.equal(withNew[0].id, "a-ffffffff", "a fixed finding is the first to go");
});

test("what blocks the approval is what is critical and not dismissed, and what the author asked to be fixed", () => {
  const list = [
    finding({ id: "a-00000001", severity: "critical" }),
    finding({ id: "a-00000002", severity: "critical", status: "dismissed" }),
    finding({ id: "a-00000003", severity: "critical", status: "mine" }),
    finding({ id: "a-00000004", severity: "critical", status: "fixed" }),
    finding({ id: "a-00000005", severity: "major" }),
    finding({ id: "a-00000006", severity: "minor", status: "fixing" }),
  ];
  assert.deepEqual(blockingFindings(list).map((entry) => entry.id), ["a-00000001", "a-00000006"]);
  assert.equal(findingNote(finding({ proposal: "Move the meeting." })), "Orrin is in the harbor and in the capital on the same day. → Move the meeting.");
  assert.equal(findingNote(finding()), "Orrin is in the harbor and in the capital on the same day.");
});

test("the director is told of the findings still open or taken, the ones that matter first, with their id, where, what to revise and whose entries", () => {
  assert.equal(coherenceSection([]), "COHERENCE FINDINGS (by the analysis of the whole structure): none.");
  assert.equal(coherenceSection([finding({ status: "fixed" }), finding({ status: "dismissed" })]), "COHERENCE FINDINGS (by the analysis of the whole structure): none.");
  const text = coherenceSection([
    finding({ id: "a-00000001", severity: "critical", kind: "plot-hole", chapters: [2, 3], requires: [3], proposal: "Show the keeper." }),
    finding({ id: "a-00000002", owner: "author", chapters: [], requires: [], kind: "other" }),
    finding({ id: "a-00000003", owner: "both", status: "fixing", requires: [2, 3] }),
    finding({ id: "a-00000004", status: "mine" }),
  ]);
  assert.match(text, /^COHERENCE FINDINGS \(by the analysis of the whole structure; decide about them by their id in findingDecisions\):\n/);
  assert.match(text, /- \[a-00000001\] critical plot-hole, chapters 2, 3 \(revise: 3\): Orrin is in the harbor[^\n]* → Show the keeper\./);
  assert.match(text, /- \[a-00000002\] major other, the whole book \(revise: -; the author's entries: propose, never rewrite\)/);
  assert.match(text, /- \[a-00000003\] major contradiction, chapters 2 \(revise: 2, 3; some of the author's entries: propose for those; the author asked for it to be fixed\)/);
  assert.match(text, /- \[a-00000004\] major contradiction, chapters 2 \(revise: 2; the author handles it\)/);
  assert.match(coherenceSection(Array.from({ length: 5 }, (_, index) => finding({ id: `a-0000000${index}` })), 3), /- … and 2 more\.$/);
});

test("the director's decisions name findings there are, once, as confirm or dismiss with the reason; a decision about a finding the author took is left out", () => {
  const list = [finding({ id: "a-00000001" }), finding({ id: "a-00000002", status: "fixing" }), finding({ id: "a-00000003", status: "mine" }), finding({ id: "a-00000004" })];
  const ok = readFindingDecisions([
    { id: "[a-00000001]", decision: "Dismiss", reason: "The design already answers it." },
    { id: "a-00000002", decision: "dismiss", reason: "I would rather not." },
    { id: "a-00000003", decision: "dismiss", reason: "Not a problem at all." },
    { id: "a-00000004", decision: "confirm", reason: "" },
  ], list, "The review");
  assert.deepEqual(ok, [{ id: "a-00000001", decision: "dismiss", reason: "The design already answers it." }, { id: "a-00000004", decision: "confirm", reason: "" }], "the author's are the author's");
  assert.deepEqual(readFindingDecisions(undefined, list, "The review"), []);
  assert.deepEqual(readFindingDecisions([], list, "The review"), []);
  const rejected = (value) => {
    try {
      readFindingDecisions(value, list, "The review");
    } catch (error) {
      assert.equal(error.name, "AiReplyRejectedError");
      return error.message;
    }
    return assert.fail("not rejected");
  };
  assert.match(rejected("x"), /the field "findingDecisions" must be a list/);
  assert.match(rejected([{ id: "a-99999999", decision: "confirm" }]), /«a-99999999» is not a finding/);
  assert.match(rejected([{ id: "a-00000001", decision: "confirm" }, { id: "a-00000001", decision: "dismiss", reason: "twice, with a reason" }]), /a-00000001 is decided twice/);
  assert.match(rejected([{ id: "a-00000001", decision: "maybe" }]), /the decision about a-00000001 must be "confirm" or "dismiss"/);
  assert.match(rejected([{ id: "a-00000001", decision: "dismiss", reason: "no" }]), /a-00000001 is dismissed without a reason/);
  assert.match(rejected([{ id: "a-00000001", decision: "confirm", reason: "x".repeat(601) }]), /the reason about a-00000001 is 601 characters long/);
  const applied = applyFindingDecisions(list, ok, "2026-11-28T10:00:00.000Z");
  assert.deepEqual([applied[0].status, applied[0].decision], ["dismissed", { by: "director", reason: "The design already answers it.", at: "2026-11-28T10:00:00.000Z" }]);
  assert.deepEqual(applied.map((entry) => entry.status), ["dismissed", "fixing", "mine", "open"]);
});

test("a long design is read in windows of chapters that overlap, and a short one in one", () => {
  const numbers = (count) => Array.from({ length: count }, (_, index) => index + 1);
  assert.deepEqual(coherenceWindows([]), []);
  assert.deepEqual(coherenceWindows(numbers(3)), [[1, 2, 3]]);
  assert.equal(coherenceWindows(numbers(COHERENCE_WINDOW)).length, 1);
  const windows = coherenceWindows(numbers(COHERENCE_WINDOW + 1));
  assert.equal(windows.length, 2);
  assert.deepEqual([windows[0][0], windows[0].at(-1), windows[1][0], windows[1].at(-1)], [1, COHERENCE_WINDOW, COHERENCE_WINDOW - COHERENCE_OVERLAP + 1, COHERENCE_WINDOW + 1]);
  const long = coherenceWindows(numbers(100));
  assert.deepEqual(long.map((window) => [window[0], window.at(-1)]), [[1, 40], [35, 74], [69, 100]]);
  assert.equal(new Set(long.flat()).size, 100, "every chapter is read");
});

const entry = (number, extra = {}) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body: `What happens in ${number}.`, origin: "autopilot", ...extra });

async function snapshotOf(files) {
  return loadBookSnapshot(new MemoryBookStore({ ...seedBookFiles({ chapters: 0 }), ...files }));
}

test("the signature of the analysis is made of the entries, the secrets and the world: the same files, the same signature, and any change is another", async () => {
  const base = { "outline/chapters/001.md": entry(1), "outline/chapters/002.md": entry(2), "secrets/the-wall.md": "---\ntype: secret\nid: secret:the-wall\nname: The Wall\n---\n\nThe truth.\n", "bible/world.md": "---\ntype: bible\n---\n\nrules:\n" };
  const first = coherenceSignature(await snapshotOf(base));
  assert.match(first, /^[0-9a-f]{8}$/);
  assert.equal(coherenceSignature(await snapshotOf(base)), first);
  for (const change of [
    { "outline/chapters/002.md": entry(2, { body: "Something else." }) },
    { "outline/chapters/003.md": entry(3) },
    { "secrets/the-wall.md": `${base["secrets/the-wall.md"]}A clue.\n` },
    { "bible/world.md": `${base["bible/world.md"]}- glass\n` },
    { "bible/themes.md": "themes\n" },
  ]) assert.notEqual(coherenceSignature(await snapshotOf({ ...base, ...change })), first, JSON.stringify(Object.keys(change)));
  assert.equal(coherenceSignature(await snapshotOf({ ...base, "notes.md": "unrelated" })), first, "nothing else is part of it");
});

test("the planner asks for the analysis after the reviews of the chapters, when the design changed since the last one", async () => {
  const snapshot = await snapshotOf({ "outline/chapters/001.md": entry(1), "outline/chapters/002.md": entry(2) });
  const base = { startedAt: "x", chapters: 2, rounds: [] };
  assert.equal(nextDesignReview({ design: base }, snapshot), null);
  assert.deepEqual(nextDesignReview({ design: { ...base, workflow: { coherence: true } } }, snapshot), { kind: "design-coherence" });
  assert.equal(nextDesignReview({ design: { ...base, workflow: { coherence: true }, coherence: { sig: coherenceSignature(snapshot), round: 1, at: "x", findings: [], summary: "" } } }, snapshot), null);
  assert.equal(nextDesignReview({ design: { ...base, workflow: { coherence: true }, coherence: { sig: "00000000", round: 1, at: "x", findings: [], summary: "" } } }, snapshot).kind, "design-coherence");
  assert.equal(nextDesignReview({ design: { ...base, workflow: { coherence: true, chapterReview: true } } }, snapshot).kind, "design-chapter-review", "the chapters are judged first");
  assert.equal(nextDesignReview({ design: { ...base, workflow: { coherence: true } } }, await snapshotOf({})), null, "a book with no chapter has nothing to analyse");
  assert.deepEqual(normalizeDesignStart({ workflow: { coherence: true } }), { workflow: { coherence: true } });
  assert.throws(() => normalizeDesignStart({ workflow: { coherence: "yes" } }), /design\.workflow\.coherence must be true or false/);
});

test("the analysis of a state file is read back whole, and what is not whole is dropped", () => {
  const whole = { sig: "0123abcd", round: 2, at: "2026-11-28T09:00:00.000Z", summary: "A fine structure.", findings: [finding({ proposal: "Fix it.", decision: { by: "author", reason: "Mine.", at: "2026-11-28T09:00:00.000Z" }, status: "mine" })] };
  assert.deepEqual(normalizeCoherence(JSON.parse(JSON.stringify(whole))), whole);
  assert.equal(normalizeCoherence(undefined), undefined);
  assert.equal(normalizeCoherence({ ...whole, sig: "xyz" }), undefined);
  assert.equal(normalizeCoherence({ ...whole, at: "never" }), undefined);
  const broken = JSON.parse(JSON.stringify(whole));
  broken.findings.push({ ...finding(), id: "nope" }, { ...finding({ id: "a-00000002" }), severity: "grave" }, { ...finding({ id: "a-00000003" }), text: "" }, { ...finding({ id: "a-00000004" }), kind: "weird", status: "weird", owner: "weird", chapters: [3, 3, "x", 0] });
  const read = normalizeCoherence(broken);
  assert.deepEqual(read.findings.map((entry) => entry.id), [whole.findings[0].id, "a-00000004"]);
  assert.deepEqual([read.findings[1].kind, read.findings[1].status, read.findings[1].owner, read.findings[1].chapters], ["other", "open", "autopilot", [3]]);
});

async function describedBook() {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function run(store, ai, start) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { events, state: parseAutopilotState(store.files.get(STATE)), session };
}

const START = (chapters = 6, extra = {}) => ({ design: { chapters, workflow: { coherence: true }, ...extra }, options: { readersOnPlan: false, pauseAfterPlan: false } });
const names = (ai) => ai.calls.map((call) => call.json?.name);

const CRITICAL = { severity: "critical", kind: "plot-hole", chapters: [2, 3], requires: [3], text: "Nobody explains how the ledger left the vault.", proposal: "Show the keeper taking it in chapter 3." };
const MAJOR = { severity: "major", kind: "character", chapters: [4], requires: [4], text: "Orrin acts against his fear of exposure.", proposal: "Let him hide it." };

test("with the analysis on, a specialist reads every chapter together, the findings are kept with where, what to revise and who owns it, and the director is told of them", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    coherence: () => ({ findings: [CRITICAL, MAJOR, { severity: "minor", kind: "repetition", chapters: [5, 6], requires: [6], text: "Chapters 5 and 6 end on the same door.", proposal: "Vary the ending of 6." }], summary: "A sound structure with one hole." }),
    designReview: () => ({ verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: [] }),
  });
  const { state, events } = await run(store, ai, START(6, { review: { maxRounds: 2 } }));
  assert.equal(names(ai).slice(0, 4).join(), "design_concept,chapter_design,design_coherence,design_review");
  const call = ai.calls[2];
  assert.equal(call.capability, "review");
  assert.match(call.system, /You are a panel of independent editorial specialists/);
  assert.match(call.system, /analysing the whole structure of the design of a novel that is not written yet/);
  assert.match(call.user, /Analyse the whole structure of the design\./);
  assert.match(call.user, /THE DESIGN OF THE CHAPTERS:\nChapter 1 «Chapter Title 1»:\nNarrative goal: Goal of chapter 1\./);
  assert.match(call.user, /Chapter 6 «Chapter Title 6»:/);
  assert.match(call.user, /SECRETS AND THEIR LEDGER:\n- The Wall Is Failing/);
  assert.match(call.user, /DESIGN CHECKS \(found without a model\): nothing\./);
  assert.deepEqual(call.json.parameters.properties.findings.items.required, ["severity", "kind", "chapters", "requires", "text", "proposal"]);
  // What was kept: a critical finding is first, and the director is told of it, and it blocks the approval at 9.
  const coherence = state.design.coherence;
  assert.match(coherence.sig, /^[0-9a-f]{8}$/);
  assert.equal(coherence.summary, "A sound structure with one hole.");
  const first = coherence.findings.find((entry) => entry.severity === "critical");
  assert.deepEqual([first.kind, first.chapters, first.requires, first.owner, first.source], ["plot-hole", [2, 3], [3], "autopilot", "ai"]);
  const review = ai.calls[3];
  assert.match(review.user, new RegExp(`COHERENCE FINDINGS \\(by the analysis of the whole structure; decide about them by their id in findingDecisions\\):\\n- \\[${first.id}\\] critical plot-hole, chapters 2, 3 \\(revise: 3\\): Nobody explains`));
  assert.match(review.user, /Decide about the COHERENCE FINDINGS \(findingDecisions, by id\)/);
  assert.deepEqual(review.json.parameters.required.slice(-1), ["findingDecisions"]);
  assert.equal(state.design.rounds[0].verdict, "revise", "a score of 9 does not approve a design with a critical finding");
  assert.equal(state.design.rounds[0].critical, 1);
  const told = events.find((event) => event.type === "insight" && event.code === "designCoherence");
  assert.equal(told.title, "Coherence analysis: 3 problems, 1 critical");
  assert.deepEqual(told.figures, { findings: 3, critical: 1 });
  assert.equal(told.tone, "warning");
  assert.match(told.detail, /^A sound structure with one hole\.\n- critical \(chapters 2, 3\): Nobody explains/);
  assert.ok(state.design.review.maxRounds === 2);
});

test("a critical finding blocks the approval until it is fixed: the chapters it revises are designed again, the design is analysed again, and the finding is fixed", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    coherence: (call) => (call === 1 ? { findings: [CRITICAL], summary: "One hole." } : { findings: [], summary: "Sound." }),
  });
  const { state } = await run(store, ai, START(6, { review: { maxRounds: 3 } }));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.deepEqual(names(ai), ["design_concept", "chapter_design", "design_coherence", "design_review", "chapter_design", "design_coherence", "design_review"]);
  const redesign = ai.calls[4];
  assert.match(redesign.user, /Revise the design of chapters 1-6 applying the director's changes:\n- Critical — Chapter 3: Nobody explains how the ledger left the vault\. → Show the keeper taking it in chapter 3\./);
  assert.deepEqual(state.design.rounds.map((round) => [round.verdict, round.critical]), [["revise", 1], ["approve", 0]]);
  const [fixed] = state.design.coherence.findings;
  assert.equal(fixed.status, "fixed");
  assert.equal(fixed.round, 1);
  assert.equal(fixed.seen, 1);
  assert.equal(state.design.coherence.round, 2);
  assert.equal(state.design.coherence.findings.length, 1);
});

test("a finding the director dismisses with a reason is no longer blocking, and the dismissal holds when the analysis is made again", async () => {
  const store = await describedBook();
  const decisions = [];
  const ai = createFakeAutopilotAi({
    coherence: () => ({ findings: [CRITICAL, MAJOR], summary: "Two things." }),
    designReview: (round, user) => {
      const id = /\[(a-[0-9a-f]{8})\] critical/.exec(user)?.[1];
      decisions.push(id);
      return { verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: id ? [{ id, decision: "dismiss", reason: "The design answers it in chapter 4." }] : [] };
    },
  });
  const { state } = await run(store, ai, START(6));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(state.design.rounds.length, 1);
  const dismissed = state.design.coherence.findings.find((entry) => entry.status === "dismissed");
  assert.equal(dismissed.id, decisions[0]);
  assert.deepEqual(dismissed.decision, { by: "director", reason: "The design answers it in chapter 4.", at: "2026-11-28T09:00:00.000Z" });
  assert.equal(state.design.coherence.findings.find((entry) => entry.severity === "major").status, "open", "what was not decided stays open");
  // The design runs again: the finding is found again, told in other words, and stays dismissed.
  const again = createFakeAutopilotAi({ coherence: () => ({ findings: [{ ...CRITICAL, text: "Nobody explains how the ledger left the vault, and when." }, MAJOR], summary: "Still." }) });
  const second = await run(store, again, { design: { chapters: 6 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(second.state.design.outcome, "target", second.state.lastError?.message);
  assert.equal(second.state.design.coherence.findings.find((entry) => entry.id === dismissed.id).status, "dismissed");
  assert.match(again.calls.find((call) => call.json?.name === "design_review").user, /COHERENCE FINDINGS[^\n]*\n- \[a-[0-9a-f]{8}\] major character/, "a dismissed finding is not told again");
});

test("a dismissal without a reason, or of a finding there is not, is asked again; the director does not decide about what the author took", async () => {
  const store = await describedBook();
  let asked = 0;
  const ai = createFakeAutopilotAi({
    coherence: () => ({ findings: [CRITICAL], summary: "x" }),
    designReview: (round, user) => {
      asked += 1;
      const id = /\[(a-[0-9a-f]{8})\] critical/.exec(user)[1];
      return { verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: [{ id, decision: "dismiss", reason: asked === 1 ? "" : "It is answered by chapter 4." }] };
    },
  });
  const { state } = await run(store, ai, START(6));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(asked, 2);
  const retry = ai.calls.filter((call) => call.json?.name === "design_review")[1];
  assert.match(retry.user, /The previous reply to this request was rejected because: The director's review of the design was rejected: [^ ]+ is dismissed without a reason/);
  const unknown = await run(await describedBook(), createFakeAutopilotAi({
    coherence: () => ({ findings: [CRITICAL], summary: "x" }),
    designReview: () => ({ verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: [{ id: "a-99999999", decision: "dismiss", reason: "No such finding exists." }] }),
  }), START(6));
  assert.equal(unknown.state.status, "error");
  assert.match(unknown.state.lastError.message, /«a-99999999» is not a finding\. Use the ids of the COHERENCE FINDINGS\./);
});

test("the findings of the checks are merged with the analysis's, and an entry of the author's is told as hers and is never rewritten", async () => {
  const store = await describedBook();
  const author = serializeOutlineChapter({ number: 2, title: "The Bell", body: "Mira rings the bell and nobody comes.", origin: "author" });
  await store.commit([{ path: "outline/chapters/002.md", content: author, expectedHash: null }], "author entry");
  const ai = createFakeAutopilotAi({
    coherence: () => ({ findings: [{ severity: "critical", kind: "contradiction", chapters: [2, 3], requires: [2], text: "The bell cannot ring in a harbor with no bell.", proposal: "Give the harbor a bell." }], summary: "x" }),
  });
  const { state } = await run(store, ai, START(4, { review: { maxRounds: 2 } }));
  const found = state.design.coherence.findings.find((entry) => entry.source === "ai");
  assert.equal(found.owner, "author");
  assert.equal(store.files.get("outline/chapters/002.md"), author, "the entry is as the author wrote it");
  assert.match(ai.calls.find((call) => call.json?.name === "design_review").user, /\(revise: 2; the author's entries: propose, never rewrite\)/);
});

test("a thread of the Bible that is set up and never paid off is a finding of the analysis, from the checks of the book and not from the model", async () => {
  const store = await describedBook();
  await store.commit([{ path: "bible/threads.md", content: "---\ntype: bible\nid: bible:threads\nthreads:\n  - id: t-001\n    title: The lamp\n    setup: { chapter: 1 }\n---\n", expectedHash: null }], "threads");
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, START(4));
  const found = state.design.coherence.findings.filter((entry) => entry.source === "check" && entry.kind === "subplot");
  assert.equal(found.length, 1, JSON.stringify(state.design.coherence.findings));
  assert.match(found[0].text, /The thread «The lamp» is set up in chapter 1 and has no payoff/);
  assert.deepEqual(found[0].chapters, [1]);
  assert.match(ai.calls.find((call) => call.json?.name === "design_coherence").user, /DESIGN CHECKS \(already found without a model; do not repeat them\):\n- The thread «The lamp» is set up in chapter 1/);
});

test("a design with chapters too many for one call is analysed in windows that overlap, and the same trouble seen twice is one finding", async () => {
  const store = await describedBook();
  const chapters = COHERENCE_WINDOW + 5;
  const ai = createFakeAutopilotAi({
    coherence: (call, user) => ({
      findings: [{ severity: "major", kind: "timeline", chapters: [COHERENCE_WINDOW - 2, COHERENCE_WINDOW - 1], requires: [COHERENCE_WINDOW - 1], text: "The same Tuesday comes twice in a row.", proposal: "Move one." }].filter(() => /part \d of 2/.test(user)),
      summary: `Part ${call}.`,
    }),
    designReview: () => ({ verdict: "approve", score: 9, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", findingDecisions: [] }),
  });
  const { state } = await run(store, ai, START(chapters));
  assert.equal(state.status, "paused", state.lastError?.message);
  const calls = ai.calls.filter((call) => call.json?.name === "design_coherence");
  assert.equal(calls.length, 2);
  assert.match(calls[0].user, new RegExp(`Analyse chapters 1 to ${COHERENCE_WINDOW} of the design \\(part 1 of 2; the parts overlap by a few chapters\\)\\.`));
  assert.match(calls[1].user, new RegExp(`Analyse chapters ${COHERENCE_WINDOW - COHERENCE_OVERLAP + 1} to ${chapters} of the design \\(part 2 of 2`));
  assert.doesNotMatch(calls[0].user, new RegExp(`Chapter ${COHERENCE_WINDOW + 1} «`), "a window reads its own chapters");
  assert.match(calls[1].user, new RegExp(`Chapter ${COHERENCE_WINDOW + 5} «`));
  assert.equal(state.design.coherence.findings.filter((entry) => entry.source === "ai").length, 1, "seen in the overlap of both windows: one finding");
  assert.equal(state.design.coherence.summary, "Part 1. Part 2.");
});

test("a reply that names a chapter that was not read is asked again with the reason, and a second one stops the step", async () => {
  const store = await describedBook();
  let calls = 0;
  const ai = createFakeAutopilotAi({
    coherence: () => {
      calls += 1;
      return { findings: [{ ...MAJOR, chapters: calls === 1 ? [4, 40] : [4] }], summary: "x" };
    },
  });
  const { state } = await run(store, ai, START(6));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(calls, 2);
  assert.match(ai.calls.filter((call) => call.json?.name === "design_coherence")[1].user, /The previous reply to this request was rejected because: The analysis of the structure was rejected: finding 1 names chapter 40, which was not read/);
  const failing = await run(await describedBook(), createFakeAutopilotAi({ coherence: () => ({ findings: [{ ...MAJOR, severity: "grave" }], summary: "x" }) }), START(6));
  assert.equal(failing.state.status, "error");
  assert.match(failing.state.lastError.message, /finding 1 has no severity/);
  assert.equal(failing.state.design.coherence, undefined, "an analysis that was not whole is not kept");
});

test("without the analysis nothing of it is asked, told or kept, and the director's schema has no decisions: the design run of an engine before", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { design: { chapters: 6 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.deepEqual(names(ai), ["design_concept", "chapter_design", "design_review"]);
  assert.equal(state.design.coherence, undefined);
  const review = ai.calls.at(-1);
  assert.equal(review.json.parameters.properties.findingDecisions, undefined);
  assert.doesNotMatch(review.user, /COHERENCE FINDINGS/);
});

test("the analysis is kept when the state is saved and read again", async () => {
  const store = await describedBook();
  const { state } = await run(store, createFakeAutopilotAi({ coherence: () => ({ findings: [MAJOR], summary: "One thing." }) }), START(6));
  const again = normalizeAutopilotState(JSON.parse(serializeAutopilotState(state)));
  assert.deepEqual(again.design.coherence, state.design.coherence);
  assert.deepEqual(again.design.workflow, { coherence: true });
});
