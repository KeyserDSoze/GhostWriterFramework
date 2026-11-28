import serverGitHubEn from "@/i18n/locales/serverGitHub.en";
import serverGitHubIt from "@/i18n/locales/serverGitHub.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the server's own GitHub connection (its card in Settings → Personal server, the choice of how a book signs in to GitHub on the server, the words of its errors) travel with the
 * views that show them: importing this module adds them to the shared i18next instance; the app entry does not carry them. Keys: `serverGitHub.*`.
 */
registerTranslations(serverGitHubEn, serverGitHubIt);
