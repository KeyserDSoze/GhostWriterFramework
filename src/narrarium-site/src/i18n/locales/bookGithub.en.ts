/** Texts of the card that connects a local book to GitHub, in the settings of the book, loaded with that page (see `@/i18n/bookGithub`). */
const bookGithubEn = {
  bookSettings: {
    loadRemoteBranches: "Load remote branches",
    deviceOnly: "This device only",
    connectGithub: {
      title: "Connect this book to GitHub",
      description: "The existing local working copy will be retained and published to a private repository.",
      owner: "Owner",
      repository: "Repository",
      overwrite: "Overwrite existing repository",
      overwriteHint: "If the repository is not empty, its branch will be replaced by this local book.",
      submit: "Create or connect private repository",
      noToken: "Connect GitHub or configure a PAT.",
      done: "Book connected to GitHub",
    },
  },
};

export default bookGithubEn;
