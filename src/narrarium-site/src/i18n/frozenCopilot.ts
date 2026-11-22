import frozenCopilotEn from "@/i18n/locales/frozenCopilot.en";
import frozenCopilotIt from "@/i18n/locales/frozenCopilot.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The few texts of the frozen chapters that the Copilot panel shows with a proposal that changes one: opening the panel does not download the texts
 * of the chapter pages (`@/i18n/frozen`).
 */
registerTranslations(frozenCopilotEn, frozenCopilotIt);
