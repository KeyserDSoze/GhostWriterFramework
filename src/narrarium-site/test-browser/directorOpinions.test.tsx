import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorOpinion } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  load: vi.fn(),
  toast: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: BOOK_ENTRY, structure: STRUCTURE, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/narrarium/director", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/narrarium/director")>()), loadDirectorProfile: mocks.load }));
vi.mock("@/narrarium/readerPanel", () => ({ loadReaderPersonas: async () => [] }));
vi.mock("@/autopilot/browserStore", () => ({ createBrowserBookStore: () => mocks.store }));
vi.mock("@/store/askDirectorStore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/store/askDirectorStore")>()), openAskDirector: mocks.ask }));

import { defaultDirector, renderDirectorOpinion } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { DirectorPage } from "@/pages/DirectorPage";
import { DirectorOpinionView } from "@/components/director/DirectorOpinionView";
import { formatCost, formatCount, formatDateTime } from "@/autopilot/format";
import { useSaveStore } from "@/store/saveStore";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK_ENTRY = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
// One object, as the app's store gives it: a new structure at every render would read the book again at every render.
const STRUCTURE = { title: "The Glass Harbor", language: "en", chapters: [], readerPersonas: [], loadedBranch: "main" };
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

const OPINION: DirectorOpinion = {
  target: { kind: "chapter", chapter: "003-the-key" },
  targetTitle: "3. The key",
  verdict: "revise",
  score: 6.5,
  summary: "The scene at the pier works; the middle drags.",
  strengths: ["The pier is concrete and sensory"],
  concerns: [{ severity: "major", issue: "The middle drags", evidence: "She waited.", suggestion: "Cut the second walk." }],
  decisions: ["Keep the ending as it is"],
  nextSteps: ["Tighten scene 2"],
  questionsForAuthor: [],
  createdAt: "2026-11-21T10:00:00.000Z",
  source: "on-demand",
  directorName: "Ada",
  model: "gpt-test",
  usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 },
  cost: 0.0123,
  currency: "EUR",
};

function opinionFile(patch: Partial<DirectorOpinion>) {
  const opinion = { ...OPINION, ...patch };
  const target = opinion.target;
  const path = target.kind === "book" ? "evaluations/director/book.md" : target.kind === "chapter" ? `evaluations/director/chapters/${target.chapter}.md` : `evaluations/director/paragraphs/${target.chapter}/${target.paragraph}.md`;
  return [path, renderDirectorOpinion(opinion, "en")] as const;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/director"]}>
      <Routes><Route path="/app/books/:bookId/director" element={<DirectorPage />} /></Routes>
    </MemoryRouter>
  );
}

async function openWith(files: Array<readonly [string, string]>) {
  mocks.store = new MemoryBookStore(Object.fromEntries(files));
  mocks.load.mockResolvedValue({ profile: { ...defaultDirector("en"), name: "Ada", approvalScore: 7 }, exists: true, hash: "h1" });
  render(<Page />);
  await screen.findByDisplayValue("Ada");
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.toast.mockReset();
  mocks.ask.mockReset();
});

afterEach(async () => {
  cleanup();
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each<Language>(["en", "it"])("the director's opinion as a score card (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("puts the score first, large, with its scale, then the strong and the weak points, the decisions and what it cost", () => {
    render(<DirectorOpinionView opinion={OPINION} />);
    const score = screen.getByText(formatCount(6.5));
    expect(score.closest("[data-score-card]")).toHaveTextContent(t("director.card.scale"));
    expect(screen.getByText(t("director.opinion.verdict.revise"))).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: t("director.opinion.strengths") })).getByText("The pier is concrete and sensory")).toBeInTheDocument();
    const weak = screen.getByRole("region", { name: t("director.opinion.concerns") });
    expect(within(weak).getByText("The middle drags")).toBeInTheDocument();
    expect(within(weak).getByText(t("director.opinion.severity.major"))).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: t("director.opinion.decisions") })).getByText("Keep the ending as it is")).toBeInTheDocument();
    expect(screen.getByText(plain([t("director.card.cost", { cost: formatCost(0.0123, "EUR") }), t("director.card.tokens", { tokens: formatCount(1500) }), "gpt-test"].join(" · ")))).toBeInTheDocument();
    expect(t("director.card.scale")).toBe(language === "en" ? "out of 10" : "su 10");
  });
});

describe("an opinion that does not say what it cost", () => {
  it("says nothing of it rather than a cost of zero", () => {
    render(<DirectorOpinionView opinion={{ ...OPINION, cost: undefined, usage: undefined, model: undefined }} />);
    expect(screen.queryByText(new RegExp(t("director.card.costLabel")))).not.toBeInTheDocument();
  });
});

describe.each<Language>(["en", "it"])("the scores of the saved opinions over time (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  const FILES = [
    opinionFile({ target: { kind: "chapter", chapter: "001-the-harbor" }, targetTitle: "1. The harbor", score: 6.5, verdict: "revise", createdAt: "2026-11-18T10:00:00.000Z", source: "autopilot" }),
    opinionFile({ target: { kind: "chapter", chapter: "002-the-flood" }, targetTitle: "2. The flood", score: 8, verdict: "approve", createdAt: "2026-11-19T10:00:00.000Z", source: "autopilot" }),
    opinionFile({ target: { kind: "book" }, targetTitle: "The Glass Harbor", score: 7, verdict: "revise", createdAt: "2026-11-20T10:00:00.000Z" }),
  ];

  it("are a picture by chapter, said in words, with the approval score as a line, and a table with every figure", async () => {
    await openWith(FILES);
    const trend = await screen.findByRole("region", { name: t("director.trend.title") });
    const chart = within(trend).getByRole("img");
    expect(chart).toHaveAccessibleName(t("director.trend.chartChapters", { count: 2, min: formatCount(6.5), max: formatCount(8), threshold: formatCount(7) }));
    const table = within(trend).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => plain(cell.textContent ?? "")));
    expect(rows).toEqual([
      ["1. The harbor", formatDateTime("2026-11-18T10:00:00.000Z"), `${formatCount(6.5)}/10`, t("director.opinion.verdict.revise")],
      ["2. The flood", formatDateTime("2026-11-19T10:00:00.000Z"), `${formatCount(8)}/10`, t("director.opinion.verdict.approve")],
    ].map((row) => row.map(plain)));
  });

  it("can be seen by date too, with the opinions on the whole book", async () => {
    await openWith(FILES);
    const trend = await screen.findByRole("region", { name: t("director.trend.title") });
    fireEvent.click(within(trend).getByRole("radio", { name: t("director.trend.byDate") }));
    expect(within(trend).getByRole("img")).toHaveAccessibleName(t("director.trend.chartDates", { count: 3, min: formatCount(6.5), max: formatCount(8), threshold: formatCount(7) }));
    expect(within(within(trend).getByRole("table")).getAllByRole("row")).toHaveLength(4);
  });

  it("are each a small score card, newest first, that opens on what the director wrote", async () => {
    await openWith(FILES);
    const list = await screen.findByRole("list", { name: t("director.opinions.title") });
    const cards = within(list).getAllByRole("listitem");
    expect(cards.map((item) => item.querySelector("[data-score]")?.textContent)).toEqual([formatCount(7), formatCount(8), formatCount(6.5)]);
    expect(within(cards[0]).getByText(t("director.opinions.source.on-demand"), { exact: false })).toBeInTheDocument();
  });
});

describe("a book without saved opinions", () => {
  it("explains how to get them, with the way to ask the director", async () => {
    await openWith([]);
    expect(await screen.findByText(t("director.trend.empty"))).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const ask = screen.getAllByRole("button", { name: t("director.ask.title") });
    fireEvent.click(ask[ask.length - 1]);
    await waitFor(() => expect(mocks.ask).toHaveBeenCalledWith({ bookId: "book-1", target: { kind: "book" } }));
  });
});
