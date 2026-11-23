import { useCallback, useEffect } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
import { isNavDrawerMove } from "@/components/layout/navDrawerStep";
import { useSaveStore } from "@/store/saveStore";

export function useDirtyNavigationGuard(message: string) {
  const dirty = useSaveStore((state) => Boolean(state.current?.dirty));
  // Opening and closing the menu of a phone takes a step in the history on the same page: it leaves nothing, so it asks nothing.
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => dirty && !isNavDrawerMove(currentLocation, nextLocation), [dirty]);
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);
}
