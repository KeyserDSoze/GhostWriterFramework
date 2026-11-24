/** Texts of the branches that the shell of the app shows (see `@/i18n/branchesShell`): which branch a book opened on and why. */
const branchesShellEn = {
  branchesShell: {
    personalBranch: "your personal branch",
    adopted: {
      title: "Opened the branch {{branch}}",
      description: "It is the branch you worked on last, on another device. This device was on {{previous}}.",
    },
    notAdopted: {
      title: "The branch {{branch}} was not opened",
      gone: "{{branch}}, the branch you worked on last on another device, is not on GitHub (or not yet): this book stays on {{previous}}.",
      "needs-github": "{{branch}}, the branch you worked on last on another device, is not on this device, and downloading it needs GitHub: this book stays on {{previous}}.",
      failed: "{{branch}}, the branch you worked on last on another device, could not be opened here: this book stays on {{previous}}.",
    },
  },
};

export default branchesShellEn;
