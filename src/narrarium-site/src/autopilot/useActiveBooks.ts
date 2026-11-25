import { useEffect, useMemo, useRef, useState } from "react";
import { activeBooks, type ActiveBook, type ActiveBooksInput } from "@/autopilot/activeBooks";
import { useNow } from "@/autopilot/useNow";
import { useAutopilotStore, type BookAutopilotView } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import type { ServerBookSummary, AutopilotStateSummary } from "narrarium-engine";

type RunnerRule = NonNullable<ActiveBooksInput["runnerActivity"]>;

let loadedRule: RunnerRule | null = null;
let loadingRule: Promise<RunnerRule> | null = null;

/**
 * The engine's rule for a runner that is still alive, for whoever does not bring it (the launcher: the shell does not carry the engine's session).
 * It is loaded the first time a book says that it runs; when the autopilot runs here it has it already, and it costs nothing.
 */
function useLoadedRunnerRule(needed: boolean): RunnerRule | null {
  const [rule, setRule] = useState<RunnerRule | null>(() => loadedRule);
  useEffect(() => {
    if (rule || !needed) return undefined;
    let current = true;
    loadingRule ??= import("@/autopilot/runnerRule").then((module) => (loadedRule = module.runnerActivity));
    loadingRule.then((next) => { if (current) setRule(() => next); }, () => { loadingRule = null; });
    return () => { current = false; };
  }, [rule, needed]);
  return rule;
}

/** Some book says that it runs: only then does the rule for a runner still alive change what the list is. */
function claimsToRun(summaries: Readonly<Record<string, AutopilotStateSummary | undefined>>, views: Readonly<Record<string, BookAutopilotView | undefined>>, serverBooks: readonly ServerBookSummary[]): boolean {
  return Object.values(summaries).some((summary) => summary?.status === "running")
    || Object.values(views).some((view) => view?.snapshot?.state?.status === "running" || view?.snapshot?.summary?.status === "running")
    || serverBooks.some((book) => book.autopilot?.status === "running");
}

export interface ActiveBooksOptions {
  /** Reads a downloaded state the events did not catch up with: the live panel and the page of every book pass `latestSummary`. */
  summarize?: ActiveBooksInput["summarize"];
  /** The engine's `runnerActivity`, from the views that load the engine anyway; without it the rule is loaded when a book says that it runs. */
  runnerActivity?: RunnerRule;
}

/**
 * The books whose autopilots the author should see at a glance (`activeBooks`), kept the same list while nothing of it changes: whoever draws it is
 * not drawn again for the text a step streams. The list is looked at again once a minute too, so that an old pause leaves it. The launcher, which
 * only counts, goes without `summarize`, and without the engine until a book says that it runs.
 */
export function useActiveBooks({ summarize, runnerActivity }: ActiveBooksOptions = {}): ActiveBook[] {
  const books = useSettingsStore((state) => state.settings.books);
  const summaries = useAutopilotStore((state) => state.summaries);
  const views = useAutopilotStore((state) => state.views);
  const serverBooks = useAutopilotStore((state) => state.server.books);
  const live = useAutopilotStore((state) => state.live);
  const now = useNow(60_000);
  const loaded = useLoadedRunnerRule(!runnerActivity && claimsToRun(summaries, views, serverBooks));
  const rule = runnerActivity ?? loaded ?? undefined;
  const computed = useMemo(() => {
    const list = activeBooks({ books, summaries, views, serverBooks, live, now, summarize, runnerActivity: rule });
    return { list, key: list.map((book) => `${book.id}:${book.kind}:${book.state}:${book.host}:${book.name}:${book.step?.id ?? ""}`).join("|") };
  }, [books, summaries, views, serverBooks, live, now, summarize, rule]);
  const kept = useRef(computed);
  if (kept.current.key !== computed.key) kept.current = computed;
  return kept.current.list;
}
