import bookGithubEn from "@/i18n/locales/bookGithub.en";
import bookGithubIt from "@/i18n/locales/bookGithub.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the card that connects a local book to GitHub travel with the settings page of the book, which imports this module: the app entry
 * does not carry them. They are merged into the `bookSettings` texts the entry has.
 */
registerTranslations(bookGithubEn, bookGithubIt);
