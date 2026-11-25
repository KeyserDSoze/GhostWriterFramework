import branchesEn from "@/i18n/locales/branches.en";
import branchesIt from "@/i18n/locales/branches.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the branches that load with the branch sync (what it tells the person) and with the switcher, not with the shell of the app. */
registerTranslations(branchesEn, branchesIt);
