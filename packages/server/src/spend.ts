import type { FetchAiAttemptEnd } from "narrarium-engine";
import { HttpError } from "./errors.js";
import { atomicJson, readJson, renameReplacing } from "./files.js";

/**
 * What the server's owner lets this server spend on AI, whatever the clients ask for (`config.json`, field `spend`; the panel and
 * `npx narrarium-server spend` change it, a client token never does). `0` is no limit; `paused` is the switch: while it is set no AI call is made.
 */
export interface SpendSettings {
  paused: boolean;
  maxTokensPerDay: number;
  /** In the currency of the AI configuration; counts only the costs that are known. */
  maxCostPerDay: number;
  maxTokensPerRun: number;
  maxCostPerRun: number;
}

export const NO_SPEND_LIMITS: Readonly<SpendSettings> = Object.freeze({ paused: false, maxTokensPerDay: 0, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 });

/** The largest cap that is believed (a cap of a thousand billion tokens is as good as none): a larger value is a typo or a damaged file. */
export const MAX_SPEND_TOKENS = 1_000_000_000_000;
export const MAX_SPEND_COST = 1_000_000;

const TOKEN_LIMITS = ["maxTokensPerDay", "maxTokensPerRun"] as const;
const COST_LIMITS = ["maxCostPerDay", "maxCostPerRun"] as const;

const tokenLimit = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SPEND_TOKENS ? value : undefined);
const costLimit = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SPEND_COST ? value : undefined);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The settings of a configuration file, however old or hand-edited: a value that is not valid is no limit (and the switch is on). Never throws. */
export function parseSpendSettings(value: unknown): SpendSettings {
  const source = record(value);
  return {
    paused: source.paused === true,
    maxTokensPerDay: tokenLimit(source.maxTokensPerDay) ?? 0,
    maxCostPerDay: costLimit(source.maxCostPerDay) ?? 0,
    maxTokensPerRun: tokenLimit(source.maxTokensPerRun) ?? 0,
    maxCostPerRun: costLimit(source.maxCostPerRun) ?? 0,
  };
}

/** Whether anything is set: settings that are all the defaults are not written to `config.json`. */
export function hasSpendSettings(settings: SpendSettings): boolean {
  return settings.paused || settings.maxTokensPerDay > 0 || settings.maxCostPerDay > 0 || settings.maxTokensPerRun > 0 || settings.maxCostPerRun > 0;
}

/** The owner's settings of a configuration (the defaults when it has none). */
export const spendSettingsOf = (config: { spend?: SpendSettings }): SpendSettings => config.spend ?? NO_SPEND_LIMITS;

const invalidSpend = (field: string, expected: string): HttpError => new HttpError(422, "invalid_spend", `${field} must be ${expected}.`);

/** What the owner asked to change, checked strictly: a field that is not there is left as it is, one that is wrong refuses the whole change. */
export function applySpendChanges(current: SpendSettings, body: Record<string, unknown>): SpendSettings {
  const next = { ...current };
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") throw invalidSpend("paused", "true or false");
    next.paused = body.paused;
  }
  for (const field of TOKEN_LIMITS) {
    if (body[field] === undefined) continue;
    const value = tokenLimit(body[field]);
    if (value === undefined) throw invalidSpend(field, `a whole number of tokens from 0 to ${MAX_SPEND_TOKENS} (0 is no limit)`);
    next[field] = value;
  }
  for (const field of COST_LIMITS) {
    if (body[field] === undefined) continue;
    const value = costLimit(body[field]);
    if (value === undefined) throw invalidSpend(field, `an amount from 0 to ${MAX_SPEND_COST} (0 is no limit)`);
    next[field] = value;
  }
  return next;
}

export type SpendLimitReason = "paused" | "tokens-per-day" | "cost-per-day" | "tokens-per-run" | "cost-per-run";

/**
 * An AI call that the owner's switch or caps refuse. The engine reads `retryable: false` as "do not repeat this" and stops the run with the
 * message, which says why and who can change it; the run resumes with Resume once the owner raised the cap, or on the next UTC day.
 */
export class SpendLimitError extends Error {
  readonly retryable = false;

  constructor(readonly reason: SpendLimitReason, message: string) {
    super(message);
    this.name = "SpendLimitError";
  }
}

/** The refusal of the owner's switch: the call that was about to go, and a question in flight that the switch abandons, are answered with it. */
export function pausedError(): SpendLimitError {
  return new SpendLimitError("paused", "Server spending is paused: the server's owner has switched AI calls off, so nothing was sent to any AI provider. They can switch them on again in the server's admin panel (AI spending) or with `npx narrarium-server spend --resume`; then resume the autopilot.");
}

/** What a client reads of the spending (`GET /api/v1/ai`, `spend`): today's use, the owner's caps, the switch. */
export interface ServerSpendStatus {
  paused: boolean;
  today: {
    /** The UTC day the totals are of. */
    day: string;
    tokens: number;
    calls: number;
    /** Present when at least one cost of the day is known (an estimate from estimated tokens counts too). */
    cost?: number;
    currency?: string;
    /** Calls that used tokens and whose cost is a guess or has no price. */
    costUnknownCalls?: number;
  };
  limits: Omit<SpendSettings, "paused">;
}

/** The part of the engine's `onAttemptEnd` hook the record is fed with: numbers only, nothing of the prompt, the reply or an error. */
export type AttemptSpend = Pick<FetchAiAttemptEnd, "usage" | "usageKnown" | "cost" | "costKnown" | "currency"> & Partial<Pick<FetchAiAttemptEnd, "outcome">>;

/** Which run a call belongs to (`runId` of the engine's `run-started`). */
export interface SpendScope {
  bookId: string;
  runId: string;
}

interface Totals {
  tokens: number;
  calls: number;
  cost?: number;
  currency?: string;
  costUnknownCalls: number;
}

interface RunRecord extends Totals {
  runId: string;
  startedAt: string;
}

const MAX_DAYS = 31;
/** More than the server hosts books (`MAX_BOOKS`): a record per book, the latest run of each. */
const MAX_RUN_RECORDS = 200;
/** What `spend.json` can weigh and still be read: 31 days and 200 runs are a few tens of kilobytes. */
const MAX_FILE_BYTES = 256 * 1024;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[\p{L}\p{Sc}]{1,8}$/u;

const whole = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const amount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const currencyOf = (value: unknown): string | undefined => (typeof value === "string" && CURRENCY.test(value) ? value : undefined);
/** Costs are sums of many small ones: shown without the noise of floating point. */
const shown = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const plain = (value: number): string => String(Math.round(value * 10_000) / 10_000);
const money = (value: number, currency: string | undefined): string => (currency ? `${plain(value)} ${currency}` : plain(value));

function totalsFrom(value: unknown): Totals {
  const source = record(value);
  const cost = amount(source.cost);
  const currency = cost === undefined ? undefined : currencyOf(source.currency);
  return { tokens: whole(source.tokens), calls: whole(source.calls), ...(cost !== undefined ? { cost } : {}), ...(currency ? { currency } : {}), costUnknownCalls: whole(source.costUnknownCalls) };
}

function writable(totals: Totals): Totals {
  return { tokens: totals.tokens, calls: totals.calls, ...(totals.cost !== undefined ? { cost: shown(totals.cost), ...(totals.currency ? { currency: totals.currency } : {}) } : {}), costUnknownCalls: totals.costUnknownCalls };
}

export interface SpendLedgerOptions {
  /** `private/spend.json`. */
  file: string;
  /** The clock that decides the UTC day (tests move it). */
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Everything the server spent on AI, as the owner's caps need it: the totals of each UTC day (the last 31 are kept) and of the latest run of
 * each book (a list), in `private/spend.json` (written atomically, small, numbers and ids only: never a key, a prompt, a reply or an error). It is fed by
 * the AI client's `onAttemptEnd`, so every attempt counts, the failed ones that used tokens included, and it is read again at start: a
 * restart does not give the day's allowance back. A record that cannot be read never stops the server: it starts again from zero, says so,
 * and keeps the unreadable file aside.
 */
export class SpendLedger {
  /** Set when the record on disk could not be read and the totals started again from zero (the panel shows it to the owner). */
  warning: string | undefined;
  private readonly days = new Map<string, Totals>();
  private readonly runs = new Map<string, RunRecord>();
  /** Runs that are going on now: only their attempts count in a run's totals. */
  private readonly active = new Map<string, string>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private dirty = false;
  private writing: Promise<void> | undefined;
  private failure: string | undefined;

  private constructor(private readonly options: SpendLedgerOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  static async open(options: SpendLedgerOptions): Promise<SpendLedger> {
    const ledger = new SpendLedger(options);
    await ledger.load();
    return ledger;
  }

  private async load(): Promise<void> {
    let stored: unknown;
    try {
      stored = await readJson(this.options.file, MAX_FILE_BYTES);
      if (stored !== undefined && (typeof stored !== "object" || stored === null || Array.isArray(stored) || (stored as { version?: unknown }).version !== 1)) {
        throw new Error("it is not a spending record of this version");
      }
    } catch (error) {
      await this.setAside(error);
      return;
    }
    if (stored === undefined) return;
    const source = stored as { days?: unknown; runs?: unknown };
    for (const [key, value] of Object.entries(record(source.days))) if (DAY_KEY.test(key)) this.days.set(key, totalsFrom(value));
    // The runs are a list, never an object keyed by book id: `readJson` refuses a file with a key like `constructor`, and a book may be called so.
    for (const value of Array.isArray(source.runs) ? source.runs : []) {
      const run = record(value);
      if (typeof run.bookId === "string" && run.bookId && run.bookId.length <= 120 && typeof run.runId === "string" && run.runId) {
        this.runs.set(run.bookId, { ...totalsFrom(value), runId: run.runId, startedAt: typeof run.startedAt === "string" ? run.startedAt : new Date(0).toISOString() });
      }
    }
    this.prune();
  }

  /** The record cannot be read: keep it for the owner, start from zero, and say so. */
  private async setAside(error: unknown): Promise<void> {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
    const kept = await renameReplacing(this.options.file, `${this.options.file}.damaged`).then(() => true, () => false);
    this.warning = `private/spend.json could not be read (${reason}): the totals start from zero${kept ? " and the unreadable file was kept as spend.json.damaged" : ""}.`;
    this.log(`Spend: ${this.warning}`);
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private today(): Totals {
    const key = this.dayKey();
    let totals = this.days.get(key);
    if (!totals) {
      totals = { tokens: 0, calls: 0, costUnknownCalls: 0 };
      this.days.set(key, totals);
    }
    return totals;
  }

  /** A new run of a book starts its own count from zero. */
  beginRun(bookId: string, runId: string): void {
    this.runs.set(bookId, { runId, startedAt: this.now().toISOString(), tokens: 0, calls: 0, costUnknownCalls: 0 });
    this.active.set(bookId, runId);
    this.prune();
    this.touch();
  }

  /** The run is over; what it spent stays in the record. The end of an older run does not end the current one. */
  endRun(bookId: string, runId: string): void {
    if (this.active.get(bookId) === runId) this.active.delete(bookId);
  }

  activeRun(bookId: string): string | undefined {
    return this.active.get(bookId);
  }

  /** What the latest run of a book spent (for tests and diagnostics). */
  run(bookId: string): Readonly<RunRecord> | undefined {
    return this.runs.get(bookId);
  }

  forgetBook(bookId: string): void {
    this.active.delete(bookId);
    if (this.runs.delete(bookId)) this.touch();
  }

  /** Count an attempt: it was a call, and it used what the provider reported (or the engine estimated) whether or not it worked. */
  record(end: AttemptSpend, scope?: SpendScope | null): void {
    const usage = end.usage;
    const tokens = usage ? whole(usage.inputTokens) + whole(usage.outputTokens) : 0;
    const cost = amount(end.cost);
    const currency = cost === undefined ? undefined : currencyOf(end.currency);
    const unknownCost = Boolean(usage) && end.costKnown !== true;
    const targets: Totals[] = [this.today()];
    const run = scope ? this.runs.get(scope.bookId) : undefined;
    if (run && scope && run.runId === scope.runId) targets.push(run);
    for (const totals of targets) {
      totals.calls += 1;
      totals.tokens += tokens;
      if (cost !== undefined) {
        totals.cost = (totals.cost ?? 0) + cost;
        if (currency) totals.currency = currency;
      }
      if (unknownCost) totals.costUnknownCalls += 1;
    }
    this.prune();
    this.touch();
  }

  /**
   * Refuse a call the owner's settings do not allow: the switch first, then the day's caps, then the run's. A cap is reached when the total has
   * got to it, so the call that crosses a cap is the last one (nothing starts after it). A cost cap counts only the costs that are known.
   */
  assertAllowed(settings: SpendSettings, scope?: SpendScope | null): void {
    if (settings.paused) throw pausedError();
    const day = this.days.get(this.dayKey());
    const raise = "The owner can raise it in the server's admin panel (AI spending) or with `npx narrarium-server spend`; otherwise resume tomorrow (after midnight UTC).";
    if (settings.maxTokensPerDay > 0 && (day?.tokens ?? 0) >= settings.maxTokensPerDay) {
      throw new SpendLimitError("tokens-per-day", `Server spending cap reached: ${day?.tokens ?? 0} tokens were used today (UTC) and the owner's cap is ${settings.maxTokensPerDay} a day, so nothing was sent. ${raise}`);
    }
    if (settings.maxCostPerDay > 0 && (day?.cost ?? 0) >= settings.maxCostPerDay) {
      throw new SpendLimitError("cost-per-day", `Server spending cap reached: ${money(day?.cost ?? 0, day?.currency)} was spent today (UTC) and the owner's cap is ${money(settings.maxCostPerDay, day?.currency)} a day, so nothing was sent. ${raise}`);
    }
    const run = scope ? this.runs.get(scope.bookId) : undefined;
    if (!run || !scope || run.runId !== scope.runId) return;
    const again = "Resume to start a new run, or ask the owner to raise the cap (admin panel → AI spending).";
    if (settings.maxTokensPerRun > 0 && run.tokens >= settings.maxTokensPerRun) {
      throw new SpendLimitError("tokens-per-run", `Server spending cap reached: this run used ${run.tokens} tokens and the owner's cap is ${settings.maxTokensPerRun} a run, so nothing more was sent. ${again}`);
    }
    if (settings.maxCostPerRun > 0 && (run.cost ?? 0) >= settings.maxCostPerRun) {
      throw new SpendLimitError("cost-per-run", `Server spending cap reached: this run spent ${money(run.cost ?? 0, run.currency)} and the owner's cap is ${money(settings.maxCostPerRun, run.currency)} a run, so nothing more was sent. ${again}`);
    }
  }

  status(settings: SpendSettings): ServerSpendStatus {
    const day = this.dayKey();
    const totals = this.days.get(day);
    return {
      paused: settings.paused,
      today: {
        day,
        tokens: totals?.tokens ?? 0,
        calls: totals?.calls ?? 0,
        ...(totals?.cost !== undefined ? { cost: shown(totals.cost), ...(totals.currency ? { currency: totals.currency } : {}) } : {}),
        ...(totals?.costUnknownCalls ? { costUnknownCalls: totals.costUnknownCalls } : {}),
      },
      limits: { maxTokensPerDay: settings.maxTokensPerDay, maxCostPerDay: settings.maxCostPerDay, maxTokensPerRun: settings.maxTokensPerRun, maxCostPerRun: settings.maxCostPerRun },
    };
  }

  /** Only the newest days and runs are kept: the record stays small whatever happens, and a run that is going on is never the one dropped. */
  private prune(): void {
    if (this.days.size > MAX_DAYS) {
      const keep = new Set([...this.days.keys()].sort().slice(-MAX_DAYS));
      for (const key of [...this.days.keys()]) if (!keep.has(key)) this.days.delete(key);
    }
    if (this.runs.size > MAX_RUN_RECORDS) {
      const oldest = [...this.runs.entries()].filter(([book, run]) => this.active.get(book) !== run.runId).sort((left, right) => left[1].startedAt.localeCompare(right[1].startedAt));
      for (const [book] of oldest) {
        if (this.runs.size <= MAX_RUN_RECORDS) break;
        this.runs.delete(book);
      }
    }
  }

  private snapshot(): unknown {
    const days: Record<string, Totals> = {};
    for (const key of [...this.days.keys()].sort()) days[key] = writable(this.days.get(key)!);
    const runs = [...this.runs].map(([bookId, run]) => ({ bookId, runId: run.runId, startedAt: run.startedAt, ...writable(run) }));
    return { version: 1, updatedAt: this.now().toISOString(), days, runs };
  }

  /** Writes are queued and merged: one that is running writes the latest state again when it is done, so a burst of calls is a few writes. */
  private touch(): void {
    this.dirty = true;
    if (this.writing) return;
    const writing: Promise<void> = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await atomicJson(this.options.file, this.snapshot(), 0o600);
          this.failure = undefined;
        } catch (error) {
          // Counting goes on in memory; the owner is told once per kind of failure, not at every call.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== this.failure) this.log(`Spend: the record could not be saved (${message.slice(0, 200)}): the totals are kept in memory until it can.`);
          this.failure = message;
        }
      }
    })().finally(() => {
      this.writing = undefined;
    });
    this.writing = writing;
  }

  /** Wait until what was counted is on disk. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}

/** The status as the command line shows it, in lines. */
export function describeSpend(status: ServerSpendStatus & { warning?: string }): string[] {
  const { today, limits } = status;
  const used = [`${today.tokens} tokens`, `${today.calls} calls`, ...(today.cost !== undefined ? [`${today.cost}${today.currency ? ` ${today.currency}` : ""}`] : []), ...(today.costUnknownCalls ? [`${today.costUnknownCalls} calls with no known cost`] : [])];
  const tokens = (value: number) => (value > 0 ? `${value} tokens` : "no limit");
  const money = (value: number) => (value > 0 ? `cost ${value}` : "no cost limit");
  return [
    `AI spending:  ${status.paused ? "PAUSED by the owner: no AI call is made until it is resumed (--resume)" : "allowed"}`,
    `Today (UTC):  ${today.day} · ${used.join(" · ")}`,
    `Per day:      ${tokens(limits.maxTokensPerDay)} · ${money(limits.maxCostPerDay)}`,
    `Per run:      ${tokens(limits.maxTokensPerRun)} · ${money(limits.maxCostPerRun)}`,
    ...(status.warning ? [`Warning:      ${status.warning}`] : []),
  ];
}
