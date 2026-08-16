import { describe, expect, it } from "vitest";
import { budgetLlmMessages, estimateMessageTokens, resolveModelTokenBudgets } from "@/assistant/promptBudget";

describe("model input budgets", () => {
  it("visibly truncates oversized context and long chapter text while retaining both ends", () => {
    const messages = [
      { role: "system" as const, content: `instructions:${"c".repeat(2_000)}` },
      { role: "user" as const, content: `ATTACHMENT: notes.txt\n${"a".repeat(4_000)}\nCHAPTER START\n${"b".repeat(8_000)}\nCHAPTER END\nRequest: review the ending` },
    ];
    const result = budgetLlmMessages(messages, 600);
    const flattened = result.map((message) => message.content).join("\n");

    const budget = resolveModelTokenBudgets(600);
    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(budget.inputTokens);
    expect(estimateMessageTokens(result) + budget.outputTokens + budget.safetyTokens).toBeLessThanOrEqual(600);
    expect(flattened).toContain("Context truncated");
    expect(flattened).toContain("instructions:");
    expect(flattened).toContain("Request: review the ending");
    expect(messages[1].content.length).toBeGreaterThan((result[1].content as string).length);
  });

  it("omits unaffordable image attachments with a visible notice", () => {
    const result = budgetLlmMessages([{ role: "user", content: [
      { type: "text", text: "Describe these attachments" },
      { type: "image", dataUrl: "data:image/png;base64,one" },
      { type: "image", dataUrl: "data:image/png;base64,two" },
    ] }], 300);
    const parts = result[0].content;

    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Array<{ type: string }>).some((part) => part.type === "image")).toBe(false);
    expect(JSON.stringify(parts)).toContain("image attachments were omitted");
    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(resolveModelTokenBudgets(300).inputTokens);
  });

  it("uses a finite fallback for models without declared limits", () => {
    const result = budgetLlmMessages([{ role: "user", content: "x".repeat(200_000) }]);
    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(resolveModelTokenBudgets().inputTokens);
    expect(result[0].content).toContain("Context truncated");
  });

  it("uses a UTF-8 byte upper bound and reserves configured output plus safety", () => {
    const context = 1_000;
    const output = 300;
    const result = budgetLlmMessages([{ role: "user", content: "😀界".repeat(1_000) }], context, output);
    const budget = resolveModelTokenBudgets(context, output);

    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(budget.inputTokens);
    expect(estimateMessageTokens(result) + budget.outputTokens + budget.safetyTokens).toBeLessThanOrEqual(context);
    expect(result[0].content).toContain("Context truncated to reserve");
  });

  it("clamps impossible output limits so the complete request fits the context window", () => {
    const budget = resolveModelTokenBudgets(100, 1_000);
    expect(budget.inputTokens).toBeGreaterThan(0);
    expect(budget.inputTokens + budget.outputTokens + budget.safetyTokens).toBe(100);
  });

  it("reserves mandatory tool-schema input before budgeting messages", () => {
    const result = budgetLlmMessages([{ role: "user", content: "x".repeat(2_000) }], 1_000, 200, 300);
    const budget = resolveModelTokenBudgets(1_000, 200);
    expect(estimateMessageTokens(result) + 300).toBeLessThanOrEqual(budget.inputTokens);
  });

  it("drops oldest messages when overhead alone exceeds a tiny context budget", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      ...Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `message-${index}` })),
    ];
    const result = budgetLlmMessages(messages, 50, 1);
    const budget = resolveModelTokenBudgets(50, 1);

    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(budget.inputTokens);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("s");
    expect(result[result.length - 1].content).toContain("me");
    expect(result.length).toBeLessThan(messages.length);
  });

  it("returns no messages when even one message envelope cannot fit", () => {
    const result = budgetLlmMessages([{ role: "user", content: "latest" }], 10, 1);
    expect(result).toEqual([]);
    expect(estimateMessageTokens(result)).toBeLessThanOrEqual(resolveModelTokenBudgets(10, 1).inputTokens);
  });
});
