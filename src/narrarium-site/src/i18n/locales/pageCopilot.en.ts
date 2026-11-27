/** Texts of the page-aware Copilot (the page it works on, the review of a proposal for a page), bundled with the Copilot panel (see `@/i18n/pageCopilot`). */
const pageCopilotEn = {
  pageCopilot: {
    workingOn: "Working on: {{page}}",
    workingOnHint: "Requests are about this page first; everything else the Copilot can do stays available.",
    pages: {
      readers: "Simulated readers",
      ghostwriters: "Ghostwriters",
      director: "Director",
      "evaluation-style": "Evaluation style",
      "autopilot-settings": "Autopilot configuration",
      canon: "Canon",
      assets: "Assets",
    },
    review: {
      title: { default: "Proposed changes", readers: "Proposed changes to the simulated readers" },
      item: { default: "Item", readers: "Reader" },
      caption: "{{title}}: every item with its state after the change ({{changed}} changing, {{count}} in all)",
      state: "On / off",
      change: "Change",
      on: "On",
      off: "Off",
      none: "None",
      becomes: "becomes",
      builtin: "built-in",
      kept: "Built-in: turned off, never deleted",
      changes: { created: "Created", edited: "Edited", "turned-on": "Turned on", "turned-off": "Turned off", removed: "Removed", unchanged: "No change" },
      counts: {
        created_one: "{{count}} created",
        created_other: "{{count}} created",
        edited_one: "{{count}} edited",
        edited_other: "{{count}} edited",
        "turned-on_one": "{{count}} turned on",
        "turned-on_other": "{{count}} turned on",
        "turned-off_one": "{{count}} turned off",
        "turned-off_other": "{{count}} turned off",
        removed_one: "{{count}} removed",
        removed_other: "{{count}} removed",
      },
      after: "after it: {{on}} on of {{total}}",
      nothing: "Nothing changes",
      apply: "Apply",
      discard: "Discard",
      undo: "Undo",
      appliedBadge: "Applied",
      applied: "Applied: {{summary}}.",
      undone: "Undone: everything is as it was before.",
      discarded: "Discarded: nothing was changed.",
      fields: {
        name: "name", description: "description", profile: "profile", aspects: "aspects", preferredGenres: "preferred genres", dislikedGenres: "disliked genres",
        experienceLevel: "experience", severity: "severity", audienceAge: "audience age", interests: "interests", appreciatedElements: "appreciated elements",
        frequentCriticisms: "frequent criticisms", customPrompt: "custom prompt",
      },
    },
  },
  copilotTools: {
    tools: {
      "edit-page": {
        name: "Change This Page",
        description: "Proposes one batch of changes to the page you are on: on Simulated readers, readers created (several at once), edited, turned on or off and removed; built-in readers are turned off, never deleted. You see every item with its resulting state, apply the batch in one change, and can undo it.",
        output: "Reviewable list of every item with its resulting state",
      },
    },
  },
};

export default pageCopilotEn;
