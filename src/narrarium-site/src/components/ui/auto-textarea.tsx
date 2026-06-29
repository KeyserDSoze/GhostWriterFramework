import * as React from "react";
import { cn } from "@/lib/utils";

export interface AutoTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  maxHeight?: number;
}

const AutoTextarea = React.forwardRef<HTMLTextAreaElement, AutoTextareaProps>(
  ({ className, value, minRows = 3, maxHeight, onInput, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRef = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    };

    const resize = React.useCallback(() => {
      const node = innerRef.current;
      if (!node) return;
      node.style.height = "auto";
      const next = maxHeight ? Math.min(node.scrollHeight, maxHeight) : node.scrollHeight;
      node.style.height = `${next}px`;
      node.style.overflowY = maxHeight && node.scrollHeight > maxHeight ? "auto" : "hidden";
    }, [maxHeight]);

    React.useLayoutEffect(() => {
      resize();
    }, [value, resize]);

    return (
      <textarea
        ref={setRef}
        value={value}
        rows={minRows}
        onInput={(event) => {
          resize();
          onInput?.(event);
        }}
        className={cn(
          "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
AutoTextarea.displayName = "AutoTextarea";

export { AutoTextarea };
