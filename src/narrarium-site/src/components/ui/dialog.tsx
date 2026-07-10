import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasOpenFloatingLayer } from "@/lib/floatingLayer";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

function isInsideFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-narrarium-floating-layer]"));
}

/** Radix exposes the real DOM target differently per event; check both. */
function floatingEventTarget(event: { target?: EventTarget | null; detail?: { originalEvent?: { target?: EventTarget | null } } }): EventTarget | null {
  return event.detail?.originalEvent?.target ?? event.target ?? null;
}

/**
 * Should this outside-interaction be ignored (i.e. NOT close the dialog)?
 *
 * We ignore it only when the interaction actually belongs to an open floating
 * layer (a dropdown/select rendered in a portal on top of the dialog): either
 * the event target is inside that layer, or a layer was open when the event
 * fired. A plain click on the dark overlay never matches these, so overlay
 * clicks always close the dialog as expected.
 */
function shouldIgnoreOutside(target: EventTarget | null): boolean {
  return isInsideFloatingLayer(target) || hasOpenFloatingLayer();
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideCloseButton?: boolean; bare?: boolean }
>(({ className, children, onInteractOutside, onPointerDownOutside, onFocusOutside, hideCloseButton, bare, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // `bare` opts out of the default centered/padded shell so callers can
        // position the panel freely (e.g. a docked Copilot chat).
        bare
          ? "fixed z-50 border bg-background shadow-lg sm:rounded-lg"
          : "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg",
        className,
      )}
      onPointerDownOutside={(event) => {
        onPointerDownOutside?.(event);
        if (!event.defaultPrevented && shouldIgnoreOutside(floatingEventTarget(event))) {
          event.preventDefault();
        }
      }}
      onFocusOutside={(event) => {
        onFocusOutside?.(event);
        if (!event.defaultPrevented && shouldIgnoreOutside(floatingEventTarget(event))) {
          event.preventDefault();
        }
      }}
      onInteractOutside={(event) => {
        onInteractOutside?.(event);
        if (!event.defaultPrevented && shouldIgnoreOutside(floatingEventTarget(event))) {
          event.preventDefault();
        }
      }}
      {...props}
    >
      {children}
      {!hideCloseButton && (
        <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
