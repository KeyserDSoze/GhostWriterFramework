import { create } from "zustand";

/**
 * What the reader chose in the task views of the Autopilot page, for as long as the page is open: Raw (one choice for the page), the calls they opened,
 * and the messages of the running step they opened. A step that ends keeps them: its row opens on the same calls.
 */
interface CallsViewState {
  raw: boolean;
  /** The calls whose section is open, by call id; a call that is not here is open when it is the one that runs or the last of its step. */
  open: Record<string, boolean>;
  /** The steps whose messages the reader opened while they ran, by activity id. */
  live: Record<string, boolean>;
  /** Changes when the records of the book were deleted: every task view reads its step again. */
  epoch: number;
  setRaw(raw: boolean): void;
  setOpen(callId: string, open: boolean): void;
  setLive(activityId: string, open: boolean): void;
  deleted(): void;
}

export const useCallsView = create<CallsViewState>()((set) => ({
  raw: false,
  open: {},
  live: {},
  epoch: 0,
  setRaw: (raw) => set({ raw }),
  deleted: () => set((state) => ({ epoch: state.epoch + 1 })),
  setOpen: (callId, open) => set((state) => (state.open[callId] === open ? state : { open: { ...state.open, [callId]: open } })),
  setLive: (activityId, open) => set((state) => (state.live[activityId] === open ? state : { live: { ...state.live, [activityId]: open } })),
}));
