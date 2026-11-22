import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A card of the pages of the autopilot. One with an `id` is one that a link can bring into view and give the focus to: it is named after its
 * title (a region), so that what takes the focus says where it is. A `quiet` card is a secondary one: a smaller title, a soft edge and no
 * shadow, so that the main things of the page are what the eye finds first.
 */
export function Card({ title, icon, actions, children, className, id, quiet = false }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; quiet?: boolean }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} aria-labelledby={id ? `${id}-title` : undefined} className={cn("space-y-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring", quiet ? "rounded-xl border bg-card/60 p-3" : "rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id ? `${id}-title` : undefined} className={cn("flex items-center gap-2 font-semibold", quiet ? "text-sm" : "text-base")}>{icon}{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
