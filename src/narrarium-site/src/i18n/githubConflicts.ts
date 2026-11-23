import githubConflictsEn from "@/i18n/locales/githubConflicts.en";
import githubConflictsIt from "@/i18n/locales/githubConflicts.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the conflicts with GitHub travel with the views that show them (the error panel and «Where it runs» of the autopilot page, and the window that settles them):
 * importing this module adds them to the shared i18next instance; the app entry does not carry them.
 */
registerTranslations(githubConflictsEn, githubConflictsIt);
