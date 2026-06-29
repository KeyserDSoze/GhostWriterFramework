// Nested visual script model that serializes to the Narrarium script meta-language.
// The on-disk format stays line-oriented and MCP-parsable; nested dialogue groups
// are delimited with `# >>>dialogue` / `# <<<dialogue` comments that the MCP parser ignores.

import { nanoid } from "@/narrarium/script/id";

export type InnerBlock =
  | { id: string; type: "line"; speaker?: string; characterRef?: string; text: string; subtext?: string; delivery?: string }
  | { id: string; type: "action"; text: string }
  | { id: string; type: "emotion"; text: string };

export type ScriptSecretMode = "protect" | "seed" | "partial" | "misdirect" | "reveal";

export type ScriptBlock =
  | { id: string; type: "tell"; text: string }
  | { id: string; type: "action"; text: string }
  | { id: string; type: "emotion"; text: string }
  | { id: string; type: "line"; speaker?: string; characterRef?: string; text: string; subtext?: string; delivery?: string }
  | { id: string; type: "dialogue"; speaker?: string; characterRef?: string; children: InnerBlock[] }
  | { id: string; type: "location"; text: string; locationRef?: string }
  | { id: string; type: "character"; text: string; characterRef?: string }
  | { id: string; type: "item"; text: string; itemRef?: string }
  | { id: string; type: "faction"; text: string; factionRef?: string }
  | { id: string; type: "timeline"; text: string; date?: string; timelineRef?: string }
  | { id: string; type: "secret"; secretRef?: string; mode: ScriptSecretMode; readerSurface?: string; writerTruth?: string; reveal?: string }
  | { id: string; type: "command"; raw: string };

export interface ScriptDoc {
  sceneGoal?: string;
  pov?: string;
  povRef?: string;
  location?: string;
  locationRef?: string;
  blocks: ScriptBlock[];
}

export function emptyScriptDoc(): ScriptDoc {
  return { blocks: [] };
}

// ─── Serialize ────────────────────────────────────────────────────────────────

function escapeInline(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

function serializeLine(block: Extract<InnerBlock, { type: "line" }> | Extract<ScriptBlock, { type: "line" }>): string {
  const notes: string[] = [];
  if (block.subtext) notes.push(`subtext: ${escapeInline(block.subtext)}`);
  if (block.delivery) notes.push(`delivery: ${escapeInline(block.delivery)}`);
  const speaker = block.speaker ? `${escapeInline(block.speaker)}: ` : "";
  const base = `«${speaker}${escapeInline(block.text)}»`;
  return notes.length ? `${base} [${notes.join("; ")}]` : base;
}

export function serializeScript(doc: ScriptDoc): string {
  const lines: string[] = [];
  if (doc.sceneGoal) lines.push(`@scene_goal{${escapeInline(doc.sceneGoal)}}`);
  if (doc.pov) lines.push(`@pov{${escapeInline(doc.povRef || doc.pov)}}`);
  if (doc.location) lines.push(`Location: ${escapeInline(doc.location)}`);
  if (doc.locationRef) lines.push(`@location{${escapeInline(doc.locationRef)}}`);

  for (const block of doc.blocks) {
    switch (block.type) {
      case "tell":
        lines.push(`[${escapeInline(block.text)}]`);
        break;
      case "action":
        lines.push(`(${escapeInline(block.text)})`);
        break;
      case "emotion":
        lines.push(`{${escapeInline(block.text)}}`);
        break;
      case "line":
        lines.push(serializeLine(block));
        break;
      case "location":
        lines.push(`Location: ${escapeInline(block.text)}`);
        if (block.locationRef) lines.push(`@location{${escapeInline(block.locationRef)}}`);
        break;
      case "character":
        if (block.characterRef) lines.push(`@pov{${escapeInline(block.characterRef)}}`);
        if (block.text) lines.push(`{${escapeInline(block.text)}}`);
        break;
      case "item":
        if (block.itemRef) lines.push(`# item: ${escapeInline(block.itemRef)}`);
        if (block.text) lines.push(`[${escapeInline(block.text)}]`);
        break;
      case "faction":
        if (block.factionRef) lines.push(`# faction: ${escapeInline(block.factionRef)}`);
        if (block.text) lines.push(`[${escapeInline(block.text)}]`);
        break;
      case "timeline":
        lines.push(`@track{${[block.timelineRef, block.date, block.text].filter((v): v is string => Boolean(v)).map(escapeInline).join(" | ")}}`);
        break;
      case "secret": {
        const ref = block.secretRef ? `${escapeInline(block.secretRef)} ` : "";
        lines.push(`@secret{${ref}mode=${block.mode}}`);
        if (block.writerTruth) lines.push(`@writer_truth{${escapeInline(block.writerTruth)}}`);
        if (block.readerSurface) lines.push(`@reader_surface{${escapeInline(block.readerSurface)}}`);
        if (block.reveal) lines.push(`@reveal{${escapeInline(block.reveal)}}`);
        lines.push(`@end_secret{}`);
        break;
      }
      case "command":
        lines.push(block.raw.trim());
        break;
      case "dialogue": {
        const header = block.characterRef ? ` ${block.characterRef}` : block.speaker ? ` ${block.speaker}` : "";
        lines.push(`# >>>dialogue${header}`);
        for (const child of block.children) {
          if (child.type === "line") lines.push(serializeLine({ ...child, speaker: child.speaker ?? block.speaker }));
          else if (child.type === "action") lines.push(`(${escapeInline(child.text)})`);
          else lines.push(`{${escapeInline(child.text)}}`);
        }
        lines.push(`# <<<dialogue`);
        break;
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ─── Parse (tolerant) ─────────────────────────────────────────────────────────

function parseLineBeat(raw: string): { text: string; speaker?: string; subtext?: string; delivery?: string } {
  const m = raw.match(/^«([\s\S]*?)»(?:\s*\[(.*)\])?\s*$/u);
  if (!m) return { text: raw.replace(/^«|»$/gu, "").trim() };
  let inner = m[1].trim();
  let speaker: string | undefined;
  const sp = inner.match(/^([^:]{1,40}):\s+(.*)$/);
  if (sp) {
    speaker = sp[1].trim();
    inner = sp[2].trim();
  }
  const notes = m[2] ?? "";
  const subtext = notes.match(/subtext:\s*([^;]+)/i)?.[1]?.trim();
  const delivery = notes.match(/delivery:\s*([^;]+)/i)?.[1]?.trim();
  return { text: inner, speaker, subtext, delivery };
}

export function parseScript(body: string): ScriptDoc {
  try {
    const doc: ScriptDoc = { blocks: [] };
    const lines = body.split(/\r?\n/);
    let dialogue: Extract<ScriptBlock, { type: "dialogue" }> | null = null;
    let secret: Extract<ScriptBlock, { type: "secret" }> | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const dialogOpen = line.match(/^#\s*>>>dialogue\s*(.*)$/i);
      if (dialogOpen) {
        const tag = dialogOpen[1].trim();
        dialogue = { id: nanoid(), type: "dialogue", children: [] };
        if (tag.startsWith("character:")) dialogue.characterRef = tag;
        else if (tag) dialogue.speaker = tag;
        doc.blocks.push(dialogue);
        continue;
      }
      if (/^#\s*<<<dialogue/i.test(line)) {
        dialogue = null;
        continue;
      }

      const itemRefComment = line.match(/^#\s*item:\s*(.+)$/i);
      if (itemRefComment) { doc.blocks.push({ id: nanoid(), type: "item", text: "", itemRef: itemRefComment[1].trim() }); continue; }
      const factionRefComment = line.match(/^#\s*faction:\s*(.+)$/i);
      if (factionRefComment) { doc.blocks.push({ id: nanoid(), type: "faction", text: "", factionRef: factionRefComment[1].trim() }); continue; }

      if (line.startsWith("@secret{")) {
        const inner = line.slice(8, -1).trim();
        const refMatch = inner.match(/(secret:[a-z0-9-]+)/i);
        const modeMatch = inner.match(/mode=([a-z]+)/i);
        const modes: ScriptSecretMode[] = ["protect", "seed", "partial", "misdirect", "reveal"];
        const mode = (modes as string[]).includes(modeMatch?.[1] ?? "") ? (modeMatch![1] as ScriptSecretMode) : "protect";
        secret = { id: nanoid(), type: "secret", secretRef: refMatch?.[1], mode };
        doc.blocks.push(secret);
        continue;
      }
      if (line.startsWith("@end_secret")) { secret = null; continue; }
      if (secret && line.startsWith("@writer_truth{")) { secret.writerTruth = line.slice(14, -1).trim(); continue; }
      if (secret && line.startsWith("@reader_surface{")) { secret.readerSurface = line.slice(16, -1).trim(); continue; }
      if (secret && line.startsWith("@reveal{")) { secret.reveal = line.slice(8, -1).trim(); continue; }

      if (line.startsWith("@scene_goal{")) { doc.sceneGoal = line.slice(12, -1).trim(); continue; }
      if (line.startsWith("@pov{")) {
        const v = line.slice(5, -1).trim();
        if (dialogue && !dialogue.characterRef) dialogue.characterRef = v;
        else { doc.pov = v; if (v.startsWith("character:")) doc.povRef = v; }
        continue;
      }
      if (/^location:/i.test(line)) { doc.blocks.push({ id: nanoid(), type: "location", text: line.replace(/^location:/i, "").trim() }); continue; }
      if (line.startsWith("@location{")) {
        const ref = line.slice(10, -1).trim();
        const last = [...doc.blocks].reverse().find((b) => b.type === "location") as Extract<ScriptBlock, { type: "location" }> | undefined;
        if (last) last.locationRef = ref;
        else doc.blocks.push({ id: nanoid(), type: "location", text: ref, locationRef: ref });
        continue;
      }
      if (line.startsWith("@track{")) {
        const parts = line.slice(7, -1).split("|").map((p) => p.trim());
        const ref = parts.find((p) => p.startsWith("timeline-event:") || p.startsWith("timeline:") || p.startsWith("event:"));
        const date = parts.find((p) => /\d/.test(p) && p !== ref);
        const text = parts.filter((p) => p !== ref && p !== date).join(" ");
        doc.blocks.push({ id: nanoid(), type: "timeline", text, date, timelineRef: ref });
        continue;
      }

      if (line.startsWith("«")) {
        const parsed = parseLineBeat(line);
        if (dialogue) dialogue.children.push({ id: nanoid(), type: "line", ...parsed });
        else doc.blocks.push({ id: nanoid(), type: "line", ...parsed });
        continue;
      }
      if (line.startsWith("(") && line.endsWith(")")) {
        const text = line.slice(1, -1).trim();
        if (dialogue) dialogue.children.push({ id: nanoid(), type: "action", text });
        else doc.blocks.push({ id: nanoid(), type: "action", text });
        continue;
      }
      if (line.startsWith("{") && line.endsWith("}")) {
        const text = line.slice(1, -1).trim();
        if (dialogue) dialogue.children.push({ id: nanoid(), type: "emotion", text });
        else doc.blocks.push({ id: nanoid(), type: "emotion", text });
        continue;
      }
      if (line.startsWith("[") && line.endsWith("]")) { doc.blocks.push({ id: nanoid(), type: "tell", text: line.slice(1, -1).trim() }); continue; }
      if (line.startsWith("#")) continue; // free comment
      if (line.startsWith("@")) { doc.blocks.push({ id: nanoid(), type: "command", raw: line }); continue; }
      // Fallback: treat as tell beat
      doc.blocks.push({ id: nanoid(), type: "tell", text: line });
    }
    return doc;
  } catch {
    return emptyScriptDoc();
  }
}
