import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskDirectorResult, DirectorOpinion } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AskDirectorDialog } from "@/components/director/AskDirectorDialog";
import { openAskDirector, useAskDirectorStore } from "@/store/askDirectorStore";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const OPINION: DirectorOpinion = {
  target: { kind: "book" },
  targetTitle: "The Glass Harbor",
  verdict: "revise",
  score: 6,
  summary: "The middle sags, the ending is strong.",
  strengths: ["A clear voice"],
  concerns: [],
  decisions: [],
  nextSteps: [],
  questionsForAuthor: [],
  createdAt: "2026-11-21T10:00:00.000Z",
  source: "on-demand",
  directorName: "The Director",
} as DirectorOpinion;

const WARNING = "director.md: autonomy «sometimes» is not one of full, ask-on-critical, ask-always: ask-on-critical is used";

function answer(warnings?: string[]): AskDirectorResult {
  return { opinion: OPINION, path: "evaluations/director/book.md", saved: true, ...(warnings === undefined ? {} : { warnings }) };
}

async function ask(result: AskDirectorResult) {
  mocks.runtime.askDirector.mockResolvedValue(result);
  render(<MemoryRouter><AskDirectorDialog /></MemoryRouter>);
  act(() => openAskDirector({ bookId: "book-1", target: { kind: "book" } }));
  fireEvent.click(await screen.findByRole("button", { name: t("director.ask.run") }));
  await screen.findByText(OPINION.summary);
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.runtime = { askDirector: vi.fn(), describeError: vi.fn((error: unknown) => String(error)) };
});

afterEach(async () => {
  cleanup();
  useAskDirectorStore.setState({ request: null });
  await i18n.changeLanguage("en");
});

describe("asking the director when director.md has problems", () => {
  it("shows the problems above the opinion, in a status that does not interrupt", async () => {
    await ask(answer([WARNING]));
    const warnings = screen.getByRole("status", { name: t("profileFile.warningsTitle", { count: 1 }) });
    expect(warnings).toHaveTextContent(WARNING);
    expect(warnings).toHaveTextContent(t("profileFile.directorOpinionNote"));
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(warnings.compareDocumentPosition(screen.getByText(OPINION.summary)) & Node.DOCUMENT_POSITION_FOLLOWING, "above the text of the opinion").toBeTruthy();
    expect(screen.getByText(/A clear voice/)).toBeInTheDocument();
  });

  it("says each problem on its own line", async () => {
    await ask(answer([WARNING, "director.md: strictness «very» is not a number from 1 to 10: 7 is used"]));
    const warnings = screen.getByRole("status", { name: t("profileFile.warningsTitle", { count: 2 }) });
    expect(within(warnings).getAllByRole("listitem").map((item) => item.textContent)).toEqual([WARNING, "director.md: strictness «very» is not a number from 1 to 10: 7 is used"]);
  });

  it("is in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    await ask(answer([WARNING]));
    const warnings = screen.getByRole("status", { name: "Questo file ha un problema" });
    expect(warnings).toHaveTextContent(WARNING);
  });

  it("shows nothing when the file is fine, or when the answer comes from a server that does not report problems", async () => {
    await ask(answer([]));
    expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument();
    cleanup();
    useAskDirectorStore.setState({ request: null });
    await ask(answer());
    expect(screen.queryByRole("status", { name: /problem/i })).not.toBeInTheDocument();
    expect(screen.getByText(OPINION.summary)).toBeInTheDocument();
  });
});
