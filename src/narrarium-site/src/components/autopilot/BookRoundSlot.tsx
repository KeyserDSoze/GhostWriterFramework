import { Suspense, lazy } from "react";
import type { AutopilotState } from "narrarium-engine";
import { bookRoundOf } from "@/autopilot/bookRound";
import { withAutopilotTranslations } from "@/i18n/autopilot";

// The panel of the corrections of the whole book is a chunk of its own: nothing of it is loaded until a review is in a book-level round.
const BookRoundPanel = lazy(withAutopilotTranslations(() => import("@/components/autopilot/result/BookRound").then((module) => ({ default: module.BookRoundPanel }))));

/**
 * Where the live page shows the corrections of the whole book (#113) while a review of the book is in a book-level round: what the author is asked when the round waits for them,
 * and where the round stands otherwise. It reads the state the page already has, loads the panel only when there is a round in progress, and draws nothing otherwise.
 */
export function BookRoundSlot({ bookId, state, linkedSlugs }: { bookId: string; state: Pick<AutopilotState, "campaign" | "plan"> | null; linkedSlugs: ReadonlySet<string> }) {
  if (!state || !bookRoundOf(state)) return null;
  return (
    <Suspense fallback={null}>
      <BookRoundPanel bookId={bookId} state={state} linkedSlugs={linkedSlugs} />
    </Suspense>
  );
}
