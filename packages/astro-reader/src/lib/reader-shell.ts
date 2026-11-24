import { startEReader } from "./ereader/app.js";
import { withoutReloadParam } from "./reader-freshness.js";
import type { ReaderLabels } from "./reader-i18n.js";
import { ReaderOpenError, openReaderSession, type PasswordReason, type ReaderBoot } from "./reader-session.js";

/** The browser side of the shell: the lock and the opening of the book; then the e-reader (ereader/app.ts) lays it out. */

export interface ShellBoot extends ReaderBoot {
  labels: ReaderLabels;
  uiLanguage: string;
  bookLanguage: string;
  /** The pages of the canon, published only for a public book. */
  canonHref: string | null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage and sessionStorage throw in some private modes: a reader that cannot remember still reads. */
function guardedStorage(get: () => Storage): StorageLike {
  return {
    getItem: (key) => {
      try {
        return get().getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        get().setItem(key, value);
      } catch {
        // Full or disabled storage: nothing is remembered.
      }
    },
    removeItem: (key) => {
      try {
        get().removeItem(key);
      } catch {
        // Disabled storage.
      }
    },
  };
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The reader's page has no #${id}.`);
  return found as T;
}

function setStatus(text: string): void {
  const status = element("reader-status");
  status.textContent = text;
  status.hidden = !text;
}

/** The lock: shown when the book needs a password; resolves with what the reader typed. */
function createPasswordPrompt(labels: ReaderLabels) {
  const lock = element<HTMLElement>("reader-lock");
  const form = element<HTMLFormElement>("reader-lock-form");
  const input = element<HTMLInputElement>("reader-password");
  const remember = element<HTMLInputElement>("reader-remember");
  const submit = element<HTMLButtonElement>("reader-unlock");
  const message = element<HTMLElement>("reader-lock-message");
  const reveal = element<HTMLButtonElement>("reader-password-reveal");

  reveal.addEventListener("click", () => {
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    reveal.setAttribute("aria-pressed", shown ? "false" : "true");
  });

  const messages: Record<PasswordReason, string> = {
    first: "",
    wrong: labels.wrongPassword,
    revoked: labels.revokedPassword,
    unverified: labels.unverifiedPassword,
  };

  return (reason: PasswordReason) =>
    new Promise<{ password: string; remember: boolean }>((resolve) => {
      setStatus("");
      lock.hidden = false;
      submit.disabled = false;
      submit.textContent = labels.unlock;
      form.removeAttribute("aria-busy");
      message.textContent = messages[reason];
      message.hidden = !messages[reason];
      input.setAttribute("aria-invalid", reason === "wrong" ? "true" : "false");
      if (reason === "wrong") input.select();
      input.focus();
      const onSubmit = (event: SubmitEvent) => {
        event.preventDefault();
        const password = input.value;
        if (!password.trim()) {
          input.focus();
          return;
        }
        form.removeEventListener("submit", onSubmit);
        submit.disabled = true;
        submit.textContent = labels.unlocking;
        form.setAttribute("aria-busy", "true");
        message.hidden = true;
        setStatus(labels.unlocking);
        resolve({ password, remember: remember.checked });
      };
      form.addEventListener("submit", onSubmit);
    });
}

function hideLock(): void {
  const lock = document.getElementById("reader-lock");
  const input = document.getElementById("reader-password") as HTMLInputElement | null;
  if (input) input.value = "";
  if (lock) lock.hidden = true;
}

function showError(error: unknown, labels: ReaderLabels): void {
  const message = error instanceof ReaderOpenError && error.code === "unsupported" ? labels.unsupported : labels.openFailed;
  const status = element("reader-status");
  status.replaceChildren();
  const text = document.createElement("span");
  text.textContent = `${message} `;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = labels.reload;
  button.addEventListener("click", () => window.location.reload());
  status.append(text, button);
  status.hidden = false;
}

export async function startReaderShell(): Promise<void> {
  const bootElement = document.getElementById("narrarium-reader-boot");
  if (!bootElement) return;
  const boot = JSON.parse(bootElement.textContent || "{}") as ShellBoot;
  const clean = withoutReloadParam(window.location.href);
  if (clean) window.history.replaceState(window.history.state, "", clean);
  const local = guardedStorage(() => window.localStorage);
  try {
    const result = await openReaderSession(
      boot,
      {
        fetch: window.fetch.bind(window),
        local,
        session: guardedStorage(() => window.sessionStorage),
        href: window.location.href,
        baseHref: document.baseURI,
        replaceLocation: (url) => window.location.replace(url),
      },
      createPasswordPrompt(boot.labels),
    );
    if (result.kind === "reloading") return;
    hideLock();
    setStatus(result.staleShell ? boot.labels.staleShell : result.online ? "" : boot.labels.offline);
    startEReader(result, boot, local);
  } catch (error) {
    console.error("[narrarium-reader]", error);
    hideLock();
    showError(error, boot.labels);
  }
}
