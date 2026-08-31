import { useEffect } from "react";
import { saveLocalAccountCosts } from "@/account/accountLocalStore";
import { useCostsStore } from "@/costs/costsStore";

/** Keeps the account IndexedDB replica current; provider failures never affect recording. */
export function useCostsSync() {
  const revision = useCostsStore((state) => state.revision);
  useEffect(() => {
    if (revision === 0) return;
    void saveLocalAccountCosts(useCostsStore.getState().file).catch(() => undefined);
  }, [revision]);
}
