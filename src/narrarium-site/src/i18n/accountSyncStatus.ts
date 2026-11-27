import accountSyncStatusEn from "@/i18n/locales/accountSyncStatus.en";
import accountSyncStatusIt from "@/i18n/locales/accountSyncStatus.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the cards of Account & Sync that say a sign-in ended, what is synced and when the automatic sync is on (the app entry does not carry them). Keys: `accountSyncStatus.*`. */
registerTranslations(accountSyncStatusEn, accountSyncStatusIt);
