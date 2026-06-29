// Narrarium visual script — nested block tree.
// Syntax: `{ ... }` are CONTAINERS (can nest other blocks), `[ ... ]` are PRIMITIVES (leaves).
// A container opens with `{<kind> attr=value attr="quoted">` ... and closes with a `}` on its own line.
// A primitive is `[<kind> attr=value]` optionally followed by free text on the same line.

import { nanoid } from "@/narrarium/script/id";

export const CONTAINER_KINDS = ["section", "dialogue", "secret", "location", "character", "item", "faction", "timeline"] as const;
export const PRIMITIVE_KINDS = ["tell", "action", "emotion", "line"] as const;

export type ContainerKind = (typeof CONTAINER_KINDS)[number];
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];
export type NodeKind = ContainerKind | PrimitiveKind;

export interface ScriptNode {
  id: string;
  kind: NodeKind;
  attrs: Record<string, string>;
  text?: string;
  children?: ScriptNode[];
}

export interface ScriptDoc {
  nodes: ScriptNode[];
}

export function isContainer(kind: NodeKind): kind is ContainerKind {
  return (CONTAINER_KINDS as readonly string[]).includes(kind);
}

export function emptyScriptDoc(): ScriptDoc {
  return { nodes: [] };
}

export function makeNode(kind: NodeKind, attrs: Record<string, string> = {}, text = ""): ScriptNode {
  return isContainer(kind)
    ? { id: nanoid(), kind, attrs, children: [] }
    : { id: nanoid(), kind, attrs, text };
}

// ─── Serialize ────────────────────────────────────────────────────────────────

function serializeAttrs(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === "") continue;
    const needsQuote = /[\s"=]/.test(value);
    parts.push(`${key}=${needsQuote ? `"${value.replace(/"/g, "'")}"` : value}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function serializeNode(node: ScriptNode, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (isContainer(node.kind)) {
    const head = `${pad}{${node.kind}${serializeAttrs(node.attrs)}`;
    const lines = [head];
    for (const child of node.children ?? []) lines.push(...serializeNode(child, indent + 1));
    lines.push(`${pad}}`);
    return lines;
  }
  const text = (node.text ?? "").replace(/\r?\n/g, " ").trim();
  return [`${pad}[${node.kind}${serializeAttrs(node.attrs)}]${text ? " " + text : ""}`];
}

export function serializeScript(doc: ScriptDoc): string {
  return doc.nodes.flatMap((node) => serializeNode(node, 0)).join("\n") + "\n";
}

// ─── Parse (tolerant) ─────────────────────────────────────────────────────────

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return attrs;
}

function asKind(value: string, list: readonly string[], fallback: string): string {
  return list.includes(value) ? value : fallback;
}

export function parseScript(body: string): ScriptDoc {
  try {
    const root: ScriptNode = { id: "root", kind: "section", attrs: {}, children: [] };
    const stack: ScriptNode[] = [root];

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      // Close container
      if (line === "}" || line === "{/section}" || /^\{\/[a-z]+\}$/i.test(line)) {
        if (stack.length > 1) stack.pop();
        continue;
      }

      // Open container: {kind attrs   (optionally ending with } for empty)
      if (line.startsWith("{")) {
        const inner = line.replace(/^\{/, "").replace(/\}\s*$/, "").trim();
        const kindToken = inner.split(/\s+/)[0] ?? "section";
        const kind = asKind(kindToken, CONTAINER_KINDS, "section") as ContainerKind;
        const attrs = parseAttrs(inner.slice(kindToken.length));
        const node: ScriptNode = { id: nanoid(), kind, attrs, children: [] };
        stack[stack.length - 1].children!.push(node);
        if (!/\}\s*$/.test(line)) stack.push(node); // not self-closed
        continue;
      }

      // Primitive: [kind attrs] text
      const primMatch = line.match(/^\[([a-zA-Z_][\w-]*)([^\]]*)\]\s*(.*)$/);
      if (primMatch) {
        const kind = asKind(primMatch[1].toLowerCase(), PRIMITIVE_KINDS, "tell") as PrimitiveKind;
        const attrs = parseAttrs(primMatch[2] ?? "");
        const text = (primMatch[3] ?? "").trim();
        stack[stack.length - 1].children!.push({ id: nanoid(), kind, attrs, text });
        continue;
      }

      // Bare line → tell primitive
      stack[stack.length - 1].children!.push({ id: nanoid(), kind: "tell", attrs: {}, text: line });
    }

    return { nodes: root.children ?? [] };
  } catch {
    return emptyScriptDoc();
  }
}
