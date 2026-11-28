/** What a change of the Copilot says of its delivery to GitHub, and of a file that changed after it was proposed, bundled with the Copilot panel (see `@/i18n/copilotApply`). */
const copilotApplyEn = {
  copilotApply: {
    appliedSynced_one: "Applied and synchronised: 1 change of yours and {{count}} earlier one",
    appliedSynced_other: "Applied and synchronised: 1 change of yours and {{count}} earlier ones",
    undoneSynced_one: "Undone and synchronised: 1 change of yours and {{count}} earlier one",
    undoneSynced_other: "Undone and synchronised: 1 change of yours and {{count}} earlier ones",
    pulledToo_one: "{{count}} file from GitHub came in as well.",
    pulledToo_other: "{{count}} files from GitHub came in as well.",
    saved: {
      "no-credential": "It is saved on this device. GitHub is not connected, or does not accept the credential: connect it, and the next sync sends everything.",
      offline: "It is saved on this device. You are offline: the next sync sends it, with the rest of your work, when you are back online.",
      unreachable: "It is saved on this device. GitHub could not be reached: the next sync sends it, with the rest of your work.",
      "branch-unpublished": "It is saved on this device. This branch is not on GitHub yet: the next sync sends the branch and this change.",
      held: "It is saved on this device. Part of your work is still waiting to be sent: press Sync to send it.",
      failed: "It is saved on this device. The sync did not go through ({{reason}}): press Sync to try again; nothing is lost.",
    },
    conflictApplied: "Applied and saved on this device. The sync stopped on a conflict",
    conflictUndone: "Undone and saved on this device. The sync stopped on a conflict",
    conflict_one: "{{files}} changed on GitHub and here. The conflict window is open: choose which version to keep. The change is saved and nothing was overwritten.",
    conflict_other: "{{files}} changed on GitHub and here. The conflict window is open: choose which version to keep for each. The change is saved and nothing was overwritten.",
    openConflict: "Open the conflict window",
    openConflictLabel: "Open the conflict window of the sync",
    completedCounts: "Applied: {{applied}}; waiting: {{pending}}; stopped: {{failed}}.",
    failed: {
      changed: "{{file}} changed after the Copilot proposed this change. Nothing was changed: choose below, or ask the Copilot again.",
      undoChanged: "{{file}} changed after this change was applied, so it was not undone. Nothing was changed: edit it by hand, or ask the Copilot.",
      cancelled: "The operation was cancelled. Nothing was changed.",
      generic: "The change could not be applied, and nothing was changed. Try again, or ask the Copilot again.",
    },
    conflictChoice: {
      title: "A file changed after this proposal",
      "local-edits": "{{file}} has edits of yours that are not saved as a change yet, made after the Copilot proposed this. Keep your version, or use the proposal: your version stays available with Undo.",
      changed: "{{file}} changed after the Copilot proposed this change (here, or on GitHub). Keep the current version, or use the proposal: the current version stays available with Undo.",
      keepMine: "Keep mine",
      keepMineFor: "Keep mine: {{file}}",
      useProposal: "Use the proposal",
      useProposalFor: "Use the proposal: {{file}}",
      keptOne: "Kept your version of {{file}}: the proposal's change to it was dropped.",
      keptWhole: "Kept your version of {{file}}: the proposal was not applied.",
    },
  },
};

export default copilotApplyEn;
