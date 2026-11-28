import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import "@/i18n/brainstorm";
import { BrainstormCapture } from "@/components/assistant/brainstorm/BrainstormPanelParts";

// «Capture this decision» under a conversation of Brainstorming (Phase 4 of #108): the request that asks Brainstorming to put what the author settled in the log of decisions
// of the book, through its own tool, for the author to confirm.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("«Capture this decision» in Brainstorming", () => {
  it("fills in the request that asks Brainstorming to put what was settled in the log of decisions, in both languages", async () => {
    const onPick = vi.fn();
    render(<BrainstormCapture onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture this decision" }));
    expect(onPick).toHaveBeenCalledWith(t("brainstorm.capture.prompt"));
    expect(onPick.mock.calls[0][0]).toContain("decisions of the book");
    cleanup();
    await i18n.changeLanguage("it");
    render(<BrainstormCapture onPick={onPick} />);
    expect(screen.getByRole("button", { name: "Registra questa decisione" })).toBeInTheDocument();
  });
});
