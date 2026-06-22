import { create } from "zustand";

export interface DossierEntry {
  id: string;
  title: string;
  section: string;
  path: string;
  content: string;
}

interface DossierState {
  dossiers: DossierEntry[];
  pinDossier: (entry: DossierEntry) => void;
  closeDossier: (id: string) => void;
  clearDossiers: () => void;
}

export const useDossierStore = create<DossierState>((set) => ({
  dossiers: [],
  pinDossier: (entry) =>
    set((state) => ({
      dossiers: [entry, ...state.dossiers.filter((current) => current.id !== entry.id)].slice(0, 5),
    })),
  closeDossier: (id) => set((state) => ({ dossiers: state.dossiers.filter((entry) => entry.id !== id) })),
  clearDossiers: () => set({ dossiers: [] }),
}));
