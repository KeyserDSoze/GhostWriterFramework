import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatAgo } from "@/autopilot/format";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import type { AutopilotControl } from "@/autopilot/useAutopilotControl";
import { cn } from "@/lib/utils";

/**
 * Why Pause and Stop are disabled: the autopilot of the book runs on another device or on the server, which this page
 * cannot command. Says who runs it and when it was last heard of, and offers to take control: that starts the run here, and the
 * other run stops at its next step. The lease is only a hint (the other device may simply be off): the author decides, after a confirmation.
 */
export function RemoteRunNotice({ bookId, control, id, className }: { bookId: string; control: AutopilotControl; id?: string; className?: string }) {
  const { t } = useTranslation();
  const { busy, run } = useAutopilotActions(bookId);
  const [open, setOpen] = useState(false);
  if (!control.running || control.controllable) return null;

  const label = control.runnerLabel || (control.runnerHost ? t(`autopilot.host.${control.runnerHost}`) : null);
  const age = control.heartbeatAge === null ? null : t("autopilot.control.lastSignal", { age: formatAgo(control.heartbeatAge) });
  const takeOver = () => {
    setOpen(false);
    void run("start", (runtime, bookIdToStart) => runtime.start(bookIdToStart, { force: true }));
  };

  return (
    <div id={id} role="note" className={cn("space-y-2 rounded-lg border bg-muted/40 p-3 text-sm", className)}>
      <p className="flex items-start gap-1.5">
        <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{label ? t("autopilot.remoteRunner", { label }) : t("autopilot.control.runningElsewhere")}</span>
      </p>
      <p className="text-xs text-muted-foreground">{t("autopilot.control.pauseElsewhere")}{age ? ` ${age}` : ""}</p>
      {control.canTakeOver && (
        <>
          <Button size="sm" variant="outline" aria-haspopup="dialog" disabled={busy !== null} onClick={() => setOpen(true)}>
            <Hand className="h-3.5 w-3.5" />{t("autopilot.control.takeOver")}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent hideCloseButton>
              <DialogHeader>
                <DialogTitle>{t("autopilot.control.takeOverTitle")}</DialogTitle>
                <DialogDescription>
                  {t("autopilot.control.takeOverBody", { label: label ?? t("autopilot.control.anotherHost") })}{age ? ` ${age}` : ""}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm">{t("autopilot.control.takeOverEffect")}</p>
              <p className="text-sm text-muted-foreground">{t("autopilot.control.takeOverAdvice")}</p>
              <DialogFooter className="gap-2 sm:gap-0">
                <DialogClose asChild><Button variant="outline">{t("common.cancel")}</Button></DialogClose>
                <Button onClick={takeOver}>{t("autopilot.control.takeOverConfirm")}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
