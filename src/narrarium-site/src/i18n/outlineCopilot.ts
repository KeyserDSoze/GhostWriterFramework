import outlineCopilotEn from "@/i18n/locales/outlineCopilot.en";
import outlineCopilotIt from "@/i18n/locales/outlineCopilot.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The few texts of the Outline that the Copilot panel shows with a proposal for it: opening the panel does not download the texts of the whole
 * Outline page (`@/i18n/outline`).
 */
registerTranslations(outlineCopilotEn, outlineCopilotIt);
