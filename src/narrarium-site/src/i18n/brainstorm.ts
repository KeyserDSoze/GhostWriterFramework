import brainstormEn from "@/i18n/locales/brainstorm.en";
import brainstormIt from "@/i18n/locales/brainstorm.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of Brainstorming, the Copilot's mode on the Synopsis page: the page imports them with its launcher and its button, and Brainstorming's
 * own parts of the panel with them, so neither the app entry nor the Copilot panel carries them.
 */
registerTranslations(brainstormEn, brainstormIt);
