import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [fieldA, setFieldA] = useState("");
  const [fieldB, setFieldB] = useState("");
  const [fieldC, setFieldC] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesTitle = kind === "secret" || kind === "timeline-event";
  const fieldLabel = usesTitle ? t("createDialogs.entityTitleLabel") : t("createDialogs.entityNameLabel");
  const config = useMemo(() => {
    switch (kind) {
      case "character":
        return {
          a: { key: "role_tier", label: t("createDialogs.characterRoleTierLabel"), placeholder: t("createDialogs.characterRoleTierPlaceholder") },
          b: { key: "story_role", label: t("createDialogs.characterStoryRoleLabel"), placeholder: t("createDialogs.characterStoryRolePlaceholder") },
          c: { key: "function_in_book", label: t("createDialogs.characterFunctionLabel"), placeholder: t("createDialogs.characterFunctionPlaceholder") },
        };
      case "location":
        return {
          a: { key: "location_kind", label: t("createDialogs.locationKindLabel"), placeholder: t("createDialogs.locationKindPlaceholder") },
          b: { key: "region", label: t("createDialogs.locationRegionLabel"), placeholder: t("createDialogs.locationRegionPlaceholder") },
          c: { key: "atmosphere", label: t("createDialogs.locationAtmosphereLabel"), placeholder: t("createDialogs.locationAtmospherePlaceholder") },
        };
      case "faction":
        return {
          a: { key: "faction_kind", label: t("createDialogs.factionKindLabel"), placeholder: t("createDialogs.factionKindPlaceholder") },
          b: { key: "mission", label: t("createDialogs.factionMissionLabel"), placeholder: t("createDialogs.factionMissionPlaceholder") },
          c: { key: "ideology", label: t("createDialogs.factionIdeologyLabel"), placeholder: t("createDialogs.factionIdeologyPlaceholder") },
        };
      case "item":
        return {
          a: { key: "item_kind", label: t("createDialogs.itemKindLabel"), placeholder: t("createDialogs.itemKindPlaceholder") },
          b: { key: "purpose", label: t("createDialogs.itemPurposeLabel"), placeholder: t("createDialogs.itemPurposePlaceholder") },
          c: { key: "significance", label: t("createDialogs.itemSignificanceLabel"), placeholder: t("createDialogs.itemSignificancePlaceholder") },
        };
      case "secret":
        return {
          a: { key: "secret_kind", label: t("createDialogs.secretKindLabel"), placeholder: t("createDialogs.secretKindPlaceholder") },
          b: { key: "stakes", label: t("createDialogs.secretStakesLabel"), placeholder: t("createDialogs.secretStakesPlaceholder") },
          c: { key: "reveal_strategy", label: t("createDialogs.secretRevealStrategyLabel"), placeholder: t("createDialogs.secretRevealStrategyPlaceholder") },
        };
      case "timeline-event":
        return {
          a: { key: "date", label: t("createDialogs.timelineDateLabel"), placeholder: t("createDialogs.timelineDatePlaceholder") },
          b: { key: "significance", label: t("createDialogs.timelineSignificanceLabel"), placeholder: t("createDialogs.timelineSignificancePlaceholder") },
          c: { key: "function_in_book", label: t("createDialogs.timelineFunctionLabel"), placeholder: t("createDialogs.timelineFunctionPlaceholder") },
        };
      default:
        return {
          a: { key: "", label: "", placeholder: "" },
          b: { key: "", label: "", placeholder: "" },
          c: { key: "", label: "", placeholder: "" },
        };
    }
  }, [kind, t]);

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
      setError(err instanceof Error ? err.message : t("createDialogs.createEntryFailed"));
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
          {triggerLabel ?? t("createDialogs.addEntity", { kind: ENTITY_LABEL[kind].toLowerCase() })}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialogs.newEntity", { kind: ENTITY_LABEL[kind].toLowerCase() })}</DialogTitle>
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
            <Label htmlFor="entity-summary">{t("createDialogs.summaryBodyOptional")}</Label>
            <Textarea
              id="entity-summary"
              rows={3}
              placeholder={t("createDialogs.bodyPlaceholder")}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !label.trim()}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
