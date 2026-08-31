import { Shell } from "@/components/layout/Shell";
import { installAccountScopeIsolation } from "@/auth/accountScope";
import { installAccountDirtyPropagation } from "@/account/connectionStore";
import { installAutomaticAccountSync } from "@/account/accountSync";

installAccountScopeIsolation();
installAccountDirtyPropagation();
installAutomaticAccountSync();

export function AppShellRoute() {
  return <Shell />;
}
