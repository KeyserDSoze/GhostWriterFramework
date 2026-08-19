import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SHORTCUTS = [
  ["previous", "Alt + ←"],
  ["next", "Alt + →"],
  ["nextView", "Ctrl/Cmd + Tab"],
  ["previousView", "Ctrl/Cmd + Shift + Tab"],
  ["save", "Ctrl/Cmd + S"],
  ["sync", "Ctrl/Cmd + E"],
  ["notes", "Ctrl/Cmd + M"],
  ["debug", "Ctrl/Cmd + D"],
  ["research", "Ctrl/Cmd + R"],
  ["quickSwitch", "Ctrl/Cmd + L"],
  ["previousDocument", "Ctrl/Cmd + `"],
  ["copy", "Ctrl/Cmd + C"],
  ["readerPrevious", "←"],
  ["readerNext", "→"],
] as const;

export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{t("shortcuts.title")}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t("shortcuts.description")}</p>
        <div className="divide-y rounded-xl border">
          {SHORTCUTS.map(([id, keys]) => (
            <div key={id} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
              <span>{t(`shortcuts.items.${id}`)}</span>
              <kbd className="shrink-0 rounded border bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">{keys}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
