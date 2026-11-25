import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` while `enabled`: for what reads "4 minutes ago". A module of its own, free of the runtime's
 * loader, so that the launcher of the shell has it without the hooks of the autopilot's views.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
