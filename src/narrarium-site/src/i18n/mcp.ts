import mcpEn from "@/i18n/locales/mcp.en";
import mcpIt from "@/i18n/locales/mcp.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/**
 * The texts of the MCP server of a book are bundled with the settings page of the book, the only view that shows them: the app entry does not carry
 * them and the public pages do not download them. Importing this module adds them to the shared i18next instance.
 */
registerTranslations(mcpEn, mcpIt);
