import reconcileEn from "@/i18n/locales/accountReconcile.en";
import reconcileIt from "@/i18n/locales/accountReconcile.it";
import { registerTranslations } from "@/i18n/lazyBundles";

/** The texts of the dialog that asks which account copy to keep, bundled with the Account & Sync page that shows it. Keys: `accountSync.reconcile.*`. */
registerTranslations(reconcileEn, reconcileIt);
