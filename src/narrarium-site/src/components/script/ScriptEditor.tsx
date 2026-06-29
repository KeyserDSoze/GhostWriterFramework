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
import { nanoid } from "@/narrarium/script/id";
import type { InnerBlock, ScriptBlock, ScriptDoc } from "@/narrarium/script/model";

function slugsFrom(files: { path: string }[], prefix: string): { id: string; label: string }[] {
  return files.map((f) => {
    const slug = (f.path.split("/").pop() ?? "").replace(/\.md$/i, "");
    return { id: `${prefix}:${slug}`, label: slug.replace(/-/g, " ") };
  });
}

export function ScriptEditor({ doc, structure, onChange }: { doc: ScriptDoc; structure: BookStructure | undefined; onChange: (next: ScriptDoc) => void }) {
  const { t } = useTranslation();
  const characters = useMemo(() => slugsFrom(structure?.characters ?? [], "character"), [structure]);
  const locations = useMemo(() => slugsFrom(structure?.locations ?? [], "location"), [structure]);
  const timelines = useMemo(() => slugsFrom(structure?.timelines ?? [], "event"), [structure]);

  function patch(p: Partial<ScriptDoc>) { onChange({ ...doc, ...p }); }
  function setBlocks(blocks: ScriptBlock[]) { onChange({ ...doc, blocks }); }

  function addBlock(block: ScriptBlock) { setBlocks([...doc.blocks, block]); }
  function updateBlock(id: string, next: Partial<ScriptBlock>) {
    setBlocks(doc.blocks.map((b) => (b.id === id ? ({ ...b, ...next } as ScriptBlock) : b)));
  }
  function removeBlock(id: string) { setBlocks(doc.blocks.filter((b) => b.id !== id)); }
  function move(id: string, dir: -1 | 1) {
    const i = doc.blocks.findIndex((b) => b.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= doc.blocks.length) return;
    const next = [...doc.blocks];
    [next[i], next[j]] = [next[j], next[i]];
    setBlocks(next);
  }

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="w-full justify-center gap-2" variant="outline"><Plus className="h-4 w-4" />{t("script.addBlock")}<ChevronDown className="h-4 w-4 opacity-60" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64">
        <DropdownMenuLabel className="text-xs">{t("script.beats")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "dialogue", children: [{ id: nanoid(), type: "line", text: "" }] })}><MessageSquare className="mr-2 h-4 w-4" />{t("script.dialogue")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "line", text: "" })}>{t("script.singleLine")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "action", text: "" })}>{t("script.action")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "emotion", text: "" })}>{t("script.emotion")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "tell", text: "" })}>{t("script.tell")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">{t("script.canon")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "location", text: "" })}>{t("script.location")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "character", text: "" })}>{t("script.character")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "timeline", text: "" })}>{t("script.timeline")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => addBlock({ id: nanoid(), type: "command", raw: "@scene_goal{}" })}>{t("script.rawCommand")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-muted/20 p-3 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{t("script.scene")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("script.sceneGoal")}</label>
            <Input value={doc.sceneGoal ?? ""} onChange={(e) => patch({ sceneGoal: e.target.value })} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("script.pov")}</label>
            <Select value={doc.povRef || "__none__"} onValueChange={(v) => patch({ pov: v === "__none__" ? undefined : v, povRef: v === "__none__" ? undefined : v })}>
              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder={t("script.none")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("script.none")}</SelectItem>
                {characters.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs text-muted-foreground">{t("script.sceneLocation")}</label>
            <div className="flex gap-2">
              <Input value={doc.location ?? ""} onChange={(e) => patch({ location: e.target.value })} placeholder={t("script.locationPlaceholder")} className="h-8 flex-1 text-sm" />
              <Select value={doc.locationRef || "__none__"} onValueChange={(v) => patch({ locationRef: v === "__none__" ? undefined : v })}>
                <SelectTrigger className="h-8 w-40 text-sm"><SelectValue placeholder={t("script.link")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("script.none")}</SelectItem>
                  {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {doc.blocks.map((block, idx) => (
          <BlockCard
            key={block.id}
            block={block}
            first={idx === 0}
            last={idx === doc.blocks.length - 1}
            characters={characters}
            locations={locations}
            timelines={timelines}
            onUp={() => move(block.id, -1)}
            onDown={() => move(block.id, 1)}
            onRemove={() => removeBlock(block.id)}
            onChange={(next) => updateBlock(block.id, next)}
          />
        ))}
        {doc.blocks.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("script.empty")}</p>}
      </div>

      {addMenu}
    </div>
  );
}

function BlockCard({
  block, first, last, characters, locations, timelines, onUp, onDown, onRemove, onChange,
}: {
  block: ScriptBlock;
  first: boolean;
  last: boolean;
  characters: { id: string; label: string }[];
  locations: { id: string; label: string }[];
  timelines: { id: string; label: string }[];
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onChange: (next: Partial<ScriptBlock>) => void;
}) {
  const { t } = useTranslation();
  const label = t(`script.type.${block.type}`);

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <GripVertical className="h-4 w-4 text-muted-foreground/50" />
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={first} onClick={onUp}><ChevronUp className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={last} onClick={onDown}><ChevronDown className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      <BlockBody block={block} characters={characters} locations={locations} timelines={timelines} onChange={onChange} />
    </div>
  );
}

function BlockBody({
  block, characters, locations, timelines, onChange,
}: {
  block: ScriptBlock;
  characters: { id: string; label: string }[];
  locations: { id: string; label: string }[];
  timelines: { id: string; label: string }[];
  onChange: (next: Partial<ScriptBlock>) => void;
}) {
  const { t } = useTranslation();

  if (block.type === "dialogue") {
    const dlg = block;
    function setChildren(children: InnerBlock[]) { onChange({ children } as Partial<ScriptBlock>); }
    function addChild(child: InnerBlock) { setChildren([...dlg.children, child]); }
    function updateChild(id: string, next: Partial<InnerBlock>) { setChildren(dlg.children.map((c) => (c.id === id ? ({ ...c, ...next } as InnerBlock) : c))); }
    function removeChild(id: string) { setChildren(dlg.children.filter((c) => c.id !== id)); }
    return (
      <div className="space-y-2">
        <Select value={dlg.characterRef || "__none__"} onValueChange={(v) => onChange({ characterRef: v === "__none__" ? undefined : v } as Partial<ScriptBlock>)}>
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder={t("script.speaker")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("script.speakerNone")}</SelectItem>
            {characters.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="space-y-2 border-l-2 border-primary/30 pl-3">
          {dlg.children.map((child) => (
            <div key={child.id} className="rounded-lg border bg-background p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[10px] uppercase text-muted-foreground">{t(`script.type.${child.type}`)}</span>
                <Button variant="ghost" size="icon" className="ml-auto h-6 w-6 text-destructive" onClick={() => removeChild(child.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              {child.type === "line" ? (
                <div className="space-y-1">
                  <AutoTextarea value={child.text} onChange={(e) => updateChild(child.id, { text: e.target.value })} placeholder={t("script.linePlaceholder")} className="text-sm" minRows={1} />
                  <div className="grid gap-1 sm:grid-cols-2">
                    <Input value={child.subtext ?? ""} onChange={(e) => updateChild(child.id, { subtext: e.target.value })} placeholder={t("script.subtext")} className="h-7 text-xs" />
                    <Input value={child.delivery ?? ""} onChange={(e) => updateChild(child.id, { delivery: e.target.value })} placeholder={t("script.delivery")} className="h-7 text-xs" />
                  </div>
                </div>
              ) : (
                <AutoTextarea value={child.text} onChange={(e) => updateChild(child.id, { text: e.target.value })} placeholder={child.type === "action" ? t("script.actionPlaceholder") : t("script.emotionPlaceholder")} className="text-sm" minRows={1} />
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addChild({ id: nanoid(), type: "line", text: "" })}>+ {t("script.line")}</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addChild({ id: nanoid(), type: "action", text: "" })}>+ {t("script.action")}</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addChild({ id: nanoid(), type: "emotion", text: "" })}>+ {t("script.emotion")}</Button>
          </div>
        </div>
      </div>
    );
  }

  if (block.type === "line") {
    return (
      <div className="space-y-1">
        <Select value={block.characterRef || "__none__"} onValueChange={(v) => onChange({ characterRef: v === "__none__" ? undefined : v } as Partial<ScriptBlock>)}>
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder={t("script.speaker")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("script.speakerNone")}</SelectItem>
            {characters.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <AutoTextarea value={block.text} onChange={(e) => onChange({ text: e.target.value } as Partial<ScriptBlock>)} placeholder={t("script.linePlaceholder")} className="text-sm" minRows={1} />
      </div>
    );
  }

  if (block.type === "location") {
    return (
      <div className="flex gap-2">
        <Input value={block.text} onChange={(e) => onChange({ text: e.target.value } as Partial<ScriptBlock>)} placeholder={t("script.locationPlaceholder")} className="h-8 flex-1 text-sm" />
        <Select value={block.locationRef || "__none__"} onValueChange={(v) => onChange({ locationRef: v === "__none__" ? undefined : v } as Partial<ScriptBlock>)}>
          <SelectTrigger className="h-8 w-40 text-sm"><SelectValue placeholder={t("script.link")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("script.none")}</SelectItem>
            {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (block.type === "character") {
    return (
      <div className="space-y-1">
        <Select value={block.characterRef || "__none__"} onValueChange={(v) => onChange({ characterRef: v === "__none__" ? undefined : v } as Partial<ScriptBlock>)}>
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder={t("script.character")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("script.none")}</SelectItem>
            {characters.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={block.text} onChange={(e) => onChange({ text: e.target.value } as Partial<ScriptBlock>)} placeholder={t("script.characterNote")} className="h-8 text-sm" />
      </div>
    );
  }

  if (block.type === "timeline") {
    return (
      <div className="space-y-1">
        <div className="flex gap-2">
          <Select value={block.timelineRef || "__none__"} onValueChange={(v) => onChange({ timelineRef: v === "__none__" ? undefined : v } as Partial<ScriptBlock>)}>
            <SelectTrigger className="h-8 flex-1 text-sm"><SelectValue placeholder={t("script.timelineEvent")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("script.none")}</SelectItem>
              {timelines.map((tl) => <SelectItem key={tl.id} value={tl.id}>{tl.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={block.date ?? ""} onChange={(e) => onChange({ date: e.target.value } as Partial<ScriptBlock>)} placeholder={t("script.date")} className="h-8 w-40 text-sm" />
        </div>
        <Input value={block.text} onChange={(e) => onChange({ text: e.target.value } as Partial<ScriptBlock>)} placeholder={t("script.timelineNote")} className="h-8 text-sm" />
      </div>
    );
  }

  if (block.type === "command") {
    return <Input value={block.raw} onChange={(e) => onChange({ raw: e.target.value } as Partial<ScriptBlock>)} className="h-8 font-mono text-xs" />;
  }

  // tell / action / emotion
  const placeholder = block.type === "action" ? t("script.actionPlaceholder") : block.type === "emotion" ? t("script.emotionPlaceholder") : t("script.tellPlaceholder");
  return <AutoTextarea value={(block as { text: string }).text} onChange={(e) => onChange({ text: e.target.value } as Partial<ScriptBlock>)} placeholder={placeholder} className="text-sm" minRows={1} />;
}
