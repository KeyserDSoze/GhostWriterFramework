import { Eye, EyeOff, LogOut, Menu, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuthStore } from "@/store/authStore";
import { useNavigate } from "react-router-dom";
import { useRef } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { speakText, type SpeechController } from "@/assistant/speech";
import { useToast } from "@/components/ui/use-toast";

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { t } = useTranslation();
  const { user, clearAuth } = useAuthStore();
  const { settings } = useSettingsStore();
  const { floatingHidden, toggleFloating } = useUiStore();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const { toast } = useToast();
  const navigate = useNavigate();
  const speechRef = useRef<SpeechController | null>(null);

  function handleSignOut() {
    clearAuth();
    navigate("/login");
  }

  async function handleReadPage() {
    try {
      if (speechRef.current) {
        speechRef.current.stop();
        speechRef.current = null;
        return;
      }
      const main = document.querySelector("main");
      const text = main?.textContent?.trim() ?? document.body.textContent?.trim() ?? "";
      speechRef.current = await speakText(text, settings);
    } catch (err) {
      toast({ title: t("shell.ttsFailed"), description: String(err), variant: "destructive" });
    }
  }

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b bg-background px-3 sm:px-4">
      {sidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={t("nav.expandSidebar")}
          onClick={() => setSidebarCollapsed(false)}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}
      <div className="flex items-center gap-2 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("shell.openNav")}
          onClick={onOpenMobileNav}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="font-semibold">Narrarium</span>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" aria-label={floatingHidden ? t("shell.showFloating") : t("shell.hideFloating")} onClick={toggleFloating}>
          {floatingHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" aria-label={t("shell.readPage")} onClick={() => void handleReadPage()}>
          <Volume2 className="h-4 w-4" />
        </Button>
        <ThemeToggle />
        <LanguageToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs font-medium">
                  {initials(user?.name)}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {user && (
              <>
                <DropdownMenuLabel>
                  <div className="font-normal">
                    <p className="font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              {t("shell.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
