import { cn } from "@/lib/utils";

/**
 * How far a book is, as a ring: a picture beside the words that say it («7 of 12 chapters»), never in their place, so it is hidden from screen
 * readers. Without a plan the ring is empty. It does not move by itself; a change of it is a short transition, and none for whoever asks the system
 * for less motion.
 */
export function ProgressRing({ ratio, size = 56, className }: { ratio: number | null; size?: number; className?: string }) {
  const stroke = 6;
  const center = size / 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const shown = ratio === null ? 0 : Math.min(1, Math.max(0, ratio));
  return (
    <svg data-hub-ring aria-hidden="true" focusable="false" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("shrink-0", className)}>
      {/* The track is a picture's background, not text: the ring is hidden from screen readers and its words are beside it. */}
      <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} className="stroke-muted" />
      {shown > 0 && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap={shown >= 1 ? "butt" : "round"}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - shown)}
          transform={`rotate(-90 ${center} ${center})`}
          className="text-primary transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      )}
      {ratio !== null && (
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="fill-foreground text-[13px] font-semibold tabular-nums">
          {`${Math.round(shown * 100)}%`}
        </text>
      )}
    </svg>
  );
}
