import brainstormerEn from "@/i18n/locales/brainstormer.en";
import brainstormerIt from "@/i18n/locales/brainstormer.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the page of the Brainstormer travel with it: importing this module adds them to the shared i18next instance. */
registerTranslations(brainstormerEn, brainstormerIt);
