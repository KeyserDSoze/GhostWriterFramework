/** Texts of the cards of Account & Sync: a sign-in that ended, the state of the sync, the automatic sync (see `@/i18n/accountSyncStatus`). */
const accountSyncStatusEn = {
  accountSyncStatus: {
    sync: {
      allSynced: "All synced · last check {{time}}",
      allSyncedDate: "All synced · last check {{date}}",
      pending: {
        "local-changes": "Changes on this device are waiting to be sent.",
        "remote-newer": "{{service}} has newer data than this device.",
        "different-copies": "This device and {{service}} have different copies: you will be asked which to keep.",
        "never-synced": "Not synced yet.",
      },
      syncing: "Syncing…",
      off: "Automatic sync is off for this service: nothing is sent or received by itself.",
      offline: "This device is offline. The sync resumes by itself when it is back online.",
      error: "The last sync did not work. Try again.",
      sync: "Sync",
      tryAgain: "Try again",
      checkNow: "Check now",
      checkNowHint: "Looks for changes made on another device.",
    },
    auto: {
      allTitle: "Automatic sync for all services",
      allOn: "On",
      allOff: "Off",
      allHelp: "When it is on, every connected service sends and receives your changes by itself, a moment after you make them. A service that has its own setting below keeps it, whatever this says.",
      serviceLabel: "Automatic sync",
      inherit: "Follows the general setting, which is {{state}}.",
      own: "Set for this service only: {{state}}. It overrides the general setting.",
      followGeneral: "Follow the general setting",
      stateOn: "on",
      stateOff: "off",
    },
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
