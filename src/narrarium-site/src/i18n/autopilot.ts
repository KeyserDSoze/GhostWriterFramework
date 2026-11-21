import i18next from "i18next";

let pending: Promise<void> | null = null;

function addBundles(en: object, it: object): void {
  i18next.addResourceBundle("en", "translation", en, true, false);
  i18next.addResourceBundle("it", "translation", it, true, false);
}

/**
 * The autopilot, director and personal-server texts are loaded with the views that use them,
 * so the app entry only carries the few labels shown everywhere (sidebar, launcher, actions).
 *
 * The bundles go to the shared i18next instance that the app entry initializes (`@/i18n`).
 * Importing `@/i18n` here would initialize it as a side effect of importing these views.
 */
export function loadAutopilotTranslations(): Promise<void> {
  pending ??= Promise.all([import("@/i18n/locales/autopilot.en"), import("@/i18n/locales/autopilot.it")])
    .then(([en, it]) => {
      if (i18next.isInitialized || i18next.isInitializing) addBundles(en.default, it.default);
      else i18next.on("initialized", () => addBundles(en.default, it.default));
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

/** Wrap a lazy module loader so the module resolves only once its texts are available. */
export function withAutopilotTranslations<T>(loader: () => Promise<T>): () => Promise<T> {
  return () => Promise.all([loader(), loadAutopilotTranslations()]).then(([module]) => module);
}
