import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChevronDown, Laptop, Loader2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isHandoverConsentError, isHandoverOver, type HandoverRequest } from "@/autopilot/handover";
import { QUICK_CONTROLS_SERVER_VERSION } from "@/autopilot/quickControls";
import type { QuickModel } from "@/components/autopilot/quick/model";
import { MENU_CONTENT, MENU_ITEM, MenuText, Reason } from "@/components/autopilot/quick/parts";
import { useToast } from "@/components/ui/use-toast";

/**
 * The fourth group of the bar: where the autopilot runs, and the ways to pass to the other side: after the step that runs (what the author
 * usually wants), now (the step in progress is done again on the other side), or for one step there, and then back. A stopped
 * autopilot is moved as it is: it is started over there only when it was running.
 */
export function WhereGroup({ model }: { model: QuickModel }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { host, busy, acting, unreachable, named, ids, handover } = model;
  const to = host === "server" ? "browser" : "server";
  const planned = Boolean(handover && !isHandoverOver(handover));
  const reason = (() => {
    if (unreachable) return { id: ids.remote, text: null };
    if (!model.serverConfigured) return { id: ids.where, text: t("autopilot.where.noServer") };
    if (!model.serverUsable) return { id: ids.where, text: t("autopilot.where.serverUnverified") };
    if (planned) return { id: ids.where, text: t("autopilot.quick.where.planned") };
    // Another operation holds the book: say so. An action of this bar that is on its way is said by the line that tells what it does.
    if (model.operation) return { id: ids.where, text: t("autopilot.quick.where.busy") };
    if (acting) return { id: ids.busy, text: null };
    return null;
  })();
  const label = t("autopilot.quick.where.label", { host: t(host === "server" ? "autopilot.quick.where.hostServer" : "autopilot.quick.where.hostBrowser") });
  const running = model.control.running;
  // Passing the book to the server for one step needs a server that keeps the limit; coming back from it does not.
  const old = to === "server" && !model.serverKeepsLimits;
  const tooOld = t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION });

  const arm = (request: HandoverRequest) => void model.commands.handover(request, {
    saveSettings: model.save,
    onError: (error) => {
      if (!isHandoverConsentError(error)) return false;
      // A secret is never sent by itself: the flow that asks for the consent is the one of “Where it runs”.
      toast({ title: t("autopilot.quick.handover.consentTitle"), description: error.message });
      model.openWhere(to);
      return true;
    },
  });
  const words = to === "server"
    ? { afterStep: "toServerAfterStep", now: "toServerNow", nowHint: "toServerNowHint", plain: "toServer" }
    : { afterStep: "toBrowserAfterStep", now: "toBrowserNow", nowHint: "toBrowserNowHint", plain: "toBrowser" };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="justify-start" aria-label={named(label)} aria-describedby={reason?.id} disabled={reason !== null}>
            {busy === "handover" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : host === "server" ? <Server className="h-4 w-4" aria-hidden /> : <Laptop className="h-4 w-4" aria-hidden />}
            {label}<ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={MENU_CONTENT}>
          {running ? (
            <>
              <DropdownMenuItem className={MENU_ITEM} onSelect={() => arm({ to })}>
                <MenuText label={t(`autopilot.quick.where.${words.afterStep}`)} />
              </DropdownMenuItem>
              <DropdownMenuItem className={MENU_ITEM} onSelect={() => arm({ to, when: "now" })}>
                <MenuText label={t(`autopilot.quick.where.${words.now}`)} hint={t(`autopilot.quick.where.${words.nowHint}`)} />
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem className={MENU_ITEM} onSelect={() => arm({ to })}>
              <MenuText label={t(`autopilot.quick.where.${words.plain}`)} />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={MENU_ITEM} disabled={old} onSelect={() => arm({ to, returnAfterSteps: 1 })}>
            <MenuText label={to === "server" ? t("autopilot.quick.where.stepOnServer") : t("autopilot.quick.where.stepInBrowser")} hint={old ? tooOld : undefined} disabled={old} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {reason?.text && (
        <Reason id={reason.id}>
          {reason.text}{" "}
          {!model.serverConfigured || !model.serverUsable ? <Link className="underline" to="/app/settings/server">{t("personalServer.title")}</Link> : null}
        </Reason>
      )}
    </div>
  );
}
