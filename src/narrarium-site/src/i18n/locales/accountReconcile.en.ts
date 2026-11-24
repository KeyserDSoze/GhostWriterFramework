/** Texts of the dialog that asks which account copy to keep when the copies differ (see `@/i18n/accountReconcile`). */
const accountReconcileEn = {
  accountSync: {
    reconcile: {
      title: "Different account copies found",
      intro: "The copies of your account data on this device and on your services are not the same. The newest one is selected: it is the one most recently changed. No copy will be overwritten until you choose.",
      legend: "Which copy do you want to keep?",
      local: "This device",
      newest: "Newest copy",
      superseded: "Already included in a newer copy",
      modified: "Last changed",
      unknownDate: "date unknown",
      device: "device {{device}}",
      useNewest: "Use the newest copy",
      useSelected: "Use the copy of {{name}}",
      using: "Applying…",
      failed: "The copy could not be applied: {{error}}",
    },
  },
};

export default accountReconcileEn;
