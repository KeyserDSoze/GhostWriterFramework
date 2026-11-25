import { useTranslation } from "react-i18next";
import "@/i18n/annotations";
import { MARK_ICON_SVG } from "@/annotations/icons";
import { normalizeMarkStyle, type MarkIcon as MarkIconName, type MarkStyle, type ResolvedTag } from "@/annotations/model";
import { cn } from "@/lib/utils";

/** An icon of a mark, the same SVG the reader writes into the text; hidden from assistive technology (what it is part of has the name). */
export function MarkIcon({ icon, className }: { icon: MarkIconName; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("h-4 w-4 shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: MARK_ICON_SVG[icon] ?? MARK_ICON_SVG.question }}
    />
  );
}

/** A short piece of text drawn the way a tag marks a passage: its underline, its colour and its icon (never the colour alone). */
export function MarkSample({ mark: stored, children, className }: { mark: MarkStyle; children: React.ReactNode; className?: string }) {
  // A mark of a newer app is drawn as the stand-in's.
  const mark = normalizeMarkStyle(stored);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span data-mark-color={mark.color} className="annotation-mark-icon inline-flex shrink-0 items-center"><MarkIcon icon={mark.icon} className="h-3.5 w-3.5" /></span>
      <span className="annotation-mark-sample min-w-0 break-words px-0.5" data-mark-color={mark.color} data-mark-underline={mark.underline}>{children}</span>
    </span>
  );
}

/** A tag: its mark and its name, and, when asked, where it comes from (built-in, every book, this book). */
export function TagLabel({ tag, showScope, className }: { tag: ResolvedTag; showScope?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", className)}>
      <MarkSample mark={tag.mark}>{tag.name}</MarkSample>
      {showScope && <>{" "}<span className="text-xs text-muted-foreground">{t(`annotations.tag.scope.${tag.scope}`)}</span></>}
    </span>
  );
}
