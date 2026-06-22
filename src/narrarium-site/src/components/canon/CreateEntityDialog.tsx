import { useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ENTITY_LABEL, type EntityKind } from "@/narrarium/canon";

interface CreateEntityDialogProps {
  kind: EntityKind;
  onCreate: (input: {
    label: string;
    summary?: string;
    extraFrontmatter?: Record<string, unknown>;
  }) => Promise<void>;
  triggerLabel?: string;
}

export function CreateEntityDialog({ kind, onCreate, triggerLabel }: CreateEntityDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [fieldA, setFieldA] = useState("");
  const [fieldB, setFieldB] = useState("");
  const [fieldC, setFieldC] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesTitle = kind === "secret" || kind === "timeline-event";
  const fieldLabel = usesTitle ? "Title" : "Name";
  const config = useMemo(() => {
    switch (kind) {
      case "character":
        return {
          a: { key: "role_tier", label: "Role tier", placeholder: "supporting" },
          b: { key: "story_role", label: "Story role", placeholder: "ally" },
          c: { key: "function_in_book", label: "Function in book", placeholder: "What this character does in the story" },
        };
      case "location":
        return {
          a: { key: "location_kind", label: "Location kind", placeholder: "city, room, district…" },
          b: { key: "region", label: "Region", placeholder: "Region or territory" },
          c: { key: "atmosphere", label: "Atmosphere", placeholder: "Mood and sensory feel" },
        };
      case "faction":
        return {
          a: { key: "faction_kind", label: "Faction kind", placeholder: "cult, guild, government…" },
          b: { key: "mission", label: "Mission", placeholder: "What the faction wants" },
          c: { key: "ideology", label: "Ideology", placeholder: "Beliefs and worldview" },
        };
      case "item":
        return {
          a: { key: "item_kind", label: "Item kind", placeholder: "artifact, weapon, letter…" },
          b: { key: "purpose", label: "Purpose", placeholder: "Why this item matters" },
          c: { key: "significance", label: "Significance", placeholder: "Story weight or symbolism" },
        };
      case "secret":
        return {
          a: { key: "secret_kind", label: "Secret kind", placeholder: "identity, event, lineage…" },
          b: { key: "stakes", label: "Stakes", placeholder: "What happens if revealed" },
          c: { key: "reveal_strategy", label: "Reveal strategy", placeholder: "How and when to reveal it" },
        };
      case "timeline-event":
        return {
          a: { key: "date", label: "Date", placeholder: "YYYY-MM-DD or free text" },
          b: { key: "significance", label: "Significance", placeholder: "Why this event matters" },
          c: { key: "function_in_book", label: "Function in book", placeholder: "Narrative role of this event" },
        };
      default:
        return {
          a: { key: "", label: "", placeholder: "" },
          b: { key: "", label: "", placeholder: "" },
          c: { key: "", label: "", placeholder: "" },
        };
    }
  }, [kind]);

  function reset() {
    setLabel("");
    setSummary("");
    setFieldA("");
    setFieldB("");
    setFieldC("");
    setError(null);
  }

  async function submit() {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const extraFrontmatter = Object.fromEntries(
        [
          config.a.key ? [config.a.key, fieldA.trim()] : null,
          config.b.key ? [config.b.key, fieldB.trim()] : null,
          config.c.key ? [config.c.key, fieldC.trim()] : null,
        ].filter(Boolean) as Array<[string, string]>,
      );
      await onCreate({
        label: label.trim(),
        summary: summary.trim() || undefined,
        extraFrontmatter,
      });
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create entry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" />
          {triggerLabel ?? `Add ${ENTITY_LABEL[kind].toLowerCase()}`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {ENTITY_LABEL[kind].toLowerCase()}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="entity-label">{fieldLabel}</Label>
            <Input
              id="entity-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>

          {config.a.key && (
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>{config.a.label}</Label>
                <Input value={fieldA} onChange={(e) => setFieldA(e.target.value)} placeholder={config.a.placeholder} />
              </div>
              <div className="grid gap-2">
                <Label>{config.b.label}</Label>
                <Input value={fieldB} onChange={(e) => setFieldB(e.target.value)} placeholder={config.b.placeholder} />
              </div>
              <div className="grid gap-2">
                <Label>{config.c.label}</Label>
                <Input value={fieldC} onChange={(e) => setFieldC(e.target.value)} placeholder={config.c.placeholder} />
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="entity-summary">Summary / body (optional)</Label>
            <Textarea
              id="entity-summary"
              rows={3}
              placeholder="A short description used as the file body."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !label.trim()}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
