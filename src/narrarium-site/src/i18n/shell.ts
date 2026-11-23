import shellEn from "@/i18n/locales/shell.en";
import shellIt from "@/i18n/locales/shell.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts the shell of the app adds for a phone (the name of the menu drawer) and the save bar of the settings travel with the shell, which
 * every page of the app loads: the app entry does not carry them and the public pages do not download them. Importing this module adds them to
 * the shared i18next instance, merged into the `shell` texts the entry has.
 */
registerTranslations(shellEn, shellIt);
