/** The texts of the frozen chapters that the Copilot shows with a proposal that changes one, bundled with the Copilot panel (see `@/i18n/frozenCopilot`). */
const frozenCopilotEn = {
  frozen: {
    copilot: {
      ask: "Chapter {{number}} is frozen: after the change you will be asked whether to review it.",
      auto: "Chapter {{number}} is frozen: after the change the autopilot will review it and update the book from it, without asking (as its Configuration says).",
      notify: "Chapter {{number}} is frozen: after the change the autopilot will only report it, without reviewing it.",
      unfrozen: "Chapter {{number}} is frozen: this change takes its freeze away, and its later changes will no longer be noticed.",
    },
  },
};

export default frozenCopilotEn;
