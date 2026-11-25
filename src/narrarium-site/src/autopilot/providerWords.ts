import type { AiErrorBody } from "narrarium-engine";

type Say = (key: string, options?: Record<string, unknown>) => string;

/**
 * What a provider answered when it refused a request, in the words of the page: the labelled fields of its error (its message, its type, its parameter, its code), or what it was instead (a text, the
 * page of a gateway, nothing at all). Pure: the words are the caller's `t`, and the provider's own words are passed through as they are, whole (the engine cut them, with an ellipsis, at two thousand
 * characters; nothing here cuts them).
 */

/** Where the labels are: each surface has its own catalogue (the error panel of the autopilot, the record of a call), and none of them is loaded by the app entry. */
export type ProviderTextScope = "autopilot.failure.provider" | "autopilot.calls.provider";

export interface ProviderRow {
  id: "status" | "message" | "type" | "param" | "code" | "reply" | "raw";
  label: string;
  value: string;
  /** The value is text the provider wrote with no structure, shown as it is. */
  verbatim?: boolean;
}

/** The fields of the body of an error response as labelled rows, in the order a person looks for them: the status (when asked), the message, the type, the parameter, the code. */
export function providerRows(t: Say, body: AiErrorBody, scope: ProviderTextScope, { status = false }: { status?: boolean } = {}): ProviderRow[] {
  const rows: ProviderRow[] = [];
  if (status) rows.push({ id: "status", label: t(`${scope}.status`), value: String(body.status) });
  if (body.shape === "empty") {
    rows.push({ id: "reply", label: t(`${scope}.reply`), value: t(`${scope}.empty`) });
    return rows;
  }
  if (body.shape === "html") {
    rows.push({ id: "reply", label: t(`${scope}.reply`), value: t(`${scope}.page`) });
    if (body.raw) rows.push({ id: "raw", label: t(`${scope}.raw`), value: body.raw, verbatim: true });
    return rows;
  }
  if (body.shape === "text" && !body.message) {
    if (body.raw) rows.push({ id: "reply", label: t(`${scope}.reply`), value: body.raw, verbatim: true });
    return rows;
  }
  if (body.message) rows.push({ id: "message", label: t(`${scope}.message`), value: body.message });
  if (body.type) rows.push({ id: "type", label: t(`${scope}.type`), value: body.type });
  if (body.param) rows.push({ id: "param", label: t(`${scope}.param`), value: body.param });
  if (body.code) rows.push({ id: "code", label: t(`${scope}.code`), value: body.code });
  return rows;
}

/** The same as lines of Markdown for the Copilot, whose messages are text: «- **Message:** …». */
export function providerMarkdown(t: Say, body: AiErrorBody, scope: ProviderTextScope, options: { status?: boolean } = {}): string {
  return providerRows(t, body, scope, options)
    .map((row) => `- **${row.label}:** ${row.verbatim ? `\`${row.value.replace(/`/g, "'").replace(/\s+/g, " ")}\`` : row.value.replace(/\s+/g, " ")}`)
    .join("\n");
}

/** Whether a value read from a file or from another host is a body this page can show: the engine's `AiErrorBody` has a status and a shape. */
export function isErrorBody(value: unknown): value is AiErrorBody {
  return Boolean(value) && typeof value === "object" && typeof (value as { status?: unknown }).status === "number" && typeof (value as { shape?: unknown }).shape === "string";
}
