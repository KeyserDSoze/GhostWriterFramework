import { create } from "zustand";

export interface GenerateProposal {
  title: string;
  oldText: string;
  newText: string;
  apply: () => Promise<void>;
}

type MakeProposal = () => Promise<GenerateProposal>;

interface GenerateDiffState {
  open: boolean;
  loading: boolean;
  title: string;
  oldText: string;
  newText: string;
  error: string | null;
  make: MakeProposal | null;
  proposal: GenerateProposal | null;
  onApplied: (() => void) | null;
  start: (make: MakeProposal, onApplied?: () => void) => Promise<void>;
  regenerate: () => Promise<void>;
  apply: () => Promise<void>;
  close: () => void;
}

export const useGenerateDiffStore = create<GenerateDiffState>((set, get) => ({
  open: false,
  loading: false,
  title: "",
  oldText: "",
  newText: "",
  error: null,
  make: null,
  proposal: null,
  onApplied: null,
  start: async (make, onApplied) => {
    set({ open: true, loading: true, error: null, make, onApplied: onApplied ?? null, oldText: "", newText: "", title: "", proposal: null });
    await get().regenerate();
  },
  regenerate: async () => {
    const make = get().make;
    if (!make) return;
    set({ loading: true, error: null });
    try {
      const proposal = await make();
      set({ loading: false, proposal, title: proposal.title, oldText: proposal.oldText, newText: proposal.newText });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
  apply: async () => {
    const proposal = get().proposal;
    if (!proposal) return;
    set({ loading: true });
    try {
      await proposal.apply();
      const onApplied = get().onApplied;
      set({ open: false, loading: false, proposal: null, make: null });
      onApplied?.();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
  close: () => set({ open: false, loading: false, make: null, proposal: null }),
}));
