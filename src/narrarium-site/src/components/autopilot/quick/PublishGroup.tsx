import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ChevronDown, Github, Loader2 } from "lucide-react";
import type { AutopilotPublishMode } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PUBLISH_CHOICES, QUICK_CONTROLS_SERVER_VERSION } from "@/autopilot/quickControls";
import type { QuickModel } from "@/components/autopilot/quick/model";
import { MENU_CONTENT, MENU_ITEM, MenuText, Reason } from "@/components/autopilot/quick/parts";

/**
 * The third group of the bar, for the books kept on GitHub: where the book is published (never, every chapter, every step), which
 * changes for the next step also while the autopilot runs, and a way to publish now. Without a token to use there is nothing to
 * publish with, and the group says so.
 */
export function PublishGroup({ model }: { model: QuickModel }) {
  const { t } = useTranslation();
  const { commands, busy, acting, unreachable, publish, named, ids } = model;
  if (!model.github) return null;
  const blocked = !model.token || unreachable || acting;
  const label = t("autopilot.quick.publish.label", { mode: t(`autopilot.quick.publish.mode.${publish}`) });
  // The server that runs the book keeps the choice, and an old one does not know how: it can still be told to publish now.
  const cannotChoose = !model.serverControls;
  const serverOffline = model.host === "server" && !model.serverUsable;
  const described = !model.token ? ids.publish : unreachable ? ids.remote : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="justify-start" aria-label={named(label)} aria-describedby={described} disabled={blocked}>
            {busy === "options" || busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Github className="h-4 w-4" aria-hidden />}
            {label}<ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={MENU_CONTENT}>
          <DropdownMenuLabel>{t("autopilot.quick.publish.heading")}</DropdownMenuLabel>
          <DropdownMenuLabel className="pt-0 text-xs font-normal text-muted-foreground">
            {cannotChoose ? t("autopilot.quick.serverTooOld", { version: QUICK_CONTROLS_SERVER_VERSION }) : t("autopilot.quick.publish.applies")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={publish} onValueChange={(value) => void commands.setPublish(value as AutopilotPublishMode)}>
            {PUBLISH_CHOICES.map((choice) => (
              <DropdownMenuRadioItem key={choice} value={choice} disabled={cannotChoose || serverOffline}>{t(`autopilot.quick.publish.choice.${choice}`)}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={MENU_ITEM} disabled={serverOffline} onSelect={() => void commands.publishNow()}>
            <MenuText label={t("autopilot.quick.publish.now")} hint={serverOffline ? t("autopilot.where.serverUnverified") : undefined} disabled={serverOffline} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!model.token && (
        <Reason id={ids.publish}>
          {t("autopilot.quick.publish.needsToken")} <Link className="underline" to="/app/settings/github">{t("autopilot.quick.publish.tokenLink")}</Link>
        </Reason>
      )}
    </div>
  );
}
