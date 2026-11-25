import type { SVGProps } from "react";

/**
 * Brainstorming's mark: the Copilot's ghost, powered up with a spark, drawn like the other icons of the app (lucide's grid: 24×24, a stroke of 2,
 * round ends and joins), so that it sits beside them at any size.
 */
export function BrainstormMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-brainstorm-mark="" {...props}>
      <path d="M10 6a7 7 0 0 0-7 7v9l2.33-2.33L7.67 22 10 19.67 12.33 22l2.34-2.33L17 22v-9a7 7 0 0 0-7-7z" />
      <path d="M7.5 13h.01" />
      <path d="M12.5 13h.01" />
      <path d="M19 1.5v5" />
      <path d="M21.5 4h-5" />
      <path d="M21.5 9.5h.01" />
    </svg>
  );
}
