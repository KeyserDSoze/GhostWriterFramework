import { useEffect, useState } from "react";
import { brokerAvailabilitySnapshot, brokerAvailable, type BrokerProvider } from "@/account/credentialBroker";

/**
 * Whether the broker serves a provider: null while that is still being asked, then true or false.
 * The answer is looked up on mount, never inside a click handler, so a click can choose its sign-in flow at once and
 * the browser still sees the pop-up as the user's own doing. Until it is known, the usual flow applies.
 */
export function useBrokerAvailability(provider: BrokerProvider): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(() => brokerAvailabilitySnapshot(provider) ?? null);
  useEffect(() => {
    let active = true;
    void brokerAvailable(provider).then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, [provider]);
  return available;
}
