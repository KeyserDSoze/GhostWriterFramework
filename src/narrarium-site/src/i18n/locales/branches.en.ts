/** Texts of the branches that load with the branch sync and the switcher (see `@/i18n/branches`): the shell of the app does not carry them. */
const branchesEn = {
  branches: {
    outcome: {
      divergedTitle: "GitHub and this device both changed {{branch}}",
      diverged: "Nothing was overwritten. Sync to bring the two together: if the same file changed on both sides, you choose which version to keep.",
      syncNow: "Sync now",
      goneTitle: "{{branch}} is no longer on GitHub",
      gone: "The copy on this device is kept, with its changes. To publish them, create a new branch from it.",
      nameTakenTitle: "A branch named {{branch}} is already on GitHub",
      nameTaken: "It has other changes, so this branch was not published and nothing was overwritten. Create a branch with another name from it to publish it.",
      failedTitle: "The automatic sync of {{branch}} failed",
      failed: "{{reason}} It will try again later.",
    },
  },
};

export default branchesEn;
