import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/**
 * A number of the configuration or of the Scaletta: the text the author types is kept while it is being typed, and what is out of the limits is
 * put back into them when the field loses the focus (or is sent as the nearest limit, when it can be).
 */
/** `fill`: the field takes the height of its neighbours in a row (the label above, the input at the bottom); off, it is as tall as its label and input. */
export function NumberField({ id, label, value, min, max, step = 1, disabled, describedBy, fill = true, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; describedBy?: string; fill?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parse = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
  return (
    // The label may take two lines where the field is narrow: the fields of a row stay on one line, whatever their labels do.
    <div className={fill ? "flex h-full flex-col justify-between gap-1" : "flex flex-col gap-1"}>
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        aria-describedby={describedBy}
        className="h-9"
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parse(event.target.value);
          if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
        }}
        onBlur={(event) => {
          const parsed = parse(event.target.value);
          const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
          setText(String(next));
          if (next !== value) onChange(next);
        }}
      />
    </div>
  );
}
