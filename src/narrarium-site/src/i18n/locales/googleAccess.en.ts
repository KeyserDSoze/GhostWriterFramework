/** Texts of the extra Google permission and of the Google configuration check (see `@/i18n/googleAccess`). */
const googleAccessEn = {
  googleAccess: {
    full: {
      title: "Full access to your Google Drive is needed for this",
      body: "Narrarium asks Google only for the files and folders it creates itself, so that it can never read the rest of your Drive. {{reason}} To go on, Google has to give Narrarium access to all the files of your Drive. Google calls that a restricted permission and will warn you that this app is not verified for it. You can allow it just for now (it is kept only while this page is open) and take it back at myaccount.google.com/connections.",
      reason: {
        export: "The folder you chose was there before Narrarium, so Google does not show it to Narrarium.",
        browse: "Google shows Narrarium only the folders it created.",
        legacy: "The chats of the older version may be in a folder that Google does not show to Narrarium.",
      },
      allow: "Allow full access to Drive",
      allowing: "Waiting for Google…",
      dismiss: "Not now",
      granted: "Full access to Drive is allowed until you close this page.",
      error: {
        unavailable: "Google sign-in is not loaded yet. Wait a moment and try again.",
        denied: "Google did not give the access (it was refused or the permission was not ticked). Nothing changed.",
        "popup-blocked": "The browser blocked Google's window. Allow pop-ups for this site and try again.",
        failed: "Google could not give the access. Try again in a moment.",
      },
    },
    folders: {
      note: "Narrarium shows the folders it created. A folder that was already in your Drive is hidden by Google.",
      showAll: "Show all my folders…",
      showingAll: "All your folders are shown, with the full access you allowed for now.",
      fullToken: "Full access is allowed for now, so every folder is listed.",
    },
    folderAccess: {
      title: "Narrarium cannot use this folder",
      body: "Google does not let Narrarium write into a folder it did not create. Choose a folder Narrarium created, or allow full access to Drive for this export.",
    },
    legacy: {
      intro: "Recover conversations kept in the old Google Drive/Narrarium/chats folder. The import never changes the original files.",
      notFound: "No older chats were found with the access Narrarium has. If you used an older version, they may be in a folder that Google hides from Narrarium.",
    },
    check: {
      title: "Check Google configuration",
      open: "Check Google configuration",
      close: "Hide the check",
      intro: "What this site will ask Google for, and what to look at in the Google Cloud project if signing in fails. Nothing secret is shown.",
      scopes: "Permissions asked at every sign-in",
      scope: {
        openid: "openid — who you are",
        profile: "profile — your name and picture",
        email: "email — your address",
        appdata: "drive.appdata — a hidden app folder (non-sensitive)",
        file: "drive.file — the files and folders Narrarium creates (non-sensitive)",
      },
      includeGranted: "Earlier permissions: not added (include_granted_scopes = false). The consent is for the list above and nothing else, even if this account allowed more under an older version.",
      notAsked: "Never asked at sign-in: full access to Drive (the restricted “drive” scope). It is asked only if you choose it.",
      client: "Client id of this build",
      clientValue: "Project number {{project}} (the rest of the id is not shown)",
      clientUnknown: "The client id could not be read.",
      checklist: "If you own the Google Cloud project",
      items: {
        audience: "Audience: Publishing status must be “In production”. In “Testing” Google also shows the “unverified app” screen (test users can continue with “Advanced”) and the sign-in expires after 7 days.",
        project: "Client: the OAuth client id of this build must belong to that project (the number above must match the project number in the console).",
        scopes: "Data access: the scopes in the console must match the list above. drive.appdata and drive.file need no verification; a restricted scope such as drive does.",
        origins: "Authorized JavaScript origins: the address of this site, exactly.",
        grants: "If the warning still appears, remove the previous access of Narrarium at myaccount.google.com/connections, then sign in again.",
      },
      proxy: "Staying signed in for months works only if the auth proxy serves Google: this page says which kind of sign-in is in use in the Google card.",
    },
  },
};

export default googleAccessEn;
