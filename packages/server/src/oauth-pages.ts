/**
 * The pages of the OAuth server of the personal server: the consent page (what an app asks for, and the owner's proof), the page that adds a passkey, and the error page. They are
 * served under the same strict policy as the admin panel: no inline script or style, nothing from elsewhere. Every word an app chose (its name, its address) is escaped here and
 * set as text by the script. The texts are in English and Italian, as the browser asks.
 */

export type Lang = "en" | "it";
export type PageScope = "read" | "write" | "run";

export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The language of the browser: the best of English and Italian that its `Accept-Language` asks for (the first one on a tie), English when it asks for neither. */
export function negotiateLanguage(header: string | undefined): Lang {
  if (!header) return "en";
  let best: { lang: Lang; quality: number } | undefined;
  for (const part of header.slice(0, 400).split(",").slice(0, 20)) {
    const [tag, ...parameters] = part.trim().split(";");
    const primary = tag.trim().toLowerCase().split("-")[0];
    if (primary !== "en" && primary !== "it") continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(parameter);
      if (match) quality = Number(match[1]);
    }
    if (!(quality > 0) || quality > 1) continue;
    if (!best || quality > best.quality) best = { lang: primary, quality };
  }
  return best?.lang ?? "en";
}

const TEXT: Record<Lang, Record<string, string>> = {
  en: {
    pageTitle: "Allow {name} · Narrarium",
    title: "{name} wants to connect to your book",
    intro: "This is your own Narrarium server. If you allow it, {name} (it sends you back to {host}) can use the book with the permissions you choose below, until you revoke it in the admin panel.",
    factApp: "App",
    factReturn: "Goes back to",
    factBook: "Book",
    localNote: "This address is on this computer: the app runs on the computer you are using now, not on the server.",
    bookLegend: "Which book?",
    bookHelp: "The app did not say which book it wants. Paste the MCP address of the book (or just its slug).",
    bookLabel: "MCP address of the book",
    permissions: "What it may do",
    permissionsHelp: "Only what the app asked for is shown. You can allow less, never more.",
    scopeRead: "Read the book (always)",
    scopeWrite: "Change the book (every change is a git commit that you can revert)",
    scopeRun: "Control the autopilot (pause, resume, notes and answers)",
    proof: "Show that it is you",
    passkeyButton: "Use a passkey",
    codeLabel: "Admin code",
    codeHelp: "The admin code of this server: run npx narrarium-server admin-code on the computer that runs it.",
    noPasskeyAddress: "Passkeys work only on the public address of the server. Here, use the admin code.",
    noPasskeyYet: "No passkey is registered yet. Use the admin code: you will be offered to add a passkey for next time.",
    allow: "Allow",
    deny: "Deny",
    offerTitle: "Add a passkey for next time?",
    offerHelp: "A passkey on this device lets you approve apps here without typing the admin code.",
    offerLabel: "Name of this device",
    offerAdd: "Add a passkey",
    offerSkip: "Not now",
    registerPageTitle: "Add a passkey · Narrarium",
    registerTitle: "Add a passkey",
    registerHelp: "This device will be able to approve apps that connect to your books, with its fingerprint, face or screen lock.",
    registerLabel: "Name of this device",
    registerButton: "Add a passkey on this device",
    registerNoAddress: "Passkeys can be added only on the public address of the server. Open the link from the admin panel again there.",
    errorPageTitle: "Narrarium",
    errorTitle: "This request cannot be completed",
    errorHelp: "The app, or the address it asks to go back to, is not recognised. Go back to the app and start again.",
    working: "Working…",
    admin_login: "That admin code is not right.",
    too_many_attempts: "Too many attempts. Wait a few minutes and try again.",
    passkey_invalid: "That passkey was not accepted. Try again, or use the admin code.",
    challenge_expired: "That took too long. Try again.",
    request_expired: "This request has expired or was already answered. Start again from the app.",
    invalid_target: "No book with MCP switched on has that address.",
    book_required: "Say which book: paste its MCP address.",
    csrf: "This page is no longer valid. Open it again from the app.",
    scope: "Those permissions cannot be granted. Open the page again from the app.",
    passkey_unavailable: "Passkeys cannot be used on this address.",
    cancelled: "Cancelled. You can try again, or use the admin code.",
    unsupported: "This browser cannot use passkeys here. Use the admin code.",
    network: "The server did not answer. Try again.",
    error: "Something went wrong. Try again.",
    registered: "Passkey added. You can use it from now on.",
    ticket_invalid: "This link is not valid any more. Ask for a new one in the admin panel.",
    passkey_exists: "This passkey is already registered.",
    too_many_passkeys: "Too many passkeys are registered. Remove one in the admin panel first.",
  },
  it: {
    pageTitle: "Consenti a {name} · Narrarium",
    title: "{name} vuole collegarsi al tuo libro",
    intro: "Questo è il tuo server Narrarium. Se consenti, {name} (ti rimanda a {host}) potrà usare il libro con i permessi che scegli qui sotto, finché non lo revochi dal pannello di amministrazione.",
    factApp: "App",
    factReturn: "Torna a",
    factBook: "Libro",
    localNote: "Questo indirizzo è su questo computer: l'app gira sul computer che stai usando ora, non sul server.",
    bookLegend: "Quale libro?",
    bookHelp: "L'app non ha detto quale libro vuole. Incolla l'indirizzo MCP del libro (o solo il suo slug).",
    bookLabel: "Indirizzo MCP del libro",
    permissions: "Cosa può fare",
    permissionsHelp: "Sono mostrati solo i permessi che l'app ha chiesto. Puoi concederne meno, mai di più.",
    scopeRead: "Leggere il libro (sempre)",
    scopeWrite: "Modificare il libro (ogni modifica è un commit git che puoi annullare)",
    scopeRun: "Controllare l'autopilota (pausa, ripresa, note e risposte)",
    proof: "Dimostra che sei tu",
    passkeyButton: "Usa una passkey",
    codeLabel: "Codice admin",
    codeHelp: "Il codice admin di questo server: esegui npx narrarium-server admin-code sul computer che lo esegue.",
    noPasskeyAddress: "Le passkey funzionano solo sull'indirizzo pubblico del server. Qui usa il codice admin.",
    noPasskeyYet: "Non c'è ancora nessuna passkey. Usa il codice admin: ti verrà proposto di aggiungerne una per la prossima volta.",
    allow: "Consenti",
    deny: "Rifiuta",
    offerTitle: "Aggiungere una passkey per la prossima volta?",
    offerHelp: "Una passkey su questo dispositivo ti permette di approvare le app senza digitare il codice admin.",
    offerLabel: "Nome di questo dispositivo",
    offerAdd: "Aggiungi una passkey",
    offerSkip: "Non ora",
    registerPageTitle: "Aggiungi una passkey · Narrarium",
    registerTitle: "Aggiungi una passkey",
    registerHelp: "Questo dispositivo potrà approvare le app che si collegano ai tuoi libri, con impronta, volto o blocco schermo.",
    registerLabel: "Nome di questo dispositivo",
    registerButton: "Aggiungi una passkey su questo dispositivo",
    registerNoAddress: "Le passkey si possono aggiungere solo sull'indirizzo pubblico del server. Apri di nuovo il link dal pannello di amministrazione lì.",
    errorPageTitle: "Narrarium",
    errorTitle: "Questa richiesta non può essere completata",
    errorHelp: "L'app, o l'indirizzo a cui chiede di tornare, non è riconosciuto. Torna all'app e ricomincia.",
    working: "Un momento…",
    admin_login: "Quel codice admin non è corretto.",
    too_many_attempts: "Troppi tentativi. Aspetta qualche minuto e riprova.",
    passkey_invalid: "Quella passkey non è stata accettata. Riprova, oppure usa il codice admin.",
    challenge_expired: "Ci è voluto troppo tempo. Riprova.",
    request_expired: "Questa richiesta è scaduta o ha già avuto risposta. Ricomincia dall'app.",
    invalid_target: "Nessun libro con l'MCP attivo ha questo indirizzo.",
    book_required: "Dì quale libro: incolla il suo indirizzo MCP.",
    csrf: "Questa pagina non è più valida. Aprila di nuovo dall'app.",
    scope: "Questi permessi non si possono concedere. Apri di nuovo la pagina dall'app.",
    passkey_unavailable: "Le passkey non si possono usare su questo indirizzo.",
    cancelled: "Annullato. Puoi riprovare, oppure usare il codice admin.",
    unsupported: "Questo browser non può usare le passkey qui. Usa il codice admin.",
    network: "Il server non ha risposto. Riprova.",
    error: "Qualcosa è andato storto. Riprova.",
    registered: "Passkey aggiunta. D'ora in poi puoi usarla.",
    ticket_invalid: "Questo link non è più valido. Chiedine uno nuovo dal pannello di amministrazione.",
    passkey_exists: "Questa passkey è già registrata.",
    too_many_passkeys: "Ci sono troppe passkey registrate. Rimuovine una dal pannello di amministrazione.",
  },
};

const MESSAGE_KEYS = ["working", "admin_login", "too_many_attempts", "passkey_invalid", "challenge_expired", "request_expired", "invalid_target", "book_required", "csrf", "scope", "passkey_unavailable", "cancelled", "unsupported", "network", "error", "registered", "ticket_invalid", "passkey_exists", "too_many_passkeys"];

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function text(lang: Lang, key: string, values: Record<string, string> = {}): string {
  let result = TEXT[lang][key] ?? TEXT.en[key] ?? key;
  for (const [name, value] of Object.entries(values)) result = result.split(`{${name}}`).join(value);
  return result;
}

function messagesFor(lang: Lang): Record<string, string> {
  return Object.fromEntries(MESSAGE_KEYS.map((key) => [key, text(lang, key)]));
}

const head = (lang: Lang, title: string, script: boolean): string => `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/oauth/assets/page.css">
${script ? '<script src="/oauth/assets/page.js" defer></script>\n' : ""}</head>
`;

export interface ConsentView {
  lang: Lang;
  requestId: string;
  csrf: string;
  client: { name: string; redirectHost: string };
  /** The address of the book the app asked for, as it asked; `null` when it named none and the owner must. */
  resource: string | null;
  scopes: Array<{ scope: PageScope; requested: boolean; locked: boolean; checked: boolean }>;
  passkeys: { available: boolean; canRegister: boolean; reason?: "address" | "none" };
  bookInput: boolean;
  /** The app sends the owner to an address on the computer he is using. */
  loopback: boolean;
}

const SCOPE_TEXT: Record<PageScope, string> = { read: "scopeRead", write: "scopeWrite", run: "scopeRun" };

/** The consent page. What the script needs (the request, the token of the page, the state of the toggles and the texts it shows) is in the `data-state` of the body. */
export function renderConsent(view: ConsentView): string {
  const { lang } = view;
  const t = (key: string, values?: Record<string, string>) => escapeHtml(text(lang, key, values));
  const state = { lang, requestId: view.requestId, csrf: view.csrf, client: view.client, resource: view.resource, scopes: view.scopes, passkeys: view.passkeys, bookInput: view.bookInput, messages: messagesFor(lang) };
  const toggles = view.scopes.map((entry) => `    <label class="check"><input type="checkbox" name="scope" value="${entry.scope}"${entry.checked ? " checked" : ""}${entry.locked ? " disabled" : ""}> <span>${t(SCOPE_TEXT[entry.scope])}</span></label>`).join("\n");
  const note = !view.passkeys.available && view.passkeys.reason === "address" ? t("noPasskeyAddress") : !view.passkeys.available ? t("noPasskeyYet") : "";
  const book = view.bookInput
    ? `  <fieldset>
    <legend>${t("bookLegend")}</legend>
    <p class="muted">${t("bookHelp")}</p>
    <label for="book">${t("bookLabel")}</label>
    <input id="book" name="book" type="text" autocomplete="off" spellcheck="false" maxlength="300">
  </fieldset>
`
    : "";
  return `${head(lang, text(lang, "pageTitle", { name: view.client.name }), true)}<body data-state="${escapeHtml(JSON.stringify(state))}">
<main>
  <h1>${t("title", { name: view.client.name })}</h1>
  <p class="muted">${t("intro", { name: view.client.name, host: view.client.redirectHost })}</p>
  <dl class="facts">
    <dt>${t("factApp")}</dt><dd>${escapeHtml(view.client.name)}</dd>
    <dt>${t("factReturn")}</dt><dd>${escapeHtml(view.client.redirectHost)}</dd>
${view.resource ? `    <dt>${t("factBook")}</dt><dd><code>${escapeHtml(view.resource)}</code></dd>\n` : ""}  </dl>
${view.loopback ? `  <p class="notice">${t("localNote")}</p>\n` : ""}  <form id="form" method="post" action="/oauth/authorize/approve" novalidate>
${book}  <fieldset>
    <legend>${t("permissions")}</legend>
    <p class="muted">${t("permissionsHelp")}</p>
${toggles}
  </fieldset>
  <fieldset>
    <legend>${t("proof")}</legend>
    <button type="button" id="passkey"${view.passkeys.available ? "" : " hidden"}>${t("passkeyButton")}</button>
    <p class="muted" id="passkey-note">${note}</p>
    <label for="code">${t("codeLabel")}</label>
    <input id="code" name="code" type="password" autocomplete="off" spellcheck="false" maxlength="200">
    <p class="muted">${t("codeHelp")}</p>
  </fieldset>
  <div class="row">
    <button type="submit" id="approve">${t("allow")}</button>
    <button type="button" id="deny" class="ghost">${t("deny")}</button>
  </div>
  </form>
  <section id="offer" hidden aria-labelledby="offer-title">
    <h2 id="offer-title">${t("offerTitle")}</h2>
    <p class="muted">${t("offerHelp")}</p>
    <label for="offer-label">${t("offerLabel")}</label>
    <input id="offer-label" type="text" maxlength="40" autocomplete="off">
    <div class="row">
      <button type="button" id="offer-add">${t("offerAdd")}</button>
      <button type="button" id="offer-skip" class="ghost">${t("offerSkip")}</button>
    </div>
  </section>
  <p id="message" role="alert" aria-live="assertive"></p>
</main>
</body>
</html>
`;
}

/** The page that adds a passkey: its ticket is in the address after the `#`, which the browser never sends to a server. */
export function renderRegisterPage(lang: Lang, canRegister: boolean): string {
  const t = (key: string) => escapeHtml(text(lang, key));
  const state = { kind: "register", lang, canRegister, messages: messagesFor(lang) };
  return `${head(lang, text(lang, "registerPageTitle"), true)}<body data-state="${escapeHtml(JSON.stringify(state))}">
<main>
  <h1>${t("registerTitle")}</h1>
  <p class="muted">${t(canRegister ? "registerHelp" : "registerNoAddress")}</p>
  <label for="passkey-label">${t("registerLabel")}</label>
  <input id="passkey-label" type="text" maxlength="40" autocomplete="off">
  <div class="row"><button type="button" id="register"${canRegister ? "" : " disabled"}>${t("registerButton")}</button></div>
  <p id="message" role="alert" aria-live="assertive"></p>
</main>
</body>
</html>
`;
}

/** What an owner sees when the request cannot be trusted enough to go back to the app: nothing to approve, no script, nothing of what was sent. */
export function renderErrorPage(lang: Lang): string {
  return `${head(lang, text(lang, "errorPageTitle"), false)}<body>
<main>
  <h1>${escapeHtml(text(lang, "errorTitle"))}</h1>
  <p>${escapeHtml(text(lang, "errorHelp"))}</p>
</main>
</body>
</html>
`;
}

export const PAGE_CSS = `:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1f2328;--muted:#5f6670;--line:#d7d4cd;--accent:#0f766e;--accent-fg:#fff;--bad:#b91c1c;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--fg:#e8e6e3;--muted:#a3aab4;--line:#343a42;--accent:#2dd4bf;--accent-fg:#06201d;--bad:#f87171}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg)}
main{max-width:560px;margin:24px auto;padding:20px;background:var(--card);border:1px solid var(--line);border-radius:14px}
@media (max-width:600px){main{margin:0;border-radius:0;border-width:0}}
h1{font-size:22px;line-height:1.25;margin:0 0 8px}h2{font-size:18px;margin:0 0 6px}.muted{color:var(--muted);font-size:14px;margin:4px 0 8px}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:12px 0}.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
code{font:13px ui-monospace,monospace}.notice{border:1px dashed var(--accent);border-radius:8px;padding:8px 10px;font-size:14px}
fieldset{border:1px solid var(--line);border-radius:10px;margin:14px 0;padding:10px 14px}legend{padding:0 6px;font-weight:600}
label{display:block;margin:10px 0 4px}label.check{display:flex;gap:10px;align-items:flex-start;margin:8px 0}label.check input{margin-top:5px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
input[type=checkbox]{width:18px;height:18px;flex:none}
button{border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer;margin:6px 0}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}button:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;flex-wrap:wrap;gap:10px}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
#message{color:var(--bad);min-height:1.5em;margin:10px 0 0;font-weight:600}
`;

export const PAGE_JS = String.raw`"use strict";
(function () {
  var state = {};
  try { state = JSON.parse(document.body.getAttribute("data-state") || "{}"); } catch (error) { state = {}; }
  var msg = state.messages || {};
  var pending = null;
  var controls = ["approve", "passkey", "deny", "offer-add", "offer-skip", "register"];

  function $(id) { return document.getElementById(id); }
  function say(text) { var box = $("message"); if (box) box.textContent = text || ""; }
  function busy(on) { controls.forEach(function (id) { var node = $(id); if (node) node.disabled = on; }); }
  function toBuffer(text) {
    var base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  function toText(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function supported() { return typeof PublicKeyCredential !== "undefined" && !!navigator.credentials && typeof navigator.credentials.get === "function"; }
  function post(route, body) {
    return fetch(route, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": state.csrf || "" }, credentials: "omit", body: JSON.stringify(body) }).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
        return { status: response.status, ok: response.ok, data: data };
      });
    }, function () { return { status: 0, ok: false, data: { code: "network" } }; });
  }
  function problem(result) { return msg[result.data && result.data.code] || msg.error || ""; }
  function failure(error) {
    if (error && error.result) return problem(error.result);
    if (error && error.name === "NotAllowedError") return msg.cancelled || "";
    return msg.error || "";
  }
  function requestOptions(key) {
    return {
      challenge: toBuffer(key.challenge), rpId: key.rpId, timeout: key.timeout, userVerification: key.userVerification,
      allowCredentials: (key.allowCredentials || []).map(function (entry) { var item = { type: entry.type, id: toBuffer(entry.id) }; if (entry.transports) item.transports = entry.transports; return item; })
    };
  }
  function creationOptions(key) {
    return {
      rp: key.rp, user: { id: toBuffer(key.user.id), name: key.user.name, displayName: key.user.displayName }, challenge: toBuffer(key.challenge),
      pubKeyCredParams: key.pubKeyCredParams, timeout: key.timeout, attestation: key.attestation, authenticatorSelection: key.authenticatorSelection,
      excludeCredentials: (key.excludeCredentials || []).map(function (entry) { return { type: entry.type, id: toBuffer(entry.id) }; })
    };
  }
  function encodeAssertion(credential) {
    var r = credential.response;
    var out = { id: credential.id, rawId: toText(credential.rawId), type: credential.type, response: { clientDataJSON: toText(r.clientDataJSON), authenticatorData: toText(r.authenticatorData), signature: toText(r.signature) } };
    if (r.userHandle) out.response.userHandle = toText(r.userHandle);
    return out;
  }
  function encodeCreated(credential) {
    var r = credential.response;
    return { id: credential.id, rawId: toText(credential.rawId), type: credential.type, response: { clientDataJSON: toText(r.clientDataJSON), attestationObject: toText(r.attestationObject), transports: typeof r.getTransports === "function" ? r.getTransports() : [] } };
  }
  function create(ticket, label) {
    return post("/oauth/passkeys/options", { ticket: ticket }).then(function (options) {
      if (!options.ok) throw { result: options };
      return navigator.credentials.create({ publicKey: creationOptions(options.data.publicKey) });
    }).then(function (credential) {
      return post("/oauth/passkeys/register", { ticket: ticket, label: label, credential: encodeCreated(credential) });
    });
  }

  function chosen() {
    var list = [];
    var boxes = document.querySelectorAll('input[name="scope"]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) list.push(boxes[i].value);
    return list;
  }
  function decision(extra) {
    var body = { requestId: state.requestId, scopes: chosen() };
    var book = $("book");
    if (state.bookInput && book) body.book = book.value.trim();
    Object.keys(extra || {}).forEach(function (key) { body[key] = extra[key]; });
    return body;
  }
  function approveWithCode(event) {
    if (event && event.preventDefault) event.preventDefault();
    busy(true); say(msg.working);
    return post("/oauth/authorize/approve", decision({ proof: { type: "admin-code", code: $("code").value } })).then(function (result) {
      busy(false);
      if (!result.ok) { say(problem(result)); return; }
      say(""); $("code").value = "";
      if (result.data.passkeyOffer && state.passkeys && state.passkeys.canRegister && supported() && typeof navigator.credentials.create === "function") {
        pending = result.data; $("form").hidden = true; $("offer").hidden = false;
        return;
      }
      location.assign(result.data.redirect);
    });
  }
  function usePasskey() {
    busy(true); say(msg.working);
    return post("/oauth/authorize/challenge", decision({})).then(function (options) {
      if (!options.ok) throw { result: options };
      return navigator.credentials.get({ publicKey: requestOptions(options.data.publicKey) });
    }).then(function (credential) {
      return post("/oauth/authorize/approve", { requestId: state.requestId, proof: { type: "passkey", credential: encodeAssertion(credential) } });
    }).then(function (result) {
      busy(false);
      if (!result.ok) { say(problem(result)); return; }
      say(""); location.assign(result.data.redirect);
    }, function (error) { busy(false); say(failure(error)); });
  }
  function deny() {
    busy(true);
    return post("/oauth/authorize/deny", { requestId: state.requestId }).then(function (result) {
      busy(false);
      if (!result.ok) { say(problem(result)); return; }
      location.assign(result.data.redirect);
    });
  }
  function addFromOffer() {
    var offer = pending; var label = $("offer-label");
    busy(true); say(msg.working);
    return create(offer.passkeyOffer.ticket, label ? label.value : "").then(function (result) {
      busy(false);
      if (!result.ok) { say(problem(result)); return; }
      location.assign(offer.redirect);
    }, function (error) { busy(false); say(failure(error)); });
  }
  function skipOffer() { location.assign(pending.redirect); return Promise.resolve(); }

  function consentPage() {
    var passkey = $("passkey");
    if (passkey) {
      if (!state.passkeys || !state.passkeys.available || !supported()) passkey.hidden = true;
      else passkey.addEventListener("click", usePasskey);
    }
    $("form").addEventListener("submit", approveWithCode);
    $("deny").addEventListener("click", deny);
    $("offer-add").addEventListener("click", addFromOffer);
    $("offer-skip").addEventListener("click", skipOffer);
  }
  function registerPage() {
    var ticket = String(location.hash || "").replace(/^#/, "");
    $("register").addEventListener("click", function () {
      if (!ticket) { say(msg.ticket_invalid); return Promise.resolve(); }
      if (!supported() || typeof navigator.credentials.create !== "function") { say(msg.unsupported); return Promise.resolve(); }
      busy(true); say(msg.working);
      return create(ticket, $("passkey-label").value).then(function (result) {
        busy(false);
        if (!result.ok) { say(problem(result)); return; }
        say(msg.registered); $("register").hidden = true;
      }, function (error) { busy(false); say(failure(error)); });
    });
  }
  if (state.kind === "register") registerPage(); else consentPage();
})();
`;
