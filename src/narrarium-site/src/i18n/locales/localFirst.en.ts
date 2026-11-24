/** Texts of a book that lives on this device or cannot reach GitHub right now, bundled with the app shell (see `@/i18n/localFirst`): the public pages do not download them. */
const localFirstEn = {
  localFirst: {
    deviceOnly: "This device only",
    pillLocalOnly: "Local only",
    openBookSettings: "Book settings",
    repositoryMenuLocal: "This book is kept on this device: fetch, pull and push need GitHub. Connect it to GitHub from the book settings.",
    repositoryMenuOffline: "You are offline: fetch, pull and push resume when the connection is back.",
    repositoryMenuNoCredential: "This book has no GitHub credential on this device: it works here, and fetch, pull and push need GitHub. Connect GitHub to use them.",
    savedLocally: "Book saved locally",
    savedOffline: "Saved on this device. It will be synced with GitHub when you are back online.",
    savedNoCredential: "Saved on this device. Connect GitHub to sync it.",
    gitFeaturesLocal: "Commit history and pull requests need GitHub. Connect this book to GitHub from its settings to use them.",
    gitFeaturesOffline: "You are offline: commit history and pull requests need GitHub.",
    gitFeaturesNoCredential: "Commit history and pull requests need GitHub: connect GitHub to use them.",
    branchesLocal: "Branches live on GitHub. Connect this book to GitHub to use them.",
    branchesOffline: "You are offline: branches need GitHub.",
    githubNeeded: "This needs GitHub: connect the book to GitHub to use it.",
    githubNeededOffline: "You are offline: this needs GitHub.",
    githubNeededNoCredential: "This needs GitHub: connect GitHub to use it.",
    localBookOnAnotherDevice: "This book is kept on another device. Open it there, or connect it to GitHub from that device to use it here too.",
    notDownloadedOffline: "This book is not on this device yet. Connect to the internet to download it from GitHub.",
    notDownloadedNoCredential: "This book is not on this device yet: connect GitHub to download it.",
    branchNotDownloadedNoCredential: "The branch {{branch}} of this book is not on this device: connect GitHub to download it.",
    branchNotDownloadedOffline: "The branch {{branch}} of this book is not on this device: connect to the internet to download it from GitHub.",
    incompleteNoCredential: "The copy of this book on this device is incomplete: connect GitHub to finish downloading it.",
    incompleteOffline: "The copy of this book on this device is incomplete: connect to the internet to finish downloading it.",
    connectGitHub: "Connect GitHub",
  },
};

export default localFirstEn;
