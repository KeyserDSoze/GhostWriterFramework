/**
 * Texts of the shell on a phone (the menu drawer), of the save bar of the settings and of the autopilot launcher (how many autopilots run, and how
 * many wait for the author), bundled with the app shell (see `@/i18n/shell`): the public pages do not download them.
 */
const shellEn = {
  shortcuts: {
    items: {
      annotate: "Annotate the passage selected in the reader",
    },
  },
  nav: {
    annotations: "Annotations",
    annotationTags: "Annotation tags",
  },
  shell: {
    navMenu: "Navigation menu",
  },
  settingsBar: {
    label: "Saving the settings",
    unsaved: "Unsaved changes",
    saving: "Saving…",
    saved: "All changes saved",
    failed: "Not saved: {{reason}}",
  },
  autopilot: {
    launcherRunning_one: "{{count}} autopilot running",
    launcherRunning_other: "{{count}} autopilots running",
    launcherAttention_one: "{{count}} needs you",
    launcherAttention_other: "{{count}} need you",
  },
};

export default shellEn;
