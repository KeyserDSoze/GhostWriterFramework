import { rename } from "node:fs/promises";
import { cleanText } from "./admin-log.js";
import { atomicJson, readJson } from "./files.js";
import { KeyedMutex } from "./fs-store.js";
import { isExactSemver } from "./npm-release.js";
import type { RuntimeInstaller, UpdateOutcome } from "./runtime-install.js";
import { UPDATE_CHECKS, UPDATE_CHECK_RESULTS, firstRefusal, reasonText, reduceChecks, type UpdateCheckName, type UpdateCheckRecord } from "./update-verification.js";

/**
 * The history of the updates, for the admin panel: the last ones, each with the version it went from and to, how it ended, when, who asked for it, what the supervisor verified on the
 * way and, for a refusal, why. It is a small, bounded file (`update-history.json` of the data folder, 0600) that this server alone writes, joined from what the update already produces:
 * the request (`update-request.json`), the result (`update-result.json`) and the record of what was verified (`private/update-verification.json`, which a supervisor of this version writes
 * before the result). A supervisor that does not write that record leaves a row that says how the update ended and nothing more: nothing is claimed that was not recorded.
 *
 * A release that the server will not offer (its provenance does not hold, it is older than the highest version ever installed here) is a row too, once for each refusal.
 */

export const UPDATE_HISTORY_MAX = 20;
const MAX_FILE_BYTES = 256 * 1024;

export type UpdateRowState = "requested" | UpdateOutcome | "refused";

/** Why an update did not happen: the first check that did not pass, and how. */
export interface UpdateRefusal {
  check?: UpdateCheckName;
  kind: "refused" | "unreadable" | "failed";
  reason?: string;
  code?: string;
}

export interface UpdateHistoryEntry {
  /** The request's id for an update, `offer-…` for a release that was not offered. */
  id: string;
  kind: "update" | "offer";
  state: UpdateRowState;
  /** When it ended (an update), when it was asked for (one that waits), or when it was first refused (an offer). */
  at: string;
  requestedAt?: string;
  by?: "admin" | "client";
  /** The name of the client that asked, when one did. */
  actor?: string;
  from?: string;
  to?: string;
  /** What was verified, one record for each check, in the order of the install: absent when the supervisor did not say. */
  checks?: UpdateCheckRecord[];
  refusal?: UpdateRefusal;
}

export interface UpdateHistoryOptions {
  /** Where the history is kept (`update-history.json` in the data folder). */
  file: string;
  installer: Pick<RuntimeInstaller, "readUpdateRequest" | "readUpdateResult" | "readUpdateVerification">;
  /** The version this server runs: what an update that waits goes from. */
  currentVersion: string;
  now?: () => Date;
  max?: number;
  log?: (line: string) => void;
  /** Told when an update has ended (once for each: the owner's log keeps it). It never fails the history. */
  onFinished?: (entry: UpdateHistoryEntry) => void | Promise<void>;
}

const STATES: readonly string[] = ["requested", "completed", "failed", "limited", "stopping", "refused"];
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value ? value.replace(/[^\x20-\x7e]/g, "?").slice(0, max) : undefined);
const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const version = (value: unknown): string | undefined => (isExactSemver(value) ? value : undefined);

function parseCheck(value: unknown): UpdateCheckRecord | undefined {
  const source = value as Record<string, unknown> | null;
  if (!source || typeof source !== "object" || !(UPDATE_CHECKS as readonly unknown[]).includes(source.check) || !(UPDATE_CHECK_RESULTS as readonly unknown[]).includes(source.result)) return undefined;
  const reason = text(source.reason, 300);
  const code = typeof source.code === "string" && /^[A-Z][A-Z0-9_]{2,39}$/.test(source.code) ? source.code : undefined;
  return { check: source.check as UpdateCheckName, result: source.result as UpdateCheckRecord["result"], ...(reason ? { reason } : {}), ...(code ? { code } : {}) };
}

/** A row as the file holds it, or `undefined` for what is not one (the file is the server's own, but it may have been edited, or written by another version). */
function parseEntry(value: unknown): UpdateHistoryEntry | undefined {
  const source = value as Record<string, unknown> | null;
  if (!source || typeof source !== "object" || typeof source.id !== "string" || !source.id || source.id.length > 80) return undefined;
  if ((source.kind !== "update" && source.kind !== "offer") || typeof source.state !== "string" || !STATES.includes(source.state) || !isTime(source.at)) return undefined;
  const checks = Array.isArray(source.checks) ? source.checks.slice(0, 8).map(parseCheck).filter((entry): entry is UpdateCheckRecord => entry !== undefined) : undefined;
  const refusalSource = source.refusal as Record<string, unknown> | undefined;
  const refusal: UpdateRefusal | undefined = refusalSource && typeof refusalSource === "object" && (refusalSource.kind === "refused" || refusalSource.kind === "unreadable" || refusalSource.kind === "failed")
    ? {
      kind: refusalSource.kind,
      ...((UPDATE_CHECKS as readonly unknown[]).includes(refusalSource.check) ? { check: refusalSource.check as UpdateCheckName } : {}),
      ...(text(refusalSource.reason, 300) ? { reason: text(refusalSource.reason, 300) } : {}),
      ...(typeof refusalSource.code === "string" && /^[A-Z][A-Z0-9_]{2,39}$/.test(refusalSource.code) ? { code: refusalSource.code } : {}),
    }
    : undefined;
  return {
    id: source.id,
    kind: source.kind,
    state: source.state as UpdateRowState,
    at: source.at,
    ...(isTime(source.requestedAt) ? { requestedAt: source.requestedAt } : {}),
    ...(source.by === "admin" || source.by === "client" ? { by: source.by } : {}),
    ...(cleanText(source.actor, 80) ? { actor: cleanText(source.actor, 80) } : {}),
    ...(version(source.from) ? { from: version(source.from) } : {}),
    ...(version(source.to) ? { to: version(source.to) } : {}),
    ...(checks?.length ? { checks } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

/** Which check a refused offer was about, from the server's own words (`checkNpmServerRelease` says them). */
function offerCheck(message: string): UpdateCheckName | undefined {
  if (/provenance/i.test(message)) return "provenance";
  if (/older than/i.test(message)) return "rollback";
  if (/signed and attested/i.test(message)) return "metadata";
  return undefined;
}

export class UpdateHistory {
  private entries: UpdateHistoryEntry[] = [];
  /** What the last refused offer said: the same refusal asked again is not another row, and a release that is fine again forgets it. */
  private offer: string | undefined;
  private offers = 0;
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;
  private readonly max: number;
  private readonly report: (line: string) => void;

  private constructor(private readonly options: UpdateHistoryOptions) {
    this.now = options.now ?? (() => new Date());
    this.max = options.max ?? UPDATE_HISTORY_MAX;
    this.report = options.log ?? (() => undefined);
  }

  static async open(options: UpdateHistoryOptions): Promise<UpdateHistory> {
    const history = new UpdateHistory(options);
    await history.load();
    return history;
  }

  /** A history that cannot be read never stops the server: it starts again from what the supervisor wrote, and the file that could not be read is kept. */
  private async load(): Promise<void> {
    let stored: unknown;
    try {
      stored = await readJson(this.options.file, MAX_FILE_BYTES);
      if (stored !== undefined && (typeof stored !== "object" || stored === null || Array.isArray(stored) || (stored as { version?: unknown }).version !== 1 || !Array.isArray((stored as { entries?: unknown }).entries))) throw new Error("it is not an update history of this version");
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
      const kept = await rename(this.options.file, `${this.options.file}.damaged`).then(() => true, () => false);
      this.report(`Update history: it could not be read (${reason}): it starts again from what the supervisor wrote${kept ? ", and the unreadable file was kept as update-history.json.damaged" : ""}.`);
      return;
    }
    if (stored === undefined) return;
    const source = stored as { entries: unknown[]; offer?: unknown };
    this.entries = source.entries.map(parseEntry).filter((entry): entry is UpdateHistoryEntry => entry !== undefined).slice(-this.max);
    this.offer = text(source.offer, 400);
    this.offers = this.entries.filter((entry) => entry.kind === "offer").length;
  }

  private async save(): Promise<void> {
    this.entries = this.entries.slice(-this.max);
    await atomicJson(this.options.file, { version: 1, ...(this.offer ? { offer: this.offer } : {}), entries: this.entries }, 0o600);
  }

  private find(id: string): number {
    return this.entries.findIndex((entry) => entry.id === id);
  }

  /** An update the server accepted: a row at once, with who asked for it, so that it is known when the request file is gone. */
  noteRequest(request: { id: string; version: string; by: "admin" | "client"; actor?: string; at?: string }): Promise<void> {
    return this.mutex.run("history", async () => {
      try {
        const actor = request.by === "client" ? cleanText(request.actor, 80) : undefined;
        const index = this.find(request.id);
        if (index >= 0) {
          // A read of the history that came between the request file and this note made the row first: it learns who asked.
          const known = this.entries[index];
          if (known.state !== "requested" || known.actor || !actor) return;
          this.entries[index] = { ...known, by: request.by, actor };
          await this.save();
          return;
        }
        const at = request.at ?? this.now().toISOString();
        this.entries.push({ id: request.id, kind: "update", state: "requested", at, requestedAt: at, by: request.by, ...(actor ? { actor } : {}), from: this.options.currentVersion, to: request.version });
        await this.save();
      } catch (error) {
        this.report(`Update history: it could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /**
   * What the server's check of the release said: a release it will not offer is a row, once for each refusal; anything else forgets the last refusal, so that one that comes again
   * after the release was fine is news.
   */
  noteOffer(check: { reason?: string; message: string }): Promise<void> {
    return this.mutex.run("history", async () => {
      try {
        if (check.reason !== "no_trusted_release") {
          if (this.offer === undefined) return;
          this.offer = undefined;
          await this.save();
          return;
        }
        const message = reasonText(check.message);
        if (this.offer === message) return;
        this.offer = message;
        const named = /^Version (\S+) is not offered/.exec(message)?.[1];
        const to = version(named);
        const code = offerCheck(message);
        this.offers += 1;
        this.entries.push({ id: `offer-${this.now().getTime().toString(36)}-${this.offers}`, kind: "offer", state: "refused", at: this.now().toISOString(), ...(to ? { to } : {}), refusal: { kind: "refused", ...(code ? { check: code } : {}), reason: message } });
        await this.save();
      } catch (error) {
        this.report(`Update history: it could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Join what the supervisor wrote with what is known: a request that waits is a row, an answer completes it (or is a row of its own). Told once for each update that ended. */
  sync(): Promise<void> {
    return this.mutex.run("history", async () => {
      const finished: UpdateHistoryEntry[] = [];
      try {
        const { installer } = this.options;
        const [request, result, verification] = await Promise.all([
          installer.readUpdateRequest().catch(() => undefined),
          installer.readUpdateResult().catch(() => undefined),
          installer.readUpdateVerification().catch(() => undefined),
        ]);
        let changed = false;
        if (request && this.find(request.requestId) < 0 && result?.requestId !== request.requestId) {
          this.entries.push({ id: request.requestId, kind: "update", state: "requested", at: request.requestedAt, requestedAt: request.requestedAt, by: request.source, from: this.options.currentVersion, to: request.version });
          changed = true;
        }
        if (result) {
          const index = this.find(result.requestId);
          const known = index >= 0 ? this.entries[index] : undefined;
          if (!known || known.state === "requested") {
            const asked = request?.requestId === result.requestId ? request : undefined;
            const checks = verification?.requestId === result.requestId ? verification.checks : undefined;
            const refusal = result.state === "failed" && checks ? firstRefusal(checks) : undefined;
            const reduced = checks ? reduceChecks(checks) : [];
            const entry: UpdateHistoryEntry = {
              id: result.requestId,
              kind: "update",
              state: result.outcome,
              at: result.at,
              ...(known?.requestedAt ?? asked?.requestedAt ? { requestedAt: known?.requestedAt ?? asked?.requestedAt } : {}),
              ...(known?.by ?? asked?.source ? { by: known?.by ?? asked?.source } : {}),
              ...(known?.actor ? { actor: known.actor } : {}),
              from: result.fromVersion,
              to: result.version,
              ...(reduced.length ? { checks: reduced } : {}),
              ...(refusal ? { refusal: { kind: refusal.result as UpdateRefusal["kind"], check: refusal.check, ...(refusal.reason ? { reason: refusal.reason } : {}), ...(refusal.code ? { code: refusal.code } : {}) } } : {}),
            };
            if (index >= 0) this.entries[index] = entry;
            else this.entries.push(entry);
            finished.push(entry);
            changed = true;
          }
        }
        if (changed) await this.save();
      } catch (error) {
        this.report(`Update history: it could not be written: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      for (const entry of finished) {
        try {
          await this.options.onFinished?.(entry);
        } catch {
          // The owner's log never fails the history.
        }
      }
    });
  }

  /** The rows, newest first, after joining what the supervisor wrote. */
  async list(): Promise<UpdateHistoryEntry[]> {
    await this.sync();
    return this.mutex.run("history", async () => [...this.entries].reverse());
  }
}
