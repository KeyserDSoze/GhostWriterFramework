import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/readerAccess.en";
import it_ from "@/i18n/locales/readerAccess.it";
import { describeDoneSteps, describePublishedEffect, describeReaderFailure, describeReaderResult, type ReaderText } from "@/readerAccess/messages";
import type { ReaderFailure } from "@/readerAccess/errors";
import type { ReaderOperationResult, ReaderOperationStep } from "@/readerAccess/operations";

type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = ""): Record<string, string> => Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => typeof value === "string" ? [[`${prefix}${key}`, value]] : Object.entries(flatten(value, `${prefix}${key}.`))));
const english = flatten(en as unknown as Tree);
const italian = flatten(it_ as unknown as Tree);
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();

const FAILURES: ReaderFailure[] = [
  { kind: "permission", status: 403, permissions: ["secrets"], fromHeader: true },
  { kind: "permission", status: 403, permissions: ["actions", "contents"], fromHeader: false },
  { kind: "not-found", status: 404, permissions: ["actions_variables"] },
  { kind: "rate-limit", status: 429 },
  { kind: "rate-limit", status: 403, resetAt: "2026-11-25T10:00:00.000Z" },
  { kind: "no-dispatch", status: 422 }, { kind: "plan", status: 422 }, { kind: "sso", status: 403 }, { kind: "credential", status: 401 },
  { kind: "conflict", status: 409 }, { kind: "network" }, { kind: "other", status: 500 }, { kind: "other" },
];
const KINDS = ["classic", "fine-grained", "app", "unknown"] as const;
const STEPS: ReaderOperationStep[] = ["check", "save", "secret", "variable", "secret-delete", "forget", "dispatch", "pages", "cleanup"];
const OPERATIONS = ["add", "remove", "resume", "republish", "enable-pages", "disable-pages", "refresh"] as const;

function keysOf(text: ReaderText | undefined): string[] { return text ? [text.key] : []; }

describe("the texts of Reader access", () => {
  it("exist in English and in Italian under the same keys and with the same placeholders", () => {
    expect(Object.keys(italian).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
      expect(value.trim(), key).not.toBe("");
      expect(placeholders(italian[key]), key).toEqual(placeholders(value));
    }
  });

  it("are written in Italian where they are sentences (not the English copied)", () => {
    const same = Object.keys(english).filter((key) => english[key] === italian[key]);
    // Only names that are the same word in both languages (GitHub's own terms, «Password»).
    expect(same.sort()).toEqual(["readerAccess.pages.title", "readerAccess.part.pages", "readerAccess.part.repository", "readerAccess.part.secrets", "readerAccess.part.workflow", "readerAccess.passwordField", "readerAccess.passwordValueFor", "readerAccess.secretName"]);
  });

  it("have a text for every message the code can produce", () => {
    const wanted = new Set<string>();
    for (const failure of FAILURES) for (const kind of KINDS) keysOf(describeReaderFailure(failure, kind)).forEach((key) => wanted.add(key));
    for (const operation of OPERATIONS) {
      for (const step of STEPS) {
        const result: ReaderOperationResult = { ok: false, done: STEPS.slice(0, STEPS.indexOf(step)), failed: { step, failure: FAILURES[0] }, dispatched: false };
        const text = describeReaderResult(operation, result);
        [text.headline, text.reason, text.effect, ...text.done].forEach((line) => keysOf(line).forEach((key) => wanted.add(key)));
        keysOf(describePublishedEffect(operation, result)).forEach((key) => wanted.add(key));
      }
      for (const dispatched of [true, false]) describeReaderResult(operation, { ok: true, done: [], dispatched }).headline && wanted.add(describeReaderResult(operation, { ok: true, done: [], dispatched }).headline.key);
    }
    describeDoneSteps(STEPS, "remove").concat(describeDoneSteps(STEPS, "add")).forEach((line) => wanted.add(line.key));
    expect(wanted.size).toBeGreaterThan(20);
    for (const key of wanted) {
      expect(english[key], `en ${key}`).toBeTruthy();
      expect(italian[key], `it ${key}`).toBeTruthy();
    }
  });
});

describe("what a failure says", () => {
  it("names the missing permission, in the words of where it is given for the kind of token", () => {
    const failure: ReaderFailure = { kind: "permission", status: 403, permissions: ["secrets", "actions_variables"], fromHeader: true };
    expect(describeReaderFailure(failure, "app")).toEqual({ key: "readerAccess.failure.permission.app", params: { permission: "Secrets, Variables", count: 2 } });
    expect(describeReaderFailure(failure, "fine-grained").key).toBe("readerAccess.failure.permission.fine-grained");
    expect(describeReaderFailure(failure, "classic").key).toBe("readerAccess.failure.permission.classic");
    expect(describeReaderFailure(failure).key).toBe("readerAccess.failure.permission.unknown");
    expect(english["readerAccess.failure.permission.app"]).toContain("{{permission}}");
  });

  it("offers a retry for anything that can pass, and not for a plan without Pages or a workflow that has to be updated", () => {
    const retry = (failure: ReaderFailure) => describeReaderResult("add", { ok: false, done: [], failed: { step: "secret", failure }, dispatched: false }).retry;
    expect(retry({ kind: "network" })).toBe(true);
    expect(retry({ kind: "permission", status: 403, permissions: ["secrets"], fromHeader: false })).toBe(true);
    expect(retry({ kind: "plan", status: 422 })).toBe(false);
    expect(retry({ kind: "no-dispatch", status: 422 })).toBe(false);
  });
});

describe("what the published reader is doing when an operation stops", () => {
  const stopped = (step: ReaderOperationStep, done: ReaderOperationStep[]): ReaderOperationResult => ({ ok: false, done, failed: { step, failure: { kind: "network" } }, dispatched: false });

  it("an add that stops before the variable lists the secret has changed nothing that is published", () => {
    expect(describePublishedEffect("add", stopped("secret", ["check", "save"])).key).toBe("readerAccess.effect.addUnchanged");
    expect(describePublishedEffect("add", stopped("variable", ["check", "save", "secret"])).key).toBe("readerAccess.effect.addUnchanged");
    expect(describePublishedEffect("resume", stopped("secret", [])).key).toBe("readerAccess.effect.addUnchanged");
  });

  it("an add whose workflow did not start says that the password is not accepted yet, and one whose record failed says it will be", () => {
    expect(describePublishedEffect("add", stopped("dispatch", ["check", "save", "secret", "variable", "save"])).key).toBe("readerAccess.effect.addNotPublished");
    expect(describePublishedEffect("add", stopped("save", ["check", "save", "secret", "variable"])).key).toBe("readerAccess.effect.addRecord");
  });

  it("a removal says what is left: the secret still on GitHub, the copy here, or the publication that did not start", () => {
    expect(describePublishedEffect("remove", stopped("variable", ["save"])).key).toBe("readerAccess.effect.unchanged");
    expect(describePublishedEffect("remove", stopped("secret-delete", ["save", "variable"])).key).toBe("readerAccess.effect.removeSecretLeft");
    expect(describePublishedEffect("remove", stopped("forget", ["save", "variable", "secret-delete"])).key).toBe("readerAccess.effect.removeRecordLeft");
    expect(describePublishedEffect("remove", stopped("dispatch", ["save", "variable", "secret-delete", "forget"])).key).toBe("readerAccess.effect.removeNotPublished");
  });

  it("a cleanup after Pages was turned off says Pages is off and what is left", () => {
    expect(describePublishedEffect("disable-pages", stopped("secret-delete", ["pages", "variable"])).key).toBe("readerAccess.effect.pagesOffCleanup");
    expect(describePublishedEffect("disable-pages", stopped("pages", [])).key).toBe("readerAccess.effect.unchanged");
  });

  it("lists what is already done once each, in order", () => {
    expect(describeDoneSteps(["check", "save", "secret", "variable", "save", "dispatch"], "add").map((line) => line.key)).toEqual(["readerAccess.done.save", "readerAccess.done.secret", "readerAccess.done.variable", "readerAccess.done.dispatch"]);
    expect(describeDoneSteps(["save", "variable"], "remove").map((line) => line.key)).toEqual(["readerAccess.done.markRemoving", "readerAccess.done.variable"]);
  });

  it("a success says it is publishing only when the workflow was started", () => {
    expect(describeReaderResult("add", { ok: true, done: [], dispatched: true }).headline.key).toBe("readerAccess.result.publishing");
    expect(describeReaderResult("add", { ok: true, done: [], dispatched: false }).headline.key).toBe("readerAccess.result.done");
    expect(describeReaderResult("enable-pages", { ok: true, done: [], dispatched: false }).headline.key).toBe("readerAccess.result.pagesOn");
    expect(describeReaderResult("disable-pages", { ok: true, done: [], dispatched: false }).headline.key).toBe("readerAccess.result.pagesOff");
  });
});
