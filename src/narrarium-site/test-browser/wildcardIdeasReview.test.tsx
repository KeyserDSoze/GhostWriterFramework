import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinWildcards, readWildcardReply, type WildcardVoiceResult } from "narrarium-engine";
import i18n from "@/i18n";
import "@/i18n/wildcards";
import { WildcardIdeasReview, type WildcardReviewResult } from "@/components/wildcards/WildcardIdeasReview";

// The table of the ideas of the room: every idea with who gave it, why, what it changes and its risk; accept or skip each; one button applies; nothing before.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const target = { kind: "chapter" as const, label: "Chapter 3: The harbour", chapter: 3 };
const voice = (slug: string, count: number, status: WildcardVoiceResult["status"] = "ok"): WildcardVoiceResult => {
  const persona = builtinWildcards("en").find((profile) => profile.slug === slug)!;
  const ideas = readWildcardReply({ items: Array.from({ length: count }, (_, index) => ({ title: `${persona.name} ${index + 1}`, idea: `Idea ${index + 1} of ${persona.name}.`, why: "Because.", changes: "One scene.", chapters: [3], risk: "Some.", audacity: 7, ...(persona.group === "sentinel" ? { evidence: "the key", severity: "major" } : {}) })) }, persona, { target, consultation: `room-${slug}` }).ideas;
  return { persona: { id: persona.id, slug, name: persona.name, group: persona.group }, status, ideas, invalid: 0, omitted: status === "ok" && count > 1 ? 2 : 0, truncated: false, repaired: false, ...(status === "failed" ? { reason: "The provider is down." } : {}) };
};
const result = (): WildcardReviewResult => {
  const voices = [voice("subversive", 2), voice("ledger-keeper", 1), voice("naive", 0, "failed")];
  return { target, voices, ideas: voices.flatMap((entry) => entry.ideas), clipped: { from: 90_000, to: 60_000 } };
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the table of the ideas of the room", () => {
  it("shows every idea with its voice, why, what it changes and its risk, the voices that did not answer, and that it is advisory", () => {
    render(<WildcardIdeasReview result={result()} applyLabel="Apply to the Synopsis entry" onApply={vi.fn()} />);
    const table = screen.getByRole("table", { name: /Ideas of the room — Chapter 3: The harbour/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent("The Subversive");
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent("Idea 1 of The Subversive.");
    expect(rows[0]).toHaveTextContent("Because.");
    expect(rows[0]).toHaveTextContent("One scene.");
    expect(rows[0]).toHaveTextContent("chapters 3");
    expect(rows[2]).toHaveTextContent("major");
    expect(rows[2]).toHaveTextContent("Where: the key");
    expect(screen.getByText(t("wildcards.review.advisory"))).toBeInTheDocument();
    expect(screen.getByText(/did not answer: The provider is down\./)).toBeInTheDocument();
    expect(screen.getByText(t("wildcards.review.clipped", { to: 60_000, from: 90_000 }))).toBeInTheDocument();
    // No column is a score: the room advises.
    expect(within(table).queryByRole("columnheader", { name: /score|vote|voto/i })).not.toBeInTheDocument();
  });

  it("applies nothing before a decision; each idea is accepted or skipped by name; the one button applies the decisions and says what it did", async () => {
    const onApply = vi.fn().mockResolvedValue("Decisions recorded: 1 accepted, 2 skipped.");
    render(<WildcardIdeasReview result={result()} applyLabel="Apply to the Synopsis entry" onApply={onApply} />);
    const apply = screen.getByRole("button", { name: "Apply to the Synopsis entry" });
    expect(apply).toBeDisabled();
    expect(screen.getByText("0 accepted · 0 skipped · 3 not decided")).toBeInTheDocument();
    const first = screen.getByRole("group", { name: "Decision on «The Subversive 1»" });
    fireEvent.click(within(first).getByRole("radio", { name: t("wildcards.review.accept") }));
    expect(screen.getByText("1 accepted · 0 skipped · 2 not decided")).toBeInTheDocument();
    expect(apply).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: t("wildcards.review.skipAll") }));
    expect(within(first).getByRole("radio", { name: t("wildcards.review.skip") })).toBeChecked();
    fireEvent.click(within(first).getByRole("radio", { name: t("wildcards.review.accept") }));
    fireEvent.click(apply);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const choices = onApply.mock.calls[0][0] as Record<string, string>;
    expect(Object.values(choices).sort()).toEqual(["accept", "skip", "skip"]);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Decisions recorded: 1 accepted, 2 skipped.");
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Apply to the Synopsis entry" })).not.toBeInTheDocument();
    expect(within(first).getByRole("radio", { name: t("wildcards.review.accept") })).toBeDisabled();
  });

  it("says what went wrong when applying fails, and lets the author try again", async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error("Save or discard your changes to the scene first.")).mockResolvedValueOnce("Done.");
    render(<WildcardIdeasReview result={result()} applyLabel="Apply to the scene" onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: t("wildcards.review.acceptAll") }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to the scene" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save or discard your changes to the scene first.");
    fireEvent.click(screen.getByRole("button", { name: "Apply to the scene" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Done.");
  });
});
