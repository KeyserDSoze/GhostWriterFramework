import i18next from "i18next";
import docsContentEn from "@/i18n/locales/docsContent.en";
import docsContentIt from "@/i18n/locales/docsContent.it";

/**
 * The texts of a document that is loading or could not be loaded travel with the documentation pages: the app entry, which the public home shares,
 * does not carry them. They are added to the shared i18next instance (in the entry) directly, as `registerTranslations` does: importing that helper
 * would put its chunk in the preload lists that the entry keeps for the docs routes, and the margin of the home route must not shrink.
 */
const add = (): void => {
  i18next.addResourceBundle("en", "translation", docsContentEn, true, false);
  i18next.addResourceBundle("it", "translation", docsContentIt, true, false);
};
if (i18next.isInitialized || i18next.isInitializing) add();
else i18next.on("initialized", add);
