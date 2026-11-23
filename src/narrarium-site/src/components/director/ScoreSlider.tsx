import { useId, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCount } from "@/autopilot/format";
import { SLIDER_PAGE, SLIDER_STEP, profileScore } from "@/director/sheetModel";

export interface ScoreSliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** What the slider says of its value, in words (`aria-valuetext`): «7 out of 10, Strict». */
  valueText: string;
  /** The word for the value, beside it. */
  caption: string;
  /** The words under the two ends and the middle of the scale. */
  scale: readonly [string, string, string];
  /** The name of the field that takes the number. */
  numberLabel: string;
  /** What the value is for, read with the slider. */
  help?: string;
}

/** From a value that is not on the half points (7.3, written in the file), an arrow goes to the nearest half point in its direction. */
function nextHalf(value: number, step: number): number {
  const grid = Math.abs(step);
  const units = value / grid;
  if (Math.abs(units - Math.round(units)) < 1e-9) return value + step;
  return (step > 0 ? Math.ceil(units) : Math.floor(units)) * grid;
}

/**
 * A score of the director from 1 to 10 as a slider, with the value in words for whoever cannot see it (`aria-valuetext`), the words of the scale
 * under it, and a field for the number beside it, for whoever prefers to write it. The keys are the slider's: the arrows move by half a point,
 * Page Up and Page Down by one, Home and End to the ends. The value keeps one decimal, as the engine reads it.
 */
export function ScoreSlider({ label, value, onChange, valueText, caption, scale, numberLabel, help }: ScoreSliderProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const set = (next: number) => onChange(profileScore(next));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, () => number> = {
      ArrowRight: () => nextHalf(value, SLIDER_STEP),
      ArrowUp: () => nextHalf(value, SLIDER_STEP),
      ArrowLeft: () => nextHalf(value, -SLIDER_STEP),
      ArrowDown: () => nextHalf(value, -SLIDER_STEP),
      PageUp: () => value + SLIDER_PAGE,
      PageDown: () => value - SLIDER_PAGE,
      Home: () => 1,
      End: () => 10,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    set(move());
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <Label htmlFor={`${id}-range`}>{label}</Label>
        <span aria-hidden="true" className="text-sm font-semibold tabular-nums">{formatCount(value)}/10 · {caption}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          id={`${id}-range`}
          type="range"
          min={1}
          max={10}
          step={SLIDER_STEP}
          value={value}
          aria-valuetext={valueText}
          aria-describedby={help ? `${id}-help` : undefined}
          onKeyDown={onKeyDown}
          onChange={(event) => set(Number(event.target.value))}
          className="h-11 min-w-0 flex-1 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <Input
          type="number"
          inputMode="decimal"
          min={1}
          max={10}
          step={0.1}
          aria-label={numberLabel}
          value={draft ?? String(value)}
          onChange={(event) => {
            setDraft(event.target.value);
            const parsed = Number(event.target.value.replace(",", "."));
            if (event.target.value.trim() && Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) set(parsed);
          }}
          onBlur={() => setDraft(null)}
          className="h-11 w-20 shrink-0 tabular-nums"
        />
      </div>
      <div aria-hidden="true" className="flex justify-between gap-2 pr-[5.75rem] text-xs text-muted-foreground">
        <span>{scale[0]}</span>
        <span>{scale[1]}</span>
        <span>{scale[2]}</span>
      </div>
      {help && <p id={`${id}-help`} className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
