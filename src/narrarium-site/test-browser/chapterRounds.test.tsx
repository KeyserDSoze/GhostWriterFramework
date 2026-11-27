import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChapterRound } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { Rounds } from "@/components/autopilot/map/ChapterRounds";
import { t } from "./helpers/quickCommands";

// The rounds of a chapter's review, as the map's panel and the reading window tell them: the readers' readings of their own are rows too, and say so.

const REVIEWED: ChapterRound[] = [
  { director: 6, readers: 6.5, verdict: "revise", accepted: 2, rejected: 1, round: 1 },
  { director: 9, verdict: "approve", accepted: 0, rejected: 0, round: 2 },
  { readers: 7, reading: "end", round: 2 },
];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the rounds of review of a chapter", () => {
  it("are a row for each, with the director's vote, the readers', the verdict and the fixes", () => {
    render(<Rounds rounds={REVIEWED.slice(0, 2)} />);
    const rows = within(screen.getByRole("table", { name: t("autopilot.chapterPanel.rounds.title") })).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("6");
    expect(rows[1]).toHaveTextContent("6.5");
    expect(rows[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.revise"));
    expect(rows[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.fixesValue", { accepted: 2, rejected: 1 }));
    expect(rows[2]).toHaveTextContent(t("autopilot.chapterPanel.rounds.approve"));
  });

  it("say, for the readers' reading of their own, that they alone read it, in the place of a verdict, with no vote of the director", () => {
    render(<Rounds rounds={REVIEWED} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent(t("autopilot.chapterPanel.rounds.reading.end"));
    expect(rows[3]).toHaveTextContent("7");
    expect(within(rows[3]).getByText(t("autopilot.map.table.none")), "the director's cell says it has no vote, in words for a screen reader").toBeInTheDocument();
    render(<Rounds rounds={[{ readers: 7.5, reading: "check", round: 1 }, { director: 9, verdict: "approve" }]} />);
    expect(screen.getAllByRole("table")[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.reading.check"));
  });

  it("are drawn as a picture that says in words the votes of the director and every vote of the readers, in order", () => {
    render(<Rounds rounds={REVIEWED} />);
    const picture = screen.getByRole("img");
    expect(picture).toHaveAccessibleName(`${t("autopilot.chapterPanel.rounds.chart", { votes: "6 → 9" })} ${t("autopilot.chapterPanel.rounds.chartReaders", { score: "6.5 → 7" })}`);
  });

  it("are said in Italian", async () => {
    await i18n.changeLanguage("it");
    render(<Rounds rounds={REVIEWED} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")[3]).toHaveTextContent("Solo i lettori: hanno riletto il capitolo dopo le correzioni.");
  });

  it("scroll sideways on a narrow screen in a region the keyboard can reach, named by the table's caption, which keeps its arrow keys", () => {
    render(<Rounds rounds={REVIEWED} />);
    const region = screen.getByRole("region", { name: t("autopilot.chapterPanel.rounds.title") });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("data-own-arrows");
    expect(region.className).toContain("overflow-x-auto");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });

  it("say that there is no round yet, in a sentence", () => {
    render(<Rounds rounds={[]} />);
    expect(screen.getByText(t("autopilot.chapterPanel.rounds.none"))).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
