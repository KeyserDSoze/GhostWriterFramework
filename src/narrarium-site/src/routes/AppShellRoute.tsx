import { useEffect, useState } from "react";
import { Shell } from "@/components/layout/Shell";
import { installAccountScopeIsolation } from "@/auth/accountScope";
import { installAccountDirtyPropagation } from "@/account/connectionStore";
import { installAutomaticAccountSync } from "@/account/accountSync";

const accountScopeReady = installAccountScopeIsolation();
installAccountDirtyPropagation();
installAutomaticAccountSync();

export function AppShellRoute() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void accountScopeReady.then((result) => {
      if (!active) return;
      if (result.error) setError(result.error);
      else setReady(true);
    });
    return () => { active = false; };
  }, []);
  if (error) return <div role="alert" className="m-6 space-y-3"><p>Local workspace upgrade failed. Reload Narrarium to retry safely.</p><button type="button" className="underline" onClick={() => window.location.reload()}>Reload</button></div>;
  if (!ready) return null;
  return <Shell />;
}
