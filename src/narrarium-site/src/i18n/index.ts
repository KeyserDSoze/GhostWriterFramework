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

export default i18n;
