/**
 * The CPU time, in milliseconds, that `work` takes on this process. A test that says «this is fast» (it was quadratic once) measures the work, not the clock: on a busy machine the
 * clock stretches with every other process that wants the processor, the work does not (much), so a budget in CPU time says the same on a quiet machine and a busy one.
 */
export function cpuMs(work: () => void): number {
  const before = process.cpuUsage();
  work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}
