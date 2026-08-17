import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { useSaveStore } from "@/store/saveStore";

export function useDirtyNavigationGuard(message: string) {
  const dirty = useSaveStore((state) => Boolean(state.current?.dirty));
  const blocker = useBlocker(dirty);

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
