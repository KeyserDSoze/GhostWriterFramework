export interface LiveVoiceSource {
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  sourceHash: string;
  sourceContent: string;
}

export interface PendingLiveVoiceRewrite {
  sessionId: string;
  pathname: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  sourceHash: string;
  sourceContent: string;
  nextContent: string;
  from: number;
  to: number;
  segments: string[];
}

export interface LiveVoiceRewriteContext {
  sessionId: string;
  pathname: string;
  bookId: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  sourceHash: string;
}

export interface LiveVoiceRewriteSnapshot extends LiveVoiceRewriteContext {
  sourceContent: string;
  original: string;
  from: number;
  to: number;
}

function passagePattern(passage: string): RegExp {
  const escaped = passage.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, "\\s+"), "g");
}

export function replaceUniqueSpokenPassage(sourceContent: string, passage: string, replacement: string): string | null {
  const matches = [...sourceContent.matchAll(passagePattern(passage))];
  if (matches.length !== 1 || matches[0].index === undefined) return null;
  const match = matches[0];
  return `${sourceContent.slice(0, match.index)}${replacement.trim()}${sourceContent.slice(match.index + match[0].length)}`;
}

export function captureLiveVoiceRewriteSnapshot(input: {
  active: LiveVoiceRewriteContext | null;
  sources: Array<LiveVoiceSource | null>;
  from: number;
  to: number;
  original: string;
}): LiveVoiceRewriteSnapshot | null {
  const selected = input.sources.slice(input.from, input.to + 1);
  const source = selected[0];
  if (!input.active || !source || selected.length !== input.to - input.from + 1) return null;
  if (selected.some((entry) => !entry
    || entry.bookId !== source.bookId
    || entry.owner !== source.owner
    || entry.repo !== source.repo
    || entry.branch !== source.branch
    || entry.path !== source.path
    || entry.sourceHash !== source.sourceHash)) return null;
  const sourceContext = { ...source, sessionId: input.active.sessionId, pathname: input.active.pathname };
  if (!liveVoiceRewriteMatches(sourceContext, input.active)) return null;
  return {
    ...input.active,
    sourceContent: source.sourceContent,
    from: input.from,
    to: input.to,
    original: input.original,
  };
}

export async function generateLiveVoiceRewrite(input: {
  snapshot: LiveVoiceRewriteSnapshot;
  generate: () => Promise<string>;
  getActiveContext: () => LiveVoiceRewriteContext | null;
  split: (text: string) => string[];
}): Promise<{ rewritten: string; pending: PendingLiveVoiceRewrite } | null> {
  const rewritten = (await input.generate()).trim();
  const active = input.getActiveContext();
  if (!rewritten || !active || !liveVoiceRewriteMatches(input.snapshot, active)) return null;
  const nextContent = replaceUniqueSpokenPassage(input.snapshot.sourceContent, input.snapshot.original, rewritten);
  if (nextContent === null) return null;
  return {
    rewritten,
    pending: {
      sessionId: input.snapshot.sessionId,
      pathname: input.snapshot.pathname,
      bookId: input.snapshot.bookId,
      owner: input.snapshot.owner,
      repo: input.snapshot.repo,
      branch: input.snapshot.branch,
      path: input.snapshot.path,
      sourceHash: input.snapshot.sourceHash,
      sourceContent: input.snapshot.sourceContent,
      nextContent,
      from: input.snapshot.from,
      to: input.snapshot.to,
      segments: input.split(rewritten),
    },
  };
}

export function liveVoiceRewriteMatches(expected: LiveVoiceRewriteContext, current: LiveVoiceRewriteContext): boolean {
  return expected.sessionId === current.sessionId
    && expected.pathname === current.pathname
    && expected.bookId === current.bookId
    && expected.owner === current.owner
    && expected.repo === current.repo
    && expected.branch === current.branch
    && expected.path === current.path
    && expected.sourceHash === current.sourceHash;
}

export function resolveLiveVoiceRewrite(
  pending: PendingLiveVoiceRewrite | null,
  event: "reject" | "interrupt" | "source-switch" | "accept",
  current?: LiveVoiceRewriteContext,
): { pending: PendingLiveVoiceRewrite | null; content?: string; conflict?: boolean } {
  if (!pending || event !== "accept") return { pending: null };
  if (!current || !liveVoiceRewriteMatches(pending, current)) return { pending: null, conflict: true };
  return { pending: null, content: pending.nextContent };
}

export async function persistLiveVoiceRewrite<T>(input: {
  pending: PendingLiveVoiceRewrite;
  getActiveContext: () => LiveVoiceRewriteContext | null;
  signal: AbortSignal;
  readSource: (signal: AbortSignal) => Promise<string>;
  hashText: (text: string) => Promise<string>;
  preparePersistence: (signal: AbortSignal) => Promise<T>;
  persist: (prepared: T, content: string, expectedSourceHash: string, signal: AbortSignal) => Promise<void>;
}): Promise<{ status: "applied"; content: string } | { status: "conflict" }> {
  const matchesActiveContext = () => {
    const active = input.getActiveContext();
    return Boolean(active && liveVoiceRewriteMatches(input.pending, active));
  };
  input.signal.throwIfAborted();
  if (!matchesActiveContext()) return { status: "conflict" };
  const currentContent = await input.readSource(input.signal);
  input.signal.throwIfAborted();
  if (await input.hashText(currentContent) !== input.pending.sourceHash || !matchesActiveContext()) return { status: "conflict" };
  const prepared = await input.preparePersistence(input.signal);
  input.signal.throwIfAborted();
  if (!matchesActiveContext()) return { status: "conflict" };
  await input.persist(prepared, input.pending.nextContent, input.pending.sourceHash, input.signal);
  input.signal.throwIfAborted();
  return { status: "applied", content: input.pending.nextContent };
}
