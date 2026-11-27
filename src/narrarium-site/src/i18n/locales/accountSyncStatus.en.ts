/** Texts of the cards of Account & Sync: a sign-in that ended, the state of the sync, the automatic sync (see `@/i18n/accountSyncStatus`). */
const accountSyncStatusEn = {
  accountSyncStatus: {
    technicalDetails: "Technical details",
    signIn: {
      title: "Sign in to {{service}} again on this device",
      action: "Sign in to {{service}} again on this device",
      why: {
        session: "This device signed in to {{service}} with session credentials: they last only for a short time (about an hour for Google, about a day for Microsoft) and then the service asks you to sign in again. They have ended. Your data is safe on this device and nothing is lost.",
        "long-lived": "The long-lived sign-in to {{service}} was refused or is no longer kept on this device, so it has to be made again. Your data is safe on this device and nothing is lost.",
        missing: "There is no saved sign-in to {{service}} on this device (it was not kept, or this is another device). Your data is safe on this device and nothing is lost.",
      },
      offerLongLived: "To stop signing in again: long-lived credentials renew themselves in the background through Narrarium's sign-in service. Switch to them below, after you sign in again.",
    },
  },
};

export default accountSyncStatusEn;
