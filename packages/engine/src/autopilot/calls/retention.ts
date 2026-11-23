/** What the retention policy needs of a task: its size, its pin, whether it runs, and when it started. Never its texts. */
export interface RetentionTask {
  activityId: string;
  bytes: number;
  pinned: boolean;
  running: boolean;
  /** ISO time: the order of the tasks (oldest first). */
  startedAt: string;
}

/** What the policy decided: the tasks to drop, oldest first, and what is kept. */
export interface RetentionPlan {
  drop: string[];
  bytes: number;
  droppedBytes: number;
  pinnedTasks: number;
  pinnedBytes: number;
  /** The pinned and running tasks alone exceed the budget: nothing else can be dropped. */
  overBudget: boolean;
}

/**
 * The retention of a book's calls, as a pure function: when the tasks keep more than `budget` bytes, the oldest unpinned tasks that are not running
 * are dropped, whole, until they keep no more than the budget. Pinned tasks count against the budget but are never dropped. The sort is by
 * `startedAt` then `activityId`, so the same tasks always give the same plan. The cost is O(n log n) in the number of tasks, and no text is read or
 * copied: the input is only headers.
 */
export function planRetention(tasks: readonly RetentionTask[], budget: number): RetentionPlan {
  let bytes = 0;
  let pinnedTasks = 0;
  let pinnedBytes = 0;
  for (const task of tasks) {
    bytes += task.bytes;
    if (task.pinned) {
      pinnedTasks += 1;
      pinnedBytes += task.bytes;
    }
  }
  const plan: RetentionPlan = { drop: [], bytes, droppedBytes: 0, pinnedTasks, pinnedBytes, overBudget: false };
  if (bytes > budget) {
    const candidates = tasks.filter((task) => !task.pinned && !task.running);
    candidates.sort((left, right) => (left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : left.activityId < right.activityId ? -1 : left.activityId > right.activityId ? 1 : 0));
    for (const task of candidates) {
      if (plan.bytes <= budget) break;
      plan.drop.push(task.activityId);
      plan.bytes -= task.bytes;
      plan.droppedBytes += task.bytes;
    }
  }
  plan.overBudget = plan.bytes > budget;
  return plan;
}
