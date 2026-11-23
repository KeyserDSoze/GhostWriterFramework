import i18next from "i18next";
import mcpBookPageEn from "@/i18n/locales/mcpBookPage.en";
import mcpBookPageIt from "@/i18n/locales/mcpBookPage.it";
import mcpBookToolsEn from "@/i18n/locales/mcpBookTools.en";
import mcpBookToolsIt from "@/i18n/locales/mcpBookTools.it";

/**
 * The texts of the public /mcp page's part on a book's MCP, and the one line of each of its tools, travel with that page: the app entry, which the
 * public home shares, does not carry them. They are added to the shared i18next instance (in the entry) directly, as `docsContent` does and as
 * `registerTranslations` would: importing that helper would put its chunk in the preload list that the entry keeps for this route, and the margin
 * of the home route must not shrink.
 */
const add = (): void => {
  i18next.addResourceBundle("en", "translation", mcpBookPageEn, true, false);
  i18next.addResourceBundle("en", "translation", mcpBookToolsEn, true, false);
  i18next.addResourceBundle("it", "translation", mcpBookPageIt, true, false);
  i18next.addResourceBundle("it", "translation", mcpBookToolsIt, true, false);
};
if (i18next.isInitialized || i18next.isInitializing) add();
else i18next.on("initialized", add);
