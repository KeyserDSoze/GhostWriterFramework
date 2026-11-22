import { CircleAlert, FileWarning, Gauge, GitMerge, KeyRound, Ruler, Scissors, ServerCrash, ShieldBan, SlidersHorizontal, Timer, Wallet, WifiOff, type LucideIcon } from "lucide-react";
import type { AutopilotErrorKind } from "narrarium-engine";

/** A shape for each kind of failure, so that what went wrong is never told by colour alone. */
const KIND_ICON: Record<AutopilotErrorKind, LucideIcon> = {
  network: WifiOff,
  auth: KeyRound,
  rate_limit: Gauge,
  timeout: Timer,
  truncated: Scissors,
  refused: ShieldBan,
  conflict: GitMerge,
  budget: Wallet,
  limit: Ruler,
  profile: FileWarning,
  config: SlidersHorizontal,
  provider: ServerCrash,
  unknown: CircleAlert,
};

/** The icon of a kind of failure: decoration, the words say it. `className` gives its size and its colour. */
export function KindIcon({ kind, className }: { kind: AutopilotErrorKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={className} aria-hidden="true" />;
}
