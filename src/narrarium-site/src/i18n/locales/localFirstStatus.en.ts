/** Texts of the repository status of a book that lives on this device or cannot reach GitHub right now: they load with the dialog (see `@/i18n/localFirstStatus`), not with the shell of the app. */
const localFirstStatusEn = {
  localFirst: {
    statusLocal: "This book is kept on this device: sync, fetch, pull, push and re-clone need GitHub. Connect it to GitHub from the book settings; until then, export a backup to keep a copy elsewhere.",
    statusOffline: "You are offline: the actions that need GitHub resume when the connection is back. Your changes stay on this device.",
    statusNoCredential: "This book has no GitHub credential on this device: you read, write and save it here, as local commits. Sync, fetch, pull, push and re-clone need GitHub: connect GitHub, and the next sync publishes what you saved.",
    diffUnavailable: "Diff not available",
    diffBinary: "Binary file: diff not available",
    diffNoBase: "The previous version of this file is not kept on this device, so it cannot be compared.",
    diffOffline: "The previous version of this file is on GitHub: connect to the internet to compare it.",
    restoreNoBase: "Only new files can be undone in a book kept on this device: the previous version of the other files is not kept.",
    restoreNoCredential: "The previous version of a changed file is on GitHub: connect GitHub to undo it. New files can be undone here.",
    restoreOffline: "The previous version of a changed file is on GitHub: connect to the internet to undo it. New files can be undone here.",
    selectAll: "Select all",
    clearSelection: "Clear selection",
    restoreSelected: "Restore selected",
    restoredFiles: "Restored {{count}} files",
    selectForRestore: "Select {{path}} to restore it",
    showDiff: "Show diff",
    hideDiff: "Hide diff",
    exportRecovery: "Export",
    deleteRecovery: "Delete",
    deleteRecoveryConfirm: "Delete the recovery of {{date}}?",
    recoveryDeleted: "Recovery deleted",
  },
};

export default localFirstStatusEn;
