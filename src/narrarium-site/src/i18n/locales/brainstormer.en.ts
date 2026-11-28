/** Texts of the page of the Brainstormer, bundled with it (see `@/i18n/brainstormer`). */
const brainstormerEn = {
  brainstormerPage: {
    title: "Brainstormer",
    description: "The co-author of the design: it proposes alternative pitches from your idea, develops the structure of the book and rewrites the weak parts of the design in its own voice. The design run reads this sheet; the file is brainstormer.md.",
    defaults: "This book has no Brainstormer of its own yet: the one shown is the default. Save it to keep it in the book.",
    loadFailed: "The Brainstormer could not be read.",
    saved: "The Brainstormer is saved.",
    saveFailed: "The Brainstormer could not be saved.",
    changedElsewhere: "The file changed elsewhere. Reload it to see the new version; your changes are kept until you do.",
    reload: "Reload the file",
    sections: { identity: "Who it is", boldness: "How bold it is", cares: "What it cares about and what it refuses", method: "Its method" },
    name: "Name",
    language: "Language",
    languageHint: "A code such as en or it. The design is written in the language of the book whatever this says.",
    persona: "Persona",
    personaHint: "Voice and temperament: how it argues, what it is like to work with.",
    boldness: {
      label: "Boldness",
      value: "{{value}} out of 10, {{caption}}",
      help: "How far it goes from what the idea and the genre expect: low keeps to them, high questions the premise and proposes what nobody expects.",
      scale: { low: "Prudent", middle: "Balanced", high: "Daring" },
      captions: { prudent: "keeps to what the genre expects", balanced: "takes a risk where it makes the book better", daring: "questions the premise and dares more", breaking: "proposes the version nobody would write" },
      asNumber: "Boldness as a number",
    },
    priorities: "Priorities, in order",
    avoid: "Clichés and devices it refuses",
    listHint: "One per line.",
    method: "Notes of method",
    methodHint: "Free rules in Markdown: how it works, what it always does first.",
    bar: { label: "Save the Brainstormer", saved: "The Brainstormer is saved", unsaved: "The Brainstormer has changes", defaults: "The default Brainstormer: not in the book yet", saving: "Saving the Brainstormer…", failed: "The Brainstormer could not be saved: {{reason}}", conflict: "The file changed elsewhere and was not saved over.", discard: "Discard changes" },
    save: "Save the Brainstormer",
    open: "Open the design",
  },
};

export default brainstormerEn;
