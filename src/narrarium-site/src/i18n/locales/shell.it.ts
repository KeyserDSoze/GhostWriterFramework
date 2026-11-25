/**
 * Testi del guscio su un telefono (il menu a cassetto), della barra di salvataggio delle impostazioni e del pulsante dell'autopilot (quanti autopilot
 * sono in esecuzione e quanti aspettano l'autore), caricati con il guscio dell'app (vedi `@/i18n/shell`).
 */
const shellIt = {
  shortcuts: {
    items: {
      annotate: "Annota il passaggio selezionato nel reader",
    },
  },
  nav: {
    annotations: "Annotazioni",
    annotationTags: "Etichette delle annotazioni",
  },
  shell: {
    navMenu: "Menu di navigazione",
  },
  settingsBar: {
    label: "Salvataggio delle impostazioni",
    unsaved: "Modifiche non salvate",
    saving: "Salvataggio…",
    saved: "Tutte le modifiche salvate",
    failed: "Non salvato: {{reason}}",
  },
  autopilot: {
    launcherRunning_one: "{{count}} autopilot in esecuzione",
    launcherRunning_other: "{{count}} autopilot in esecuzione",
    launcherAttention_one: "{{count}} ti aspetta",
    launcherAttention_other: "{{count}} ti aspettano",
  },
};

export default shellIt;
