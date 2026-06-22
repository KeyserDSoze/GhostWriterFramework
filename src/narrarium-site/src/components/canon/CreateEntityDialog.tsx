import { useState } from "react";
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
  onCreate: (input: { label: string; summary?: string }) => Promise<void>;
  triggerLabel?: string;
}

export function CreateEntityDialog({ kind, onCreate, triggerLabel }: CreateEntityDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesTitle = kind === "secret" || kind === "timeline-event";
  const fieldLabel = usesTitle ? "Title" : "Name";

  function reset() {
    setLabel("");
    setSummary("");
    setError(null);
  }

  async function submit() {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ label: label.trim(), summary: summary.trim() || undefined });
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
          <div className="grid gap-2">
            <Label htmlFor="entity-summary">Summary (optional)</Label>
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
