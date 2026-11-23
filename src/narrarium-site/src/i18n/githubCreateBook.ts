import githubCreateBookEn from "@/i18n/locales/githubCreateBook.en";
import githubCreateBookIt from "@/i18n/locales/githubCreateBook.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the creation of a repository on GitHub (the owner and visibility choices, the checklist, the progress, the result and the manual steps)
 * travel with the two pages that create one, which import this module: the app entry does not carry them. Keys: `github.createBook.*`.
 */
registerTranslations(githubCreateBookEn, githubCreateBookIt);
