import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, GripVertical, MessageSquare, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BookStructure } from "@/types/book";
import { isContainer, makeNode, type NodeKind, type ScriptDoc, type ScriptNode } from "@/narrarium/script/model";
import { CreateCanonInlineDialog } from "@/components/script/CreateCanonInlineDialog";
import type { EntityKind } from "@/narrarium/canon";

type Ref = { id: string; label: string };

function slugsFrom(files: { path: string }[], prefix: string): Ref[] {
  return files.map((f) => {
    const slug = (f.path.split("/").pop() ?? "").replace(/\.md$/i, "");
    return { id: `${prefix}:${slug}`, label: slug.replace(/-/g, " ") };
  });
}

interface Catalog {
  characters: Ref[];
  locations: Ref[];
  items: Ref[];
  factions: Ref[];
  secrets: Ref[];
  timelines: Ref[];
  bookId: string | undefined;
}

export function ScriptEditor({ doc, structure, bookId, onChange }: { doc: ScriptDoc; structure: BookStructure | undefined; bookId: string | undefined; onChange: (next: ScriptDoc) => void }) {
  const { t } = useTranslation();
  const catalog: Catalog = {
    characters: useMemo(() => slugsFrom(structure?.characters ?? [], "character"), [structure]),
    locations: useMemo(() => slugsFrom(structure?.locations ?? [], "location"), [structure]),
    items: useMemo(() => slugsFrom(structure?.items ?? [], "item"), [structure]),
    factions: useMemo(() => slugsFrom(structure?.factions ?? [], "faction"), [structure]),
    secrets: useMemo(() => slugsFrom(structure?.secrets ?? [], "secret"), [structure]),
    timelines: useMemo(() => slugsFrom(structure?.timelines ?? [], "timeline-event"), [structure]),
    bookId,
  };

  function setNodes(nodes: ScriptNode[]) { onChange({ nodes }); }

  return (
    <div className="space-y-3">
      <NodeList
        nodes={doc.nodes}
        catalog={catalog}
        depth={0}
        onChange={setNodes}
      />
      <AddBlockMenu label={t("script.addBlock")} onAdd={(kind) => setNodes([...doc.nodes, makeNode(kind)])} wide />
    </div>
  );
}

function NodeList({ nodes, catalog, depth, onChange }: { nodes: ScriptNode[]; catalog: Catalog; depth: number; onChange: (nodes: ScriptNode[]) => void }) {
  const { t } = useTranslation();
  function update(id: string, next: ScriptNode) { onChange(nodes.map((n) => (n.id === id ? next : n))); }
  function remove(id: string) { onChange(nodes.filter((n) => n.id !== id)); }
  function move(id: string, dir: -1 | 1) {
    const i = nodes.findIndex((n) => n.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= nodes.length) return;
    const copy = [...nodes];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  }
  return (
    <div className="space-y-2">
      {nodes.map((node, idx) => (
        <NodeCard
          key={node.id}
          node={node}
          catalog={catalog}
          depth={depth}
          first={idx === 0}
          last={idx === nodes.length - 1}
          onUp={() => move(node.id, -1)}
          onDown={() => move(node.id, 1)}
          onRemove={() => remove(node.id)}
          onChange={(next) => update(node.id, next)}
        />
      ))}
      {nodes.length === 0 && depth === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("script.empty")}</p>
      )}
    </div>
  );
}

function NodeCard({
  node, catalog, depth, first, last, onUp, onDown, onRemove, onChange,
}: {
  node: ScriptNode;
  catalog: Catalog;
  depth: number;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onChange: (next: ScriptNode) => void;
}) {
  const { t } = useTranslation();
  const container = isContainer(node.kind);
  const setAttr = (key: string, value: string | undefined) => {
    const attrs = { ...node.attrs };
    if (value && value !== "__none__") attrs[key] = value;
    else delete attrs[key];
    onChange({ ...node, attrs });
  };

  return (
    <div className={container ? "rounded-xl border bg-muted/20 p-3" : "rounded-lg border bg-card p-2.5"}>
      <div className="mb-2 flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground/40" />
        <span className={container ? "rounded bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary" : "rounded bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"}>{t(`script.type.${node.kind}`)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={first} onClick={onUp}><ChevronUp className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={last} onClick={onDown}><ChevronDown className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>

      <NodeHeader node={node} catalog={catalog} setAttr={setAttr} />
      {!container && <PrimitiveBody node={node} catalog={catalog} setAttr={setAttr} onChange={onChange} />}

      {container && (
        <div className="mt-3 space-y-2 border-l-2 border-primary/20 pl-3">
          <NodeList
            nodes={node.children ?? []}
            catalog={catalog}
            depth={depth + 1}
            onChange={(children) => onChange({ ...node, children })}
          />
          <AddBlockMenu
            label={t("script.addInside")}
            onAdd={(kind) => onChange({ ...node, children: [...(node.children ?? []), makeNode(kind)] })}
          />
        </div>
      )}
    </div>
  );
}

function RefSelect({ value, options, placeholder, onChange, bookId, createKind, onCreated }: {
  value: string | undefined;
  options: Ref[];
  placeholder: string;
  onChange: (v: string | undefined) => void;
  bookId: string | undefined;
  createKind?: EntityKind;
  onCreated?: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? undefined : v)}>
        <SelectTrigger className="h-8 flex-1 text-sm"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t("script.none")}</SelectItem>
          {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {createKind && <CreateCanonInlineDialog bookId={bookId} kind={createKind} onCreated={(id) => onCreated?.(id)} />}
    </div>
  );
}

function NodeHeader({ node, catalog, setAttr }: { node: ScriptNode; catalog: Catalog; setAttr: (k: string, v: string | undefined) => void }) {
  const { t } = useTranslation();

  switch (node.kind) {
    case "section":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={node.attrs.title ?? ""} onChange={(e) => setAttr("title", e.target.value)} placeholder={t("script.sectionTitle")} className="h-8 text-sm sm:col-span-2" />
          <Input value={node.attrs.goal ?? ""} onChange={(e) => setAttr("goal", e.target.value)} placeholder={t("script.sceneGoal")} className="h-8 text-sm sm:col-span-2" />
          <RefSelect value={node.attrs.pov} options={catalog.characters} placeholder={t("script.pov")} onChange={(v) => setAttr("pov", v)} bookId={catalog.bookId} createKind="character" onCreated={(id) => setAttr("pov", id)} />
          <RefSelect value={node.attrs.location} options={catalog.locations} placeholder={t("script.sceneLocation")} onChange={(v) => setAttr("location", v)} bookId={catalog.bookId} createKind="location" onCreated={(id) => setAttr("location", id)} />
        </div>
      );
    case "dialogue":
      return <RefSelect value={node.attrs.speaker} options={catalog.characters} placeholder={t("script.speaker")} onChange={(v) => setAttr("speaker", v)} bookId={catalog.bookId} createKind="character" onCreated={(id) => setAttr("speaker", id)} />;
    case "secret": {
      const modes = ["protect", "seed", "partial", "misdirect", "reveal"] as const;
      return (
        <div className="space-y-2">
          <RefSelect value={node.attrs.ref} options={catalog.secrets} placeholder={t("script.secret")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="secret" onCreated={(id) => setAttr("ref", id)} />
          <Select value={node.attrs.mode || "seed"} onValueChange={(v) => setAttr("mode", v)}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{modes.map((m) => <SelectItem key={m} value={m}>{t(`script.secretModes.${m}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      );
    }
    case "location":
      return <RefSelect value={node.attrs.ref} options={catalog.locations} placeholder={t("script.location")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="location" onCreated={(id) => setAttr("ref", id)} />;
    case "character":
      return <RefSelect value={node.attrs.ref} options={catalog.characters} placeholder={t("script.character")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="character" onCreated={(id) => setAttr("ref", id)} />;
    case "item":
      return <RefSelect value={node.attrs.ref} options={catalog.items} placeholder={t("script.item")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="item" onCreated={(id) => setAttr("ref", id)} />;
    case "faction":
      return <RefSelect value={node.attrs.ref} options={catalog.factions} placeholder={t("script.faction")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="faction" onCreated={(id) => setAttr("ref", id)} />;
    case "timeline":
      return (
        <div className="space-y-2">
          <RefSelect value={node.attrs.ref} options={catalog.timelines} placeholder={t("script.timelineEvent")} onChange={(v) => setAttr("ref", v)} bookId={catalog.bookId} createKind="timeline-event" onCreated={(id) => setAttr("ref", id)} />
          <Input value={node.attrs.date ?? ""} onChange={(e) => setAttr("date", e.target.value)} placeholder={t("script.date")} className="h-8 text-sm" />
        </div>
      );
    default:
      return null; // primitives handled below
  }
}

function PrimitiveBody({ node, catalog, setAttr, onChange }: { node: ScriptNode; catalog: Catalog; setAttr: (k: string, v: string | undefined) => void; onChange: (next: ScriptNode) => void }) {
  const { t } = useTranslation();
  const setText = (v: string) => onChange({ ...node, text: v });

  if (node.kind === "line") {
    return (
      <div className="space-y-1">
        <RefSelect value={node.attrs.speaker} options={catalog.characters} placeholder={t("script.speaker")} onChange={(v) => setAttr("speaker", v)} bookId={catalog.bookId} createKind="character" onCreated={(id) => setAttr("speaker", id)} />
        <AutoTextarea value={node.text ?? ""} onChange={(e) => setText(e.target.value)} placeholder={t("script.linePlaceholder")} className="text-sm" minRows={1} />
        <div className="grid gap-1 sm:grid-cols-2">
          <Input value={node.attrs.subtext ?? ""} onChange={(e) => setAttr("subtext", e.target.value)} placeholder={t("script.subtext")} className="h-7 text-xs" />
          <Input value={node.attrs.delivery ?? ""} onChange={(e) => setAttr("delivery", e.target.value)} placeholder={t("script.delivery")} className="h-7 text-xs" />
        </div>
      </div>
    );
  }

  const placeholder = node.kind === "action" ? t("script.actionPlaceholder") : node.kind === "emotion" ? t("script.emotionPlaceholder") : t("script.tellPlaceholder");
  return <AutoTextarea value={node.text ?? ""} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="text-sm" minRows={1} />;
}

function AddBlockMenu({ label, onAdd, wide }: { label: string; onAdd: (kind: NodeKind) => void; wide?: boolean }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={wide ? "w-full justify-center gap-2" : "gap-2"} variant="outline" size={wide ? "default" : "sm"}>
          <Plus className="h-4 w-4" />{label}<ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <DropdownMenuLabel className="text-xs">{t("script.containers")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAdd("section")}>{t("script.type.section")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("dialogue")}><MessageSquare className="mr-2 h-4 w-4" />{t("script.type.dialogue")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("secret")}>{t("script.type.secret")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">{t("script.canon")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAdd("location")}>{t("script.type.location")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("character")}>{t("script.type.character")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("item")}>{t("script.type.item")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("faction")}>{t("script.type.faction")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("timeline")}>{t("script.type.timeline")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">{t("script.primitives")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAdd("line")}>{t("script.type.line")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("action")}>{t("script.type.action")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("emotion")}>{t("script.type.emotion")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("tell")}>{t("script.type.tell")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
