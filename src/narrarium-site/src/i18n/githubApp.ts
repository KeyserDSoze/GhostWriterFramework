import githubAppEn from "@/i18n/locales/githubApp.en";
import githubAppIt from "@/i18n/locales/githubApp.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of «Connect with GitHub» travel with the views that show them (the GitHub card of Account & Sync, its callback page, the book's GitHub
 * access, the creation of a repository): importing this module adds them to the shared i18next instance; the app entry does not carry them.
 * Keys: `accountSync.github.*` and `github.createBook.app.*`.
 */
registerTranslations(githubAppEn, githubAppIt);
