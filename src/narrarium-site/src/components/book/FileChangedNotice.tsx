import { RefreshCcw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Small, non-blocking notice: the file being edited changed underneath, the author's edits were
 * kept, and reloading shows the saved version (and discards them).
 */
export function FileChangedNotice({ message, reloadLabel, onReload }: { message: string; reloadLabel: string; onReload: () => void }) {
  return (
    <Alert>
      <TriangleAlert className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onReload}><RefreshCcw className="h-4 w-4" />{reloadLabel}</Button>
      </AlertDescription>
    </Alert>
  );
}
