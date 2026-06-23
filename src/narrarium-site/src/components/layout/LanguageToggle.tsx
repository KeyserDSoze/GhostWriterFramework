import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const { settings, patchSettings } = useSettingsStore();
  const { save } = useSettings();
  const current = i18n.resolvedLanguage?.split("-")[0] ?? settings.ui.language ?? "en";

  async function changeLanguage(code: "en" | "it") {
    await i18n.changeLanguage(code);
    patchSettings({ ui: { ...settings.ui, language: code } });
    await save();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change language">
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LANGUAGES.map((language) => (
          <DropdownMenuItem key={language.code} onClick={() => void changeLanguage(language.code)} className={current === language.code ? "font-semibold" : undefined}>
            {language.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
