import vm from "node:vm";

// Just enough of a browser to run a page's own script against a real server (the consent page's, the admin panel's): elements made from the page's HTML that keep
// their attributes, children, text and listeners; `document`, `location`, `navigator` and `fetch` that the test provides; and nothing else. The scripts are strings in the
// bundle that no compiler looks at, so running them is the only way to know that they say to the server what it expects and draw what it answers.

const unescapeHtml = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.own = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.type = "";
    this.className = "";
    this.focused = false;
    const element = this;
    this.classList = {
      add: (name) => {
        if (!element.className.split(" ").includes(name)) element.className = `${element.className} ${name}`.trim();
      },
      remove: (name) => {
        element.className = element.className.split(" ").filter((entry) => entry && entry !== name).join(" ");
      },
      contains: (name) => element.className.split(" ").includes(name),
      toggle: (name, force) => {
        const has = element.className.split(" ").includes(name);
        if (force === undefined ? !has : force) element.classList.add(name);
        else element.classList.remove(name);
      },
    };
  }

  get textContent() {
    return this.own + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.own = String(value);
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "value") this.value = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  focus() {
    this.focused = true;
  }

  closest() {
    return null;
  }

  /** Fire the listeners of an event and wait for what they started. */
  async dispatch(type, event = {}) {
    const results = [];
    for (const listener of this.listeners[type] ?? []) results.push(listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event }));
    await Promise.all(results);
  }

  click() {
    return this.dispatch("click");
  }

  find(predicate) {
    const found = [];
    const walk = (node) => {
      if (predicate(node)) found.push(node);
      node.children.forEach(walk);
    };
    walk(this);
    return found;
  }
}

const attributesOf = (text) => {
  const attributes = {};
  for (const match of text.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attributes[match[1]] = match[2] === undefined ? "" : unescapeHtml(match[2]);
  return attributes;
};

/**
 * Run `script` in a context that has a `document` made from `html`. `fetch`, `location`, `navigator` and `extra` globals are the test's. Answers `{ $, all, document, window, ready }`;
 * `$(id)` is an element by its id and `all(selector)` finds elements by a tag with an attribute (`input[name="scope"]`, `[data-i18n]`).
 */
export function fakeBrowser(html, script, { fetch, location = {}, navigator = { language: "en-GB" }, extra = {}, storage = {}, local = {}, confirm = () => true, filename = "script.js" } = {}) {
  const byId = new Map();
  const everything = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const element = new Element(match[1]);
    const attributes = attributesOf(match[2]);
    element.attributes = attributes;
    element.id = attributes.id ?? "";
    element.name = attributes.name ?? "";
    element.value = attributes.value ?? "";
    element.type = attributes.type ?? "";
    element.className = attributes.class ?? "";
    element.checked = "checked" in attributes;
    element.disabled = "disabled" in attributes;
    element.hidden = "hidden" in attributes;
    everything.push(element);
    if (attributes.id) byId.set(attributes.id, element);
  }
  const body = everything.find((element) => element.tagName === "BODY") ?? new Element("body");
  const matches = (element, selector) => {
    const parsed = /^([a-z0-9]*)(?:\[([a-z0-9_-]+)(?:="([^"]*)")?\])?$/i.exec(selector);
    if (!parsed) return false;
    const [, tag, attribute, wanted] = parsed;
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    if (!attribute) return true;
    return attribute in element.attributes && (wanted === undefined || element.attributes[attribute] === wanted);
  };
  const listeners = {};
  const windowListeners = {};
  const scrolls = [];
  const store = (initial) => {
    const values = new Map(Object.entries(initial));
    return { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => void values.set(name, String(value)), removeItem: (name) => void values.delete(name) };
  };
  const document = {
    documentElement: { lang: attributesOf(/<html\b([^>]*)>/.exec(html)?.[1] ?? "").lang ?? "en" },
    body,
    visibilityState: "visible",
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => Object.assign(new Element("#text"), { own: String(text) }),
    querySelectorAll: (selector) => everything.filter((element) => matches(element, selector)),
    querySelector: (selector) => everything.find((element) => matches(element, selector)) ?? null,
    addEventListener: (type, listener) => void (listeners[type] ??= []).push(listener),
  };
  const sandbox = {
    document,
    fetch,
    location,
    navigator,
    localStorage: store(local),
    sessionStorage: store(storage),
    confirm,
    Date,
    Object,
    String,
    Array,
    JSON,
    Math,
    Promise,
    Number,
    Error,
    Uint8Array,
    ArrayBuffer,
    atob,
    btoa,
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    console,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout,
    clearTimeout,
    addEventListener: (type, listener) => void (windowListeners[type] ??= []).push(listener),
    scrollTo: (...position) => void scrolls.push(position),
    ...extra,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox, { filename });
  const ready = Promise.all((listeners.DOMContentLoaded ?? []).map((listener) => listener()));
  /** What a browser does when the address changes (`location.hash = "#/books"`, then this): the page's own listeners run, and what they started is awaited. */
  const fire = async (type, event = {}) => {
    await Promise.all([...(windowListeners[type] ?? []), ...(type === "DOMContentLoaded" ? [] : listeners[type] ?? [])].map((listener) => listener(event)));
  };
  return { $: (id) => byId.get(id) ?? null, all: (selector) => everything.filter((element) => matches(element, selector)), document, window: sandbox, ready, fire, scrolls, location: sandbox.location, localStorage: sandbox.localStorage, sessionStorage: sandbox.sessionStorage };
}

/** Wait until the work that a click started has settled (requests are answered by a real server, so this is a moment, not a fixed time). */
export const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
