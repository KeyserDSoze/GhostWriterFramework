/**
 * Which task the calls of a request belong to, by the signal of the request: the Copilot's turn gives its signal (the author's Stop) to every routed call it
 * makes, tools and confirmations included, so the signal is the address of the turn, as it is for the notices of its retries (`retryNotice.ts`). A call
 * whose signal names no task is a task of its own.
 */
export interface UsageTask {
  task: string;
  origin: "copilot";
}

const tasks = new WeakMap<AbortSignal, UsageTask>();

/** The calls made with `signal` are one task (one turn of the Copilot, its whole tool loop): what `usageTaskOf` answers until the result is called. */
export function beginUsageTask(signal: AbortSignal, task: UsageTask): () => void {
  tasks.set(signal, task);
  return () => {
    if (tasks.get(signal) === task) tasks.delete(signal);
  };
}

export function usageTaskOf(signal: AbortSignal | undefined): UsageTask | undefined {
  return signal ? tasks.get(signal) : undefined;
}

const OWN_CALL = "call-";

/** The task of a call that belongs to no task (`createBrowserAi`): a task of its own, its attempts and fallbacks included. */
export function ownCallTask(): string {
  return `${OWN_CALL}${crypto.randomUUID()}`;
}

/** Whether a task is the one of a single call, not one a caller named (an autopilot step, a turn of the Copilot). */
export function isOwnCallTask(task: string): boolean {
  return task.startsWith(OWN_CALL);
}
