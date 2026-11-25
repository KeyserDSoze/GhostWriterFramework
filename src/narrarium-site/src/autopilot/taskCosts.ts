import { create } from "zustand";
import { addMoney, type MoneyTotals } from "@/costs/money";
import { onUsageRecorded, type RecordedUsage } from "@/costs/recordUsage";
import { isOwnCallTask } from "@/costs/usageTasks";

/**
 * What each step of an autopilot run of this browser used, call by call, as the recorder heard it (`recordUsage`): the same numbers the ledger keeps, by step
 * instead of by day. A step is an activity of the engine (a retry of a step is an activity of its own). It is what lets a step say its calls, its fallbacks
 * and retries, the money of each currency, the estimates apart and the models without a price, exactly; the engine's own record of a step (`activity.cost`,
 * `activity.usage`) has its cost and its tokens only. Kept on this device (the last `MAX_TASKS` steps), since the steps of a browser run are recorded here.
 */
export interface TaskCost {
  bookId: string;
  task: string;
  /** Requests sent to a provider: every attempt, fallbacks and failed ones included. */
  calls: number;
  /** Measured money, by currency. */
  money: MoneyTotals;
  /** The engine's estimate of the money of the calls whose tokens were not reported, by currency. Never added to `money`. */
  estimated: MoneyTotals;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** The engine's estimate of the tokens of the calls whose tokens were not reported. */
  estimatedTokens: number;
  unpricedCalls: number;
  unknownUsageCalls: number;
  /** The models asked, in the order of their first call. */
  models: string[];
  /** The models asked without a price, with their integration. */
  unpriced: Array<{ integrationId: string; model: string }>;
  /** When its last call ended. */
  at: string;
}

const STORAGE_KEY = "narrarium-task-costs-v1";
export const MAX_TASKS = 400;

const keyOf = (bookId: string, task: string) => `${bookId}\u0000${task}`;

function load(): Record<string, TaskCost> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, TaskCost>) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The newest `MAX_TASKS` steps, by the end of their last call. */
export function boundTasks(tasks: Record<string, TaskCost>): Record<string, TaskCost> {
  const entries = Object.entries(tasks);
  if (entries.length <= MAX_TASKS) return tasks;
  return Object.fromEntries(entries.sort(([, left], [, right]) => right.at.localeCompare(left.at)).slice(0, MAX_TASKS));
}

/** A step with one more call of it. */
export function withCall(previous: TaskCost | undefined, recorded: RecordedUsage, at: string): TaskCost {
  const { record, delta } = recorded;
  const counters = delta.counters;
  const currency = delta.key.currency;
  const base: TaskCost = previous ?? { bookId: delta.key.bookId, task: record.task ?? "", calls: 0, money: {}, estimated: {}, inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimatedTokens: 0, unpricedCalls: 0, unknownUsageCalls: 0, models: [], unpriced: [], at };
  const unpriced = counters.unpricedCalls && !base.unpriced.some((entry) => entry.integrationId === delta.key.integrationId && entry.model === delta.key.model)
    ? [...base.unpriced, { integrationId: delta.key.integrationId, model: delta.key.model }]
    : base.unpriced;
  return {
    ...base,
    calls: base.calls + (counters.calls ?? 0),
    money: counters.cost ? addMoney(base.money, currency, counters.cost) : base.money,
    estimated: counters.estimatedCost ? addMoney(base.estimated, currency, counters.estimatedCost) : base.estimated,
    inputTokens: base.inputTokens + (counters.inputTokens ?? 0),
    cachedTokens: base.cachedTokens + (counters.cachedTokens ?? 0),
    outputTokens: base.outputTokens + (counters.outputTokens ?? 0),
    estimatedTokens: base.estimatedTokens + (counters.estimatedInputTokens ?? 0) + (counters.estimatedOutputTokens ?? 0),
    unpricedCalls: base.unpricedCalls + (counters.unpricedCalls ?? 0),
    unknownUsageCalls: base.unknownUsageCalls + (counters.unknownUsageCalls ?? 0),
    models: base.models.includes(delta.key.model) ? base.models : [...base.models, delta.key.model],
    unpriced,
    at,
  };
}

interface TaskCostsState {
  tasks: Record<string, TaskCost>;
}

export const useTaskCosts = create<TaskCostsState>()(() => ({ tasks: load() }));

/** The record of a step of a book, when this browser ran it. */
export function taskCostOf(tasks: Record<string, TaskCost>, bookId: string, task: string): TaskCost | undefined {
  return tasks[keyOf(bookId, task)];
}

const byTask = new WeakMap<Record<string, TaskCost>, Map<string, TaskCost>>();

/** The record of a step by its activity alone (an activity's id is unique): for a view that does not know the book. Indexed once for each state of the records. */
export function taskCostByTask(tasks: Record<string, TaskCost>, task: string): TaskCost | undefined {
  let index = byTask.get(tasks);
  if (!index) {
    index = new Map(Object.values(tasks).map((record) => [record.task, record]));
    byTask.set(tasks, index);
  }
  return index.get(task);
}

let saving: ReturnType<typeof setTimeout> | null = null;

function writeNow(): void {
  if (saving) clearTimeout(saving);
  saving = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useTaskCosts.getState().tasks));
  } catch {
    // The steps of this page are still shown; another page sees them from the engine's record.
  }
}

/** Written a moment after the calls end, so that a burst of calls is one write; at once when the page is left (`installTaskCosts`). */
function save(): void {
  if (saving) return;
  saving = setTimeout(writeNow, 500);
}

let installed = false;

/** Starts hearing the recorder: what the calls of an autopilot step used is kept with its step. Idempotent; the runtime calls it when it loads. */
export function installTaskCosts(): void {
  if (installed) return;
  installed = true;
  onUsageRecorded((recorded) => {
    const { record } = recorded;
    // A call of a run outside its steps (no step runs) is a task of its own: no step shows it, and it would push the steps out of what is kept.
    if (record.origin !== "autopilot" || !record.task || !record.bookId || isOwnCallTask(record.task)) return;
    const key = keyOf(record.bookId, record.task);
    const at = (record.at ?? new Date()).toISOString();
    useTaskCosts.setState((state) => ({ tasks: boundTasks({ ...state.tasks, [key]: withCall(state.tasks[key], recorded, at) }) }));
    save();
  });
  if (typeof window !== "undefined") {
    // A run of another tab of this browser: its steps are read when it writes them.
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY) useTaskCosts.setState({ tasks: load() });
    });
    // A page that is reloaded, closed or put away right after a call keeps what its steps used: what waits to be written is written then.
    window.addEventListener("pagehide", () => { if (saving) writeNow(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && saving) writeNow(); });
  }
}

installTaskCosts();

/** Forgets every step: for the tests. */
export function resetTaskCosts(): void {
  useTaskCosts.setState({ tasks: {} });
}
