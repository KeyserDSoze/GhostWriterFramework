import i18next from "i18next";

/**
 * Adds the texts of a view to the shared i18next instance that the app entry initializes (`@/i18n`), merged into what is already there and never over it.
 * It is for the texts that travel with the chunk of the view that shows them, so that the app entry does not carry them and the public pages do not
 * download them: the view imports a small module that calls this with its two catalogues.
 *
 * Importing `@/i18n` here would initialize it as a side effect of importing the view.
 */
export function registerTranslations(en: object, it: object): void {
  const add = (): void => {
    i18next.addResourceBundle("en", "translation", en, true, false);
    i18next.addResourceBundle("it", "translation", it, true, false);
  };
  if (i18next.isInitialized || i18next.isInitializing) add();
  else i18next.on("initialized", add);
}
