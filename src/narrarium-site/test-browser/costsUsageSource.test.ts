import { describe, expect, it } from "vitest";
import { USAGE_SOURCES, decodeKey, encodeKey } from "@/costs/ledger";
import { recordUsage } from "@/costs/recordUsage";
import { resetCosts } from "./helpers/costs";
import { usageSource } from "@/costs/usageSource";
import { BRAINSTORMING_CAPABILITY, CHAT_CAPABILITIES, ROUTING_TASKS } from "@/types/settings";
import { AUTOPILOT_TASKS } from "@/router/autopilotTasks";

describe("where a call came from: one rule", () => {
  it("gives every call of an autopilot run to the autopilot, whatever it asks", () => {
    for (const capability of [...AUTOPILOT_TASKS, ...CHAT_CAPABILITIES]) expect(usageSource({ origin: "autopilot", capability, label: "copilot:review" }), capability).toBe("autopilot");
  });

  it("gives every call of a turn of the Copilot to the Copilot, the tools it runs included", () => {
    for (const [capability, label] of [["copilot", "copilot"], ["default", "pipeline:refine-prose"], ["deep-research", "deep-research"], ["image", "image"], ["review", "audit:chapter"]] as const) {
      expect(usageSource({ origin: "copilot", capability, label }), `${capability} ${label}`).toBe("copilot");
    }
  });

  it("knows the feature of a capability that only one feature uses", () => {
    expect(usageSource({ capability: "autopilot" })).toBe("autopilot");
    expect(usageSource({ capability: "director" })).toBe("autopilot");
    expect(usageSource({ capability: "copilot" })).toBe("copilot");
    expect(usageSource({ capability: "chat-resume" })).toBe("copilot");
    expect(usageSource({ capability: "editor-actions", label: "custom-action:Tighten" })).toBe("editor-actions");
    expect(usageSource({ capability: "audit", label: "audit:chapter:x" })).toBe("audit");
    expect(usageSource({ capability: "reader-evaluation", label: "reader-evaluation:anna" })).toBe("reader-evaluation");
    expect(usageSource({ capability: "reader-evaluation-summary" })).toBe("reader-evaluation");
    expect(usageSource({ capability: "rewrite-from-reader-feedback" })).toBe("reader-evaluation");
    expect(usageSource({ capability: "deep-research" })).toBe("research");
    expect(usageSource({ capability: "create-from-research" })).toBe("research");
    expect(usageSource({ capability: "image" })).toBe("media");
    expect(usageSource({ capability: "tts", label: "tts (nova)" })).toBe("media");
    expect(usageSource({ capability: "stt" })).toBe("media");
  });

  it("tells apart by the label the features that share a general capability", () => {
    const cases: Array<[string, string, string]> = [
      ["default", "copilot:create-chapter", "copilot"],
      ["simple-tasks", "copilot", "copilot"],
      ["simple-tasks", "confirm", "copilot"],
      ["default", "assistant:reply-summary", "copilot"],
      ["default", "pipeline:script-to-prose", "editor-actions"],
      ["simple-tasks", "pipeline:synonyms", "editor-actions"],
      ["review", "evaluation:chapter", "editor-actions"],
      ["default", "resume:chapter", "editor-actions"],
      ["default", "editor:summarize", "editor-actions"],
      ["default", "live-voice:rewrite", "editor-actions"],
      ["review", "copilot:review", "copilot"],
      ["default", "image:prompt", "media"],
      ["default", "regenerate-entity:character", "research"],
      ["default", "deep-research:synthesize", "research"],
      ["default", "evaluation-style:improve", "other"],
      ["default", "", "other"],
      ["review", "something:new", "other"],
    ];
    for (const [capability, label, source] of cases) expect(usageSource({ capability, label }), `${capability} · ${label}`).toBe(source);
  });

  it("gives the wildcards' room a line of its own wherever the author asks it, and leaves the autopilot's consultations to the autopilot", () => {
    expect(usageSource({ capability: "wildcards", label: "wildcards:poet" })).toBe("ideas");
    expect(usageSource({ origin: "copilot", capability: "wildcards", label: "wildcards:subversive" })).toBe("ideas");
    // The Director's triage and the rewrite with the accepted ideas, asked by the author: their labels say the room.
    expect(usageSource({ capability: "director", label: "wildcards:triage" })).toBe("ideas");
    expect(usageSource({ origin: "copilot", capability: "editor-actions", label: "wildcards:apply" })).toBe("ideas");
    expect(usageSource({ origin: "autopilot", capability: "wildcards", label: "wildcards:poet" })).toBe("autopilot");
    expect(usageSource({ origin: "copilot", capability: "copilot", label: "copilot:turn" })).toBe("copilot");
    expect(USAGE_SOURCES.indexOf("ideas")).toBe(USAGE_SOURCES.indexOf("reader-evaluation") + 1);
  });

  it("calls a capability nobody knows «other», and always answers one of the sources", () => {
    expect(usageSource({ capability: "a-capability-of-tomorrow" })).toBe("other");
    for (const capability of ROUTING_TASKS) expect(USAGE_SOURCES).toContain(usageSource({ capability }));
  });
});

describe("a capability of the Copilot that a later version adds, and one nobody knows", () => {
  const CALL = { model: "gpt-5", integrationId: "int-1", usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 }, usageKnown: true, cost: 0.001, costKnown: true, priced: true, currency: "EUR" };

  it("gives Brainstorming to the Copilot, and keeps its capability in the key of the ledger as the router names it", () => {
    resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
    expect(BRAINSTORMING_CAPABILITY, "the name the router and the engine give the task").toBe("brainstorming");
    expect(usageSource({ capability: BRAINSTORMING_CAPABILITY })).toBe("copilot");
    expect(usageSource({ capability: BRAINSTORMING_CAPABILITY, label: "pipeline:synopsis" }), "its capability says it, not the label").toBe("copilot");
    const recorded = recordUsage({ ...CALL, capability: BRAINSTORMING_CAPABILITY, label: "brainstorming:synopsis" });
    expect(recorded.source).toBe("copilot");
    expect(recorded.delta.key).toMatchObject({ source: "copilot", capability: "brainstorming" });
    expect(decodeKey(encodeKey(recorded.delta.key)), "the row of the ledger keeps it").toMatchObject({ source: "copilot", capability: "brainstorming" });
    resetCosts();
  });

  it("calls a capability nobody knows «other» whatever its label says, keeps it in the key, and never throws", () => {
    resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
    for (const label of [undefined, "", "copilot:new-thing", "pipeline:refine-prose", "something"]) {
      expect(usageSource({ capability: "a-capability-of-tomorrow", label }), String(label)).toBe("other");
    }
    expect(usageSource({ capability: "a-capability-of-tomorrow", origin: "autopilot" }), "a run's call is the run's").toBe("autopilot");
    expect(usageSource({ capability: "a-capability-of-tomorrow", origin: "copilot" }), "a turn's call is the turn's").toBe("copilot");
    expect(() => usageSource({ capability: "" })).not.toThrow();
    expect(usageSource({ capability: "" })).toBe("other");
    expect(usageSource({ capability: undefined as unknown as string, label: 42 as unknown as string })).toBe("other");
    expect(usageSource({ capability: "default", label: 42 as unknown as string }), "a label that is not text says nothing").toBe("other");
    const recorded = recordUsage({ ...CALL, capability: "a-capability-of-tomorrow", label: "copilot:new-thing" });
    expect(recorded.delta.key).toMatchObject({ source: "other", capability: "a-capability-of-tomorrow" });
    resetCosts();
  });
});
