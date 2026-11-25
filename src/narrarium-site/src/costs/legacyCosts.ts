import { emptyBucket, type BookUsage, type CostsFile, type UsageBucket } from "@/costs/model";
import { emptyCounters, isReadableLedger, ledgerRows, mergeLedgers, sameLedger, type UsageCounters, type UsageKey, type UsageRow } from "@/costs/ledger";

/**
 * The legacy per-book totals (`CostsFile.books`) and the ledger, side by side. Older clients read and add to the legacy totals only, so this version
 * keeps adding to them exactly what it adds to the ledger (`coveredPart`, the one rule for both). Then, for every book, the legacy totals are the
 * ledger's share plus an «earlier» part that the ledger does not know: what was spent before the ledger began, and what older clients added since.
 *
 *   legacy(book) = earlier(book) + covered(ledger, book)      so      earlier(book) = legacy(book) − covered(ledger, book)
 *
 * Nothing is stored for the «earlier» part (`earlierRows` works it out), so two devices can never count it twice. When copies merge, the ledger is the
 * merge of all of them while the legacy totals can only be one copy's; `mergeCostsFiles` keeps the chosen copy's «earlier» part and puts the merged
 * ledger's share back on it, so the legacy totals stay whole for the older clients too.
 *
 * The fields the ledger accounts for are the tokens and the money (`COVERED_FIELDS`, and by model `MODEL_FIELDS`). The counts that only the legacy
 * totals have (images, characters spoken, hours heard, the tokens of an image) stay as the chosen copy has them, as they always did.
 */

export const COVERED_FIELDS = ["inputTokens", "cachedTokens", "outputTokens", "chatCost", "imageCost", "ttsCost", "sttCost"] as const satisfies ReadonlyArray<keyof UsageBucket>;
export const MODEL_FIELDS = ["inputTokens", "cachedTokens", "outputTokens", "chatCost"] as const satisfies ReadonlyArray<keyof UsageBucket>;

type Covered = Record<(typeof COVERED_FIELDS)[number], number>;
type ModelCovered = Record<(typeof MODEL_FIELDS)[number], number>;

export interface CoveredUsage extends Covered {
  /** By model name; `""` for a call that named none. */
  models: Record<string, ModelCovered>;
}

const MEDIA_COST: Readonly<Record<string, "imageCost" | "ttsCost" | "sttCost">> = { image: "imageCost", tts: "ttsCost", stt: "sttCost" };

export function isMediaCapability(capability: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEDIA_COST, capability);
}

const emptyCovered = (): CoveredUsage => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, chatCost: 0, imageCost: 0, ttsCost: 0, sttCost: 0, models: {} });
const emptyModel = (): ModelCovered => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, chatCost: 0 });

/**
 * What a row (or a delta) of the ledger adds to the legacy totals of its book: what the legacy code recorded, and nothing else. Only a book: a call
 * with no book open was never in them. Only a model with a price: they never counted a call without one. For a chat call, its measured tokens and
 * cost, by model; for an image, a voice or a transcription, its cost. Estimates are never in them.
 */
export function coveredPart(row: Pick<UsageKey, "bookId" | "capability" | "model" | "currency"> & Partial<UsageCounters>): { book: Partial<Covered>; model?: { name: string; values: ModelCovered } } | null {
  if (!row.bookId || !row.currency) return null;
  const cost = row.cost ?? 0;
  const media = Object.prototype.hasOwnProperty.call(MEDIA_COST, row.capability) ? MEDIA_COST[row.capability] : undefined;
  if (media) return cost ? { book: { [media]: cost } } : null;
  const values: ModelCovered = { inputTokens: row.inputTokens ?? 0, cachedTokens: row.cachedTokens ?? 0, outputTokens: row.outputTokens ?? 0, chatCost: cost };
  if (!values.inputTokens && !values.outputTokens && !values.cachedTokens && !values.chatCost) return null;
  return { book: { ...values }, model: { name: row.model, values } };
}

/** The legacy totals' share of the ledger, book by book. */
export function coveredByBook(rows: readonly UsageRow[]): Map<string, CoveredUsage> {
  const books = new Map<string, CoveredUsage>();
  for (const row of rows) {
    const part = coveredPart(row);
    if (!part) continue;
    const book = books.get(row.bookId) ?? emptyCovered();
    for (const field of COVERED_FIELDS) book[field] += part.book[field] ?? 0;
    if (part.model) {
      const model = book.models[part.model.name] ?? emptyModel();
      for (const field of MODEL_FIELDS) model[field] += part.model.values[field];
      book.models[part.model.name] = model;
    }
    books.set(row.bookId, book);
  }
  return books;
}

/** A difference of totals that floating point leaves behind is no amount: under a billionth of money, under half a token. */
const clampMoney = (value: number): number => (value > 1e-9 ? value : 0);
const clampTokens = (value: number): number => (value >= 0.5 ? Math.round(value) : 0);
const clampField = (field: string, value: number): number => (field.endsWith("Cost") ? clampMoney(value) : clampTokens(value));

/**
 * The «earlier» part of a book: its legacy totals less the ledger's share, field by field, never below zero. By model where the legacy totals say which
 * model (what they hold beyond their models is the model `""`); when the models do not add up to the book (copies that lost part of the legacy totals),
 * the book's part is kept whole under `""`, so that the rows never say more than the book.
 */
export function earlierPart(legacy: Partial<UsageBucket> & { models?: Record<string, Partial<UsageBucket>> } | undefined, covered: CoveredUsage | undefined): CoveredUsage {
  const result = emptyCovered();
  if (!legacy) return result;
  const share = covered ?? emptyCovered();
  for (const field of COVERED_FIELDS) result[field] = clampField(field, (legacy[field] ?? 0) - share[field]);
  const named = new Map<string, ModelCovered>();
  for (const [name, values] of Object.entries(legacy.models ?? {})) {
    if (!name) continue;
    const model = emptyModel();
    for (const field of MODEL_FIELDS) model[field] = clampField(field, (values?.[field] ?? 0) - (share.models[name]?.[field] ?? 0));
    if (MODEL_FIELDS.some((field) => model[field] > 0)) named.set(name, model);
  }
  const rest = emptyModel();
  let consistent = true;
  for (const field of MODEL_FIELDS) {
    const left = result[field] - [...named.values()].reduce((sum, model) => sum + model[field], 0);
    if (left < (field === "chatCost" ? -1e-9 : -0.5)) consistent = false;
    rest[field] = clampField(field, left);
  }
  if (!consistent) {
    const whole = emptyModel();
    for (const field of MODEL_FIELDS) whole[field] = result[field];
    if (MODEL_FIELDS.some((field) => whole[field] > 0)) result.models[""] = whole;
    return result;
  }
  for (const [name, model] of named) result.models[name] = model;
  if (MODEL_FIELDS.some((field) => rest[field] > 0)) result.models[""] = rest;
  return result;
}

export const EARLIER = "earlier";

/**
 * What the legacy totals hold that the ledger does not: one row per book and model of chat, and one per kind of media, with the period and the writer
 * `earlier`. Their currency is the one of the setting when the ledger began (`ledger.currency`), or `fallbackCurrency` while there is no ledger: the
 * legacy totals never recorded one. They have no calls: those were never counted.
 */
export function earlierRows(file: Pick<CostsFile, "books" | "ledger">, fallbackCurrency: string): UsageRow[] {
  // A ledger this version cannot read (a newer one) counts for nothing here: the legacy totals, which every version keeps, are shown whole.
  const ledger = isReadableLedger(file.ledger) ? file.ledger : undefined;
  const currency = ledger?.currency || fallbackCurrency;
  const covered = coveredByBook(ledgerRows(ledger));
  const rows: UsageRow[] = [];
  const row = (bookId: string, capability: string, model: string, values: Partial<UsageCounters>): UsageRow => ({
    ...emptyCounters(),
    ...values,
    period: EARLIER,
    bookId,
    source: "other",
    capability,
    integrationId: "",
    model,
    currency,
    writer: EARLIER,
  });
  for (const [bookId, legacy] of Object.entries(file.books ?? {})) {
    if (!bookId || !legacy || typeof legacy !== "object") continue;
    const earlier = earlierPart(legacy, covered.get(bookId));
    for (const [model, values] of Object.entries(earlier.models)) {
      rows.push(row(bookId, "", model, { inputTokens: values.inputTokens, cachedTokens: values.cachedTokens, outputTokens: values.outputTokens, cost: values.chatCost }));
    }
    for (const [capability, field] of Object.entries(MEDIA_COST)) {
      if (earlier[field] > 0) rows.push(row(bookId, capability, "", { cost: earlier[field] }));
    }
  }
  return rows;
}

/** Every row there is: the ledger's, and the «earlier» part of the legacy totals. */
export function usageRows(file: Pick<CostsFile, "books" | "ledger">, fallbackCurrency: string): UsageRow[] {
  return [...ledgerRows(file.ledger), ...earlierRows(file, fallbackCurrency)];
}

/** Adds what a delta of the ledger covers, and the counts only the legacy totals have, to the legacy totals of its book. */
export function addToLegacy(file: CostsFile, bookId: string, bookName: string | undefined, part: ReturnType<typeof coveredPart>, details: Partial<UsageBucket> = {}): CostsFile {
  const detailed = Object.values(details).some((value) => typeof value === "number" && value !== 0);
  if (!bookId || (!part && !detailed)) return file;
  const previous: BookUsage = { ...emptyBucket(), ...(file.books[bookId] ?? {}), bookId };
  const next: BookUsage = { ...previous, bookName: bookName ?? previous.bookName };
  for (const [field, value] of Object.entries({ ...details, ...(part?.book ?? {}) })) {
    const key = field as keyof UsageBucket;
    if (typeof value === "number" && Number.isFinite(value)) next[key] = (previous[key] ?? 0) + value;
  }
  if (part?.model && part.model.name) {
    const models = { ...(previous.models ?? {}) };
    const model = { ...emptyBucket(), ...(models[part.model.name] ?? {}) };
    for (const field of MODEL_FIELDS) model[field] += part.model.values[field];
    models[part.model.name] = model;
    next.models = models;
  }
  return { ...file, books: { ...file.books, [bookId]: next } };
}

/**
 * The costs of the account after copies of it met: `selected` is the copy whose data is kept (the newer one, or the one the person chose), `others` the
 * rest. The ledger is the merge of all of them (nothing recorded by any device is lost, nothing is counted twice: see `ledger.ts`); the legacy totals are
 * the selected copy's «earlier» part with the merged ledger's share on it, and its other counts as they are. When the merge changes nothing, `selected`
 * is returned as it is.
 */
export function mergeCostsFiles(selected: CostsFile, others: readonly CostsFile[]): CostsFile {
  const ledger = mergeLedgers(selected.ledger, ...others.map((other) => other.ledger));
  if (sameLedger(ledger, selected.ledger)) return selected;
  if (!isReadableLedger(ledger)) return { ...selected, ledger };
  const before = coveredByBook(ledgerRows(selected.ledger));
  const after = coveredByBook(ledgerRows(ledger));
  const names = new Map<string, string>();
  for (const copy of [...others].reverse()) for (const [id, book] of Object.entries(copy.books ?? {})) if (book?.bookName) names.set(id, book.bookName);
  const books: Record<string, BookUsage> = { ...selected.books };
  for (const bookId of new Set([...Object.keys(books), ...after.keys()])) {
    if (!bookId) continue;
    const legacy: BookUsage = { ...emptyBucket(), ...(books[bookId] ?? {}), bookId };
    const earlier = earlierPart(legacy, before.get(bookId));
    const now = after.get(bookId) ?? emptyCovered();
    const next: BookUsage = { ...legacy, bookName: legacy.bookName ?? names.get(bookId) };
    for (const field of COVERED_FIELDS) next[field] = earlier[field] + now[field];
    const models: Record<string, UsageBucket> = { ...(legacy.models ?? {}) };
    for (const name of new Set([...Object.keys(earlier.models), ...Object.keys(now.models)])) {
      if (!name) continue;
      const model = { ...emptyBucket(), ...(models[name] ?? {}) };
      for (const field of MODEL_FIELDS) model[field] = (earlier.models[name]?.[field] ?? 0) + (now.models[name]?.[field] ?? 0);
      models[name] = model;
    }
    if (Object.keys(models).length) next.models = models;
    if (!next.bookName) delete next.bookName;
    books[bookId] = next;
  }
  const times = [selected.updatedAt, ...others.map((other) => other.updatedAt)].filter((value): value is string => typeof value === "string").sort();
  const updatedAt = times[times.length - 1] ?? selected.updatedAt;
  return { ...selected, updatedAt, books, ledger };
}
