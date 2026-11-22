import debugAttemptEn from "@/i18n/locales/debugAttempt.en";
import debugAttemptIt from "@/i18n/locales/debugAttempt.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the attempt details of the debug panel are bundled with the panel that shows them, not with the app entry. Importing this module adds
 * them to the shared i18next instance, next to the `debug.*` texts the entry already has.
 */
registerTranslations(debugAttemptEn, debugAttemptIt);
