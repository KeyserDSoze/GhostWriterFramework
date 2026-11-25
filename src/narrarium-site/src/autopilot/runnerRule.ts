/**
 * The engine's rule for a runner that is still alive, in a module of its own: the launcher of the shell, which does not carry the engine's session,
 * loads it only when a book says that it runs (see `useActiveBooks`).
 */
export { runnerActivity } from "narrarium-engine";
