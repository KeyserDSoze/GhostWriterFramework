/** The texts of the frozen chapters that the Copilot shows with a proposal that changes one, bundled with the Copilot panel (see `@/i18n/frozenCopilot`). */
const frozenCopilotIt = {
  frozen: {
    copilot: {
      ask: "Il capitolo {{number}} è congelato: dopo la modifica ti verrà chiesto se rivederlo.",
      auto: "Il capitolo {{number}} è congelato: dopo la modifica l'autopilot lo rivedrà e aggiornerà il libro da questa modifica, senza chiedere (come dice la sua Configurazione).",
      notify: "Il capitolo {{number}} è congelato: dopo la modifica l'autopilot la segnalerà soltanto, senza rivederlo.",
      unfrozen: "Il capitolo {{number}} è congelato: questa modifica gli toglie il congelamento, e le sue modifiche successive non verranno più notate.",
    },
  },
};

export default frozenCopilotIt;
