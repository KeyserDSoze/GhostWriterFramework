import type { AiRuntimeConfig, RedactedAiIntegration } from "../ai/config.js";
import type { EvaluationTarget } from "../book/paths.js";
import type { BookFileChange, BookFileContent, BookFileEntry } from "../book/store.js";
import type { DirectorOpinion } from "../director/opinion.js";
import type { AutopilotEvent, AutopilotSnapshot, AutopilotStateSummary, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";

export const SERVER_API_VERSION = 1;
export const DEFAULT_SERVER_PORT = 24242;
export const SERVER_PACKAGE_NAME = "narrarium-server";

export interface ServerInfo {
  name: typeof SERVER_PACKAGE_NAME;
  apiVersion: number;
  serverVersion: string;
  engineVersion: string;
  serverId: string;
  label: string;
  /** Whether `git` is available for GitHub-backed books. */
  git: boolean;
  features: string[];
}

export interface ServerSession {
  serverId: string;
  label: string;
  clientLabel: string;
  clientId: string;
}

export type ServerBookStorage =
  | { kind: "github"; owner: string; repo: string; branch: string }
  | { kind: "local" };

export interface RegisterBookRequest {
  title: string;
  storage: ServerBookStorage;
  /** GitHub token for this book, sent only with the author's consent. `null` removes it. */
  githubToken?: string | null;
}

export interface ServerBookSync {
  at: string;
  ok: boolean;
  message: string;
  head?: string;
}

export interface ServerBookSummary {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  hasGithubToken: boolean;
  ready: boolean;
  /** Changes whenever a file of the book changes on the server. */
  revision: string;
  autopilot: AutopilotStateSummary | null;
  running: boolean;
  lastSync: ServerBookSync | null;
  error?: string;
}

export interface ServerManifest {
  revision: string;
  files: BookFileEntry[];
}

export interface CommitFilesRequest {
  changes: BookFileChange[];
  message: string;
}

export interface ReadFilesResponse {
  files: BookFileContent[];
}

export interface AskDirectorRequest {
  target: EvaluationTarget;
  question?: string;
  save?: boolean;
}

export interface AskDirectorResponse {
  opinion: DirectorOpinion;
  path: string;
  saved: boolean;
}

export interface ServerAiStatus {
  configured: boolean;
  integrations: RedactedAiIntegration[];
  routedTasks: string[];
  updatedAt: string | null;
}

export interface PutAiConfigRequest {
  config: AiRuntimeConfig;
}

export type StartAutopilotRequest = StartOptions & { force?: boolean };
export type PauseAutopilotRequest = { mode: "now" | "after-step" };
export type InterveneRequest = InterventionInput;
export type AnswerRequest = QuestionAnswer;

export interface EventsResponse {
  events: AutopilotEvent[];
  lastSeq: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/** Messages carried by the `/api/v1/events` stream. */
export type ServerStreamMessage =
  | { event: "hello"; data: { serverId: string; at: string } }
  | { event: "heartbeat"; data: { at: string } }
  | { event: "autopilot"; data: AutopilotEvent }
  | { event: "book"; data: ServerBookSummary };

export function encodeServerSentEvent(message: ServerStreamMessage, id?: string | number): string {
  const lines = [`event: ${message.event}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  for (const line of JSON.stringify(message.data).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Incremental parser for a `text/event-stream` body. */
export class ServerSentEventParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  constructor(private readonly onEvent: (event: string, data: string) => void, private readonly maxEventBytes = 2_000_000) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes) throw new Error("Server event too large.");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.onEvent(this.event, this.data.join("\n"));
      this.event = "message";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value || "message";
    else if (field === "data") this.data.push(value);
  }
}

/** Normalize a server URL typed by the author (`localhost:24242` → `http://localhost:24242`). */
export function normalizeServerUrl(value: string): string {
  let raw = value.trim();
  if (!raw) throw new Error("The server address is empty.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new Error("The server address must use http or https.");
  if (!scheme) raw = `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must use http or https.");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function bookRoute(bookId: string, suffix = ""): string {
  return `/api/v1/books/${encodeURIComponent(bookId)}${suffix}`;
}

export type { AutopilotSnapshot };
