import { withoutReloadParam } from "./reader-freshness.js";
import { formatLabel, type ReaderLabels } from "./reader-i18n.js";
import type { ReaderBundle, ReaderChapter } from "./reader-protocol.js";
import { ReaderOpenError, openReaderSession, type OpenedReader, type PasswordReason, type ReaderBoot } from "./reader-session.js";

/** The browser side of the shell: the lock, the opening of the book, and its reading view. */

export interface ShellBoot extends ReaderBoot {
  labels: ReaderLabels;
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

function renderChapter(container: HTMLElement, chapter: ReaderChapter, labels: ReaderLabels): void {
  const article = document.createElement("article");
  article.className = "reader-chapter";
  const heading = document.createElement("h1");
  heading.className = "reader-chapter__title";
  heading.tabIndex = -1;
  heading.innerHTML = `<span class="reader-chapter__number"></span><span class="reader-chapter__name"></span>`;
  (heading.firstElementChild as HTMLElement).textContent = formatLabel(labels.chapterLabel, { number: chapter.number });
  (heading.lastElementChild as HTMLElement).textContent = chapter.title;
  article.append(heading);
  if (chapter.scenes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "reader-chapter__empty";
    empty.textContent = labels.emptyChapter;
    article.append(empty);
  }
  for (const scene of chapter.scenes) {
    const section = document.createElement("section");
    section.className = "reader-scene";
    section.dataset.scene = scene.slug;
    const title = document.createElement("h2");
    title.className = "reader-scene__title";
    title.textContent = scene.title;
    const prose = document.createElement("div");
    prose.className = "reader-scene__text";
    // The core's renderer: no raw HTML and no unsafe URL ever reach this string.
    prose.innerHTML = scene.html;
    section.append(title, prose);
    article.append(section);
  }
  container.replaceChildren(article);
}

function showReader(opened: OpenedReader, boot: ShellBoot): void {
  const { labels } = boot;
  const bundle: ReaderBundle = opened.bundle;
  const app = element<HTMLElement>("reader-app");
  const text = element<HTMLElement>("reader-text");
  const select = element<HTMLSelectElement>("reader-chapter-select");
  const previous = element<HTMLButtonElement>("reader-previous");
  const next = element<HTMLButtonElement>("reader-next");
  const position = element<HTMLElement>("reader-position");
  const chapters = bundle.chapters;
  app.hidden = false;
  setStatus(opened.staleShell ? labels.staleShell : opened.online ? "" : labels.offline);

  if (chapters.length === 0) {
    const empty = document.createElement("p");
    empty.className = "reader-chapter__empty";
    empty.textContent = labels.noChapters;
    text.replaceChildren(empty);
    select.disabled = previous.disabled = next.disabled = true;
    return;
  }

  select.replaceChildren(...chapters.map((chapter, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${chapter.number}. ${chapter.title}`;
    return option;
  }));

  let current = 0;
  const show = (index: number, focus: boolean) => {
    current = Math.max(0, Math.min(chapters.length - 1, index));
    renderChapter(text, chapters[current], labels);
    select.value = String(current);
    previous.disabled = current === 0;
    next.disabled = current === chapters.length - 1;
    position.textContent = formatLabel(labels.chapterOf, { number: current + 1, total: chapters.length });
    window.scrollTo(0, 0);
    if (focus) text.querySelector<HTMLElement>(".reader-chapter__title")?.focus();
  };
  document.getElementById("reader-forget")?.addEventListener("click", () => {
    opened.forgetPassword();
    setStatus(labels.passwordForgotten);
  });
  select.addEventListener("change", () => show(Number(select.value), true));
  previous.addEventListener("click", () => show(current - 1, true));
  next.addEventListener("click", () => show(current + 1, true));
  show(0, false);
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
  try {
    const result = await openReaderSession(
      boot,
      {
        fetch: window.fetch.bind(window),
        local: guardedStorage(() => window.localStorage),
        session: guardedStorage(() => window.sessionStorage),
        href: window.location.href,
        baseHref: document.baseURI,
        replaceLocation: (url) => window.location.replace(url),
      },
      createPasswordPrompt(boot.labels),
    );
    if (result.kind === "reloading") return;
    hideLock();
    showReader(result, boot);
  } catch (error) {
    console.error("[narrarium-reader]", error);
    hideLock();
    showError(error, boot.labels);
  }
}
