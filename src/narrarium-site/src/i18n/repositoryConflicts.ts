import repositoryConflictsEn from "@/i18n/locales/repositoryConflicts.en";
import repositoryConflictsIt from "@/i18n/locales/repositoryConflicts.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the resolver of the conflicts of a repository sync travel with its window: importing this module adds them; the app shell does not carry them. */
registerTranslations(repositoryConflictsEn, repositoryConflictsIt);
