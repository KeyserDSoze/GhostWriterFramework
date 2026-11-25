/** Texts of the tabs of a book's settings, loaded with that page (see `@/i18n/bookSettingsTabs`). */
const bookSettingsTabsEn = {
  bookSettings: {
    tabs: {
      label: "Sections of the book settings",
      general: "General",
      github: "GitHub",
      reader: "Online reader",
      export: "Export",
      audit: "Audit",
      discard: "Discard changes",
      unsaved: "Unsaved changes",
      opensNewTab: "(opens in a new tab)",
      auditHelp: "The audit reads the book against its canon and reports what does not agree. These settings are only for this book; the AI model is the one the Audit task route uses.",
      exportHelp: "Presets keep different typography and contents for different uses, such as a manuscript for a publisher or an ebook. They are used by the export page.",
      readerNeedsGitHub: "The online reader is published with GitHub Pages from the book's GitHub repository. This book lives only on this device, so it cannot have one yet: connect it to GitHub first.",
      goToGitHub: "Go to the GitHub tab",
      repositoryTitle: "Repository",
      repositoryDescription: "The GitHub repository this book is saved to.",
      branchDeviceDescription: "The working branch of a book that lives on this device exists only here.",
      localBranch: "Local working branch",
      onlyOnDevice: "only on this device",
      publishedAs: "published as {{branch}} on GitHub",
      branchOnConnect: "When you connect the book to GitHub, a new or empty repository gets this branch, with the book, as its default branch; a repository that already has commits keeps its branches and its default branch, where the book is published. From then on the working branch is a branch of that repository.",
    },
    tokenStatus: {
      appConnected: "Connected as {{user}} with the GitHub app.",
      appRenews: "Connected as {{user}} with the GitHub app. The 8-hour token renews itself.",
      appRenewsUntil: "Connected as {{user}} with the GitHub app. The token renews itself; the current one is valid until",
      appSessionUntil: "Connected as {{user}} with the GitHub app. This device does not keep the connection: the current token is valid until",
      appExpired: "Connected as {{user}} with the GitHub app, but the token has ended and cannot renew itself on this device. Reconnect GitHub.",
    },
  },
};

export default bookSettingsTabsEn;
