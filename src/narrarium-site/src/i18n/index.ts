import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import it from "./locales/it";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
] as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "narrarium-language",
    },
    resources: {
      en: { translation: en },
      it: { translation: it },
    },
  });

/** The page says in which language it is written: a screen reader reads it with that language's voice and rules (WCAG 3.1.1). */
function announceLanguage(): void {
  if (typeof document === "undefined") return;
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (language) document.documentElement.lang = language;
}

i18n.on("initialized", announceLanguage);
i18n.on("languageChanged", announceLanguage);
announceLanguage();

export default i18n;
