import { ArrowLeftRight, MoreHorizontal, Plus } from "lucide-react";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";

interface RouterTabsBarProps {
  sectionTitle: string;
  /** How many tabs there are: the primary and the fallbacks. */
  count: number;
  activeLevel: number;
  tabName: (level: number) => string;
  canAdd: boolean;
  /** Which rows the menus act on: the selected ones, or all of them. */
  scopeText: string;
  tabsRef: Ref<HTMLDivElement>;
  onAdd: () => void;
  onSwap: (other: number) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}

/** The tabs of a section (the primary, the fallbacks), a button for a new one, the swap menu and the menu of the tab that is open. */
export function RouterTabsBar({ sectionTitle, count, activeLevel, tabName, canAdd, scopeText, tabsRef, onAdd, onSwap, onMove, onDelete }: RouterTabsBarProps) {
  const { t } = useTranslation();
  const levels = Array.from({ length: count }, (_, level) => level);
  const others = levels.filter((level) => level !== activeLevel);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={tabsRef}>
        <TabsList aria-label={t("routing.tabs.label", { section: sectionTitle })} className="h-auto flex-wrap justify-start">
          {levels.map((level) => <TabsTrigger key={level} value={String(level)}>{tabName(level)}</TabsTrigger>)}
        </TabsList>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={onAdd} aria-label={t("routing.tabs.addFor", { section: sectionTitle })}>
        <Plus aria-hidden="true" />{t("routing.tabs.add")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={count < 2} aria-label={t("routing.tabs.swapFor", { section: sectionTitle })}>
            <ArrowLeftRight aria-hidden="true" />{t("routing.tabs.swap")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{scopeText}</DropdownMenuLabel>
          {others.map((level) => <DropdownMenuItem key={level} onSelect={() => onSwap(level)}>{t("routing.tabs.swapWith", { tab: tabName(level) })}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t("routing.tabs.moreFor", { tab: tabName(activeLevel), section: sectionTitle })}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{scopeText}</DropdownMenuLabel>
          <DropdownMenuItem disabled={activeLevel === 0} onSelect={() => onMove(-1)}>{t("routing.tabs.moveLeft")}</DropdownMenuItem>
          <DropdownMenuItem disabled={activeLevel === count - 1} onSelect={() => onMove(1)}>{t("routing.tabs.moveRight")}</DropdownMenuItem>
          {activeLevel > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>{t("routing.tabs.delete")}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
