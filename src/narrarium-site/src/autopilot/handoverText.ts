import type { TFunction } from "i18next";
import type { HandoverPlan } from "@/autopilot/handover";

const PHASE_KEYS: Record<Exclude<HandoverPlan["phase"], "armed" | "running-there">, string> = {
  pausing: "pausing",
  moving: "moving",
  starting: "starting",
  returning: "returning",
  done: "done",
  failed: "failed",
};

/** What a plan to pass the autopilot to the other side says of where it is, in words: the band's chip and the card of "Where it runs" say the same thing. */
export function handoverText(t: TFunction, plan: HandoverPlan): string {
  const base = "autopilot.quick.handover";
  const side = plan.to;
  if (plan.phase === "armed") return t(`${base}.${plan.returnAfterSteps ? "armedReturn" : "armed"}.${side}`);
  if (plan.phase === "running-there") return t(`${base}.runningThere.${side}`, { count: plan.returnAfterSteps ?? 1 });
  return t(`${base}.${PHASE_KEYS[plan.phase]}.${side}`);
}
