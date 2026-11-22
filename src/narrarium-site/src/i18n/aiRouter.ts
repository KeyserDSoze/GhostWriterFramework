import aiRouterEn from "@/i18n/locales/aiRouter.en";
import aiRouterIt from "@/i18n/locales/aiRouter.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the AI Router and of the integration card, which share the settings page, are bundled with it: the app entry does not carry them and the
 * public pages do not download them. Importing this module adds them to the shared i18next instance; the `routing.*` and `settings.*` texts the entry
 * already has stay as they are.
 */
registerTranslations(aiRouterEn, aiRouterIt);
