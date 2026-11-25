/** The periods of the usage ledger, on their own: the recorder names the day of a call without loading the ledger. */

const pad = (value: number): string => String(value).padStart(2, "0");

/** The day of a moment on the calendar of this device: «today» and «this month» are the person's, not UTC's. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function localMonth(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`;
}
