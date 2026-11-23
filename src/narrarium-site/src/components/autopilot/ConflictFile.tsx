import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { formatBytes } from "@/autopilot/format";
import type { ConflictSide } from "@/autopilot/store";

/** The labels of a choice are sentences: they wrap instead of running out of the card, whatever the language. */
export const WRAP = "h-auto min-h-9 whitespace-normal py-1.5 text-left";

/** What happened to a file on one side, in words, with the size of that version when it is there: «changed (1.2 KB)», «deleted». */
export function sideText(t: TFunction, state: ConflictSide, bytes: number | undefined): string {
  return bytes === undefined ? t(`autopilot.where.side.${state}`) : t("autopilot.where.sideSize", { state: t(`autopilot.where.side.${state}`), size: formatBytes(bytes) });
}

/**
 * One file that changed on both sides: its path (a long name, or one that is not Latin, breaks where it must instead of running out of the card), what each side did with it, and
 * the way to choose which version to keep (`children`). Shared by the conflicts between this device and the server and by those between the server and GitHub.
 */
export function ConflictFile({ path, pathId, line, children }: { path: string; pathId?: string; line: string; children?: ReactNode }) {
  return (
    <li className="space-y-1.5 rounded-md border bg-background/70 p-2">
      <code id={pathId} dir="auto" className="block break-all text-xs">{path}</code>
      <p className="text-xs text-muted-foreground">{line}</p>
      {children}
    </li>
  );
}
