import { appendFile, readFile, stat } from "node:fs/promises";
import { atomicWrite } from "./files.js";
import { KeyedMutex } from "./fs-store.js";

/**
 * One call of a tool: who made it, when, which tool, and which files it looked at or changed. Never the text of anything, and never an error's
 * message (a message may quote the text that was asked for): only its short code.
 */
export interface McpAuditEntry {
  /** The number of the entry: it goes up by one with every call and is never reused, so a page of the audit can say where it ends. */
  seq?: number;
  at: string;
  bookId: string;
  /** What the owner calls the client (the name it was paired or issued under). */
  client: string;
  clientId: string;
  tool: string;
  ok: boolean;
  /** Why a call that failed failed, as a short code (`conflict`, `forbidden`, `scope`…). */
  code?: string;
  paths?: string[];
  /** The revision a write made. */
  commit?: string;
}

/** The file stops growing here: the oldest entries go, the newest `KEEP_ENTRIES` stay. */
const MAX_BYTES = 512 * 1024;
const KEEP_ENTRIES = 1000;
const MAX_PATHS = 20;

const short = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** The audit of the MCP endpoint, one JSON line per call in `mcp-audit.jsonl` of the data folder. The admin panel shows it, a page at a time. */
export class McpAudit {
  private readonly mutex = new KeyedMutex();
  private lastSeq: number | undefined;

  constructor(private readonly file: string, private readonly log: (line: string) => void = () => undefined) {}

  /** Every entry that can be read, oldest first, each with its number (an entry written before the numbers existed gets its place in the file). */
  private async readAll(): Promise<McpAuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const entries: McpAuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as McpAuditEntry;
        if (entry && typeof entry.tool === "string") entries.push({ ...entry, seq: Number.isSafeInteger(entry.seq) ? entry.seq : entries.length + 1 });
      } catch {
        // A line that was cut (a power failure in the middle of an append) is skipped.
      }
    }
    return entries;
  }

  /** Write one entry. It never fails the call it records: a log that cannot be written is told to the server's own log. */
  record(entry: Omit<McpAuditEntry, "seq">): Promise<void> {
    return this.mutex.run("audit", async () => {
      try {
        if (this.lastSeq === undefined) this.lastSeq = (await this.readAll()).reduce((highest, kept) => Math.max(highest, kept.seq ?? 0), 0);
        const size = await stat(this.file).then((info) => info.size, () => 0);
        if (size >= MAX_BYTES) {
          const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
          await atomicWrite(this.file, `${lines.slice(-KEEP_ENTRIES).join("\n")}\n`);
        }
        this.lastSeq += 1;
        const clean: McpAuditEntry = {
          seq: this.lastSeq,
          at: entry.at,
          bookId: short(entry.bookId, 120),
          client: short(entry.client, 80),
          clientId: short(entry.clientId, 80),
          tool: short(entry.tool, 60),
          ok: entry.ok,
          ...(entry.code ? { code: short(entry.code, 40) } : {}),
          ...(entry.paths?.length ? { paths: entry.paths.slice(0, MAX_PATHS).map((path) => short(path, 300)) } : {}),
          ...(entry.commit ? { commit: short(entry.commit, 64) } : {}),
        };
        await appendFile(this.file, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
      } catch (error) {
        this.log(`The MCP audit could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** The latest entries, newest first, of one book or of all. */
  recent(limit = 100, bookId?: string): Promise<McpAuditEntry[]> {
    return this.mutex.run("audit", async () => {
      const entries = (await this.readAll()).filter((entry) => bookId === undefined || entry.bookId === bookId);
      return limit > 0 ? entries.slice(-limit).reverse() : [];
    });
  }

  /**
   * A page of the audit, newest first: `limit` entries older than `before` (the number of the entry the last page ended at; none for the first page), of one book or of all. `nextBefore` is
   * what to ask for the next page, `null` when there is nothing older.
   */
  page(options: { limit: number; before?: number; bookId?: string }): Promise<{ entries: McpAuditEntry[]; nextBefore: number | null }> {
    return this.mutex.run("audit", async () => {
      const wanted = (await this.readAll()).filter((entry) => (options.bookId === undefined || entry.bookId === options.bookId) && (options.before === undefined || (entry.seq ?? 0) < options.before));
      const entries = options.limit > 0 ? wanted.slice(-options.limit).reverse() : [];
      return { entries, nextBefore: wanted.length > entries.length && entries.length ? entries[entries.length - 1].seq ?? null : null };
    });
  }

  /** Wait until what was recorded is written (the server closing). */
  flush(): Promise<void> {
    return this.mutex.run("audit", async () => undefined);
  }
}
