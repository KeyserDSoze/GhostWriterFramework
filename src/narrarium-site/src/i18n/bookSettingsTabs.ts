import bookSettingsTabsEn from "@/i18n/locales/bookSettingsTabs.en";
import bookSettingsTabsIt from "@/i18n/locales/bookSettingsTabs.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the tabs of a book's settings travel with the settings page, which imports this module: the app entry does not carry them. They are merged into the `bookSettings` texts the entry has. */
registerTranslations(bookSettingsTabsEn, bookSettingsTabsIt);
