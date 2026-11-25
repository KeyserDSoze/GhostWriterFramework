import { useTranslation } from "react-i18next";
import { AlertTriangle, MoveRight, PencilLine } from "lucide-react";
import "@/i18n/annotations";
import type { AnchorState } from "@/annotations/anchoring";
import { cn } from "@/lib/utils";

/** Where an annotation's passage is now, when it is not where it was marked: moved, changed, or no longer in the text (orphaned). */
export function AnchorNotice({ state, compact, className }: { state: AnchorState; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (state === "exact") return null;
  const Icon = state === "orphaned" ? AlertTriangle : state === "edited" ? PencilLine : MoveRight;
  return (
    <p className={cn("flex items-start gap-1.5 text-sm", state === "orphaned" ? "text-destructive" : "text-muted-foreground", className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{compact ? t(`annotations.anchor.${state}Short`) : t(`annotations.anchor.${state}`)}</span>
    </p>
  );
}
