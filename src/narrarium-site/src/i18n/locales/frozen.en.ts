/** Texts of the frozen chapters, bundled with the views that show them (see `@/i18n/frozen`): the app entry does not carry them. */
const frozenEn = {
  frozen: {
    badge: {
      autopilot: "Frozen on {{date}} by the autopilot",
      author: "Frozen on {{date}} by you",
      help: "A frozen chapter keeps a record of its text: when you change it, the autopilot asks you what to do.",
      problem: "The freeze record of this chapter cannot be read, so it counts as not frozen: correct chapter.md, or freeze it again.",
    },
    toggle: {
      freeze: "Freeze chapter",
      unfreeze: "Unfreeze chapter",
    },
    unfreeze: {
      title: "Unfreeze this chapter?",
      description: "The autopilot will no longer notice your changes to it, and a decision that waits for it is dropped. You can freeze it again at any time.",
      confirm: "Unfreeze",
    },
    change: {
      title: "You changed this chapter after it was frozen",
      intro: "What should the autopilot do with your change?",
      modified: "Changed: {{list}}.",
      added: "Added: {{list}}.",
      removed: "Removed: {{list}}.",
      body: "The text of the chapter page changed.",
      queuedAi: "A review calls the AI: it waits in a queue, and the autopilot does it at its next run.",
      notInPlan: "The autopilot has no plan for this chapter: you can only mark it as reviewed.",
      inHands: "The autopilot is working on this chapter now: it freezes it again when it is done, and asks you about any change it did not make.",
      checking: "Checking what can be done with your change…",
    },
    actions: {
      "review-and-update": "Review and update the book from this change",
      "review-only": "Only a review of the chapter",
      "mark-reviewed": "Mark as reviewed",
      "rewrite-to-outline": "Rewrite the chapter to follow the Outline",
      "keep-text": "Keep the text, update only the Outline",
    },
    actionHelp: {
      "review-and-update": "The director reads the chapter again and the autopilot updates the later chapters that no longer fit. Your text is not rewritten.",
      "review-only": "Only the director's judgement of the chapter: nothing else changes.",
      "mark-reviewed": "The chapter is frozen again as it is. No AI call.",
      "rewrite-to-outline": "The autopilot rewrites the chapter to follow its new entry, then checks the later chapters.",
      "keep-text": "The plan follows the new entry; the chapter's text stays as it is. No AI call.",
    },
    queued: {
      title: "Queued: {{action}}",
      next: "The autopilot does it at its next run.",
      running: "The autopilot is running: it does it at its next step.",
      start: "Start now",
      follow: "Follow it in Live",
    },
    done: {
      reviewed: "Marked as reviewed: the chapter is frozen again as it is.",
      queued: "Your decision is queued: the autopilot carries it out at its next run.",
      frozen: "The chapter is frozen.",
      unfrozen: "The chapter is not frozen any more.",
    },
    server: {
      unsupported: "Your personal server is older than {{version}} and does not know frozen chapters: update it to decide about them from here.",
    },
  },
};

export default frozenEn;
