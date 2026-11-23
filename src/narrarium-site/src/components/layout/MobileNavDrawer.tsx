import "@/i18n/shell";
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { create } from "zustand";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MobileSidebar } from "./Sidebar";
import { NAV_DRAWER_STEP, isNavDrawerStep } from "./navDrawerStep";

interface DrawerState {
  open: boolean;
  /** What had the focus when the menu opened (the menu button): it gets it back when the menu closes. */
  opener: HTMLElement | null;
  /** Whether the step of the menu reached the history: from then on, a page without it means that the menu was left. */
  stepped: boolean;
}

const useDrawerStore = create<DrawerState>()(() => ({ open: false, opener: null, stepped: false }));

/**
 * The menu of the app on a phone, as a drawer: `show` opens it and adds one step to the history, which the back gesture takes back (closing the
 * menu instead of leaving the page); `hide` closes it and gives the step back; `close` only closes it, for a link of the menu that takes the step's
 * place in the history.
 */
export function useNavDrawer() {
  const navigate = useNavigate();
  const location = useLocation();
  const open = useDrawerStore((state) => state.open);
  const onStep = isNavDrawerStep(location.state);

  const show = useCallback(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    useDrawerStore.setState({ open: true, opener, stepped: onStep });
    if (onStep) return;
    // The step is the same page without its hash and its state: what a page does once for a link to a part of it or for a command that came with
    // the address (scroll to an anchor, jump to an excerpt) is not done again for the menu, and the page finds both again when the menu closes.
    navigate(`${location.pathname}${location.search}`, { state: { [NAV_DRAWER_STEP]: true } });
  }, [location.pathname, location.search, navigate, onStep]);

  const close = useCallback(() => useDrawerStore.setState({ open: false }), []);

  const hide = useCallback(() => {
    useDrawerStore.setState({ open: false });
    if (onStep) navigate(-1);
  }, [navigate, onStep]);

  return { open, show, hide, close, onStep };
}

/** The drawer itself: the menu of the app, with its name, a close button a thumb can hit, and one place to scroll. */
export function MobileNavDrawer() {
  const { t } = useTranslation();
  const location = useLocation();
  const { open, hide, close, onStep } = useNavDrawer();

  // The step of the menu reached the history; when the page shows without it again (the back gesture, or any other way to go), the menu closes.
  useEffect(() => {
    const state = useDrawerStore.getState();
    if (!state.open) return;
    if (onStep) {
      if (!state.stepped) useDrawerStore.setState({ stepped: true });
      return;
    }
    if (state.stepped) useDrawerStore.setState({ open: false });
  }, [onStep, location.key]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) hide(); }}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const { opener } = useDrawerStore.getState();
          if (opener?.isConnected) opener.focus();
        }}
        className="left-0 top-0 h-[100dvh] w-[min(20rem,86vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 border-r p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:left-0 sm:top-0 sm:w-80 sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none"
      >
        <DialogTitle className="sr-only">{t("shell.navMenu")}</DialogTitle>
        <MobileSidebar
          onNavigate={close}
          replaceHistory={onStep}
          headerAction={(
            <DialogClose className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("common.close")}>
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogClose>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
