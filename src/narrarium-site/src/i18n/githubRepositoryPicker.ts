import githubRepositoryPickerEn from "@/i18n/locales/githubRepositoryPicker.en";
import githubRepositoryPickerIt from "@/i18n/locales/githubRepositoryPicker.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the repository picker (the list of repositories to connect, the name of a new one, what is done with the one that was picked) travel with the
 * pages that use it, which import this module: the app entry does not carry them. Keys: `github.picker.*`.
 */
registerTranslations(githubRepositoryPickerEn, githubRepositoryPickerIt);
