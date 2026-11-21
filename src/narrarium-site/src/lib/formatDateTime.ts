export interface LocalDateTimeOptions {
  /** IANA time zone. Defaults to the one of the browser; tests pass one to stay deterministic. */
  timeZone?: string;
}

function formatterFor(language: string, style: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const options = { ...style, ...(timeZone ? { timeZone } : {}) };
  try { return new Intl.DateTimeFormat(language || "en", options); }
  catch { return new Intl.DateTimeFormat("en", options); }
}

/** Only ISO 8601 text is read as a date: `new Date` also accepts text such as "build 12". */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** A date without a time is a calendar day, not an instant: it must not move with the time zone. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parse(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isReadableInstant(value: unknown): value is string {
  return parse(value) !== null;
}

/** Date and time of an ISO instant in the app language and the viewer's time zone. An unreadable value is returned as it is. */
export function formatLocalDateTime(value: string | null | undefined, language: string, options: LocalDateTimeOptions = {}): string {
  const date = parse(value);
  if (!date) return value ?? "";
  if (CALENDAR_DAY.test(value!)) return formatterFor(language, { dateStyle: "medium" }, "UTC").format(date);
  return formatterFor(language, { dateStyle: "medium", timeStyle: "short" }, options.timeZone).format(date);
}

/** Only the time of an ISO instant, in the app language and the viewer's time zone. */
export function formatLocalTime(value: string | null | undefined, language: string, options: LocalDateTimeOptions = {}): string {
  const date = parse(value);
  if (!date || CALENDAR_DAY.test(value!)) return formatLocalDateTime(value, language, options);
  return formatterFor(language, { timeStyle: "short" }, options.timeZone).format(date);
}

/** Whether the instant falls on today's date in the viewer's time zone. */
export function isLocalToday(value: string | null | undefined, options: LocalDateTimeOptions & { now?: Date } = {}): boolean {
  const date = parse(value);
  if (!date) return false;
  const day = formatterFor("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }, options.timeZone);
  return day.format(date) === day.format(options.now ?? new Date());
}
