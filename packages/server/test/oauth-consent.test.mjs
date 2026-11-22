import test from "node:test";
import assert from "node:assert/strict";
import { withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { fakeBrowser, settle } from "./fake-browser.mjs";
import { SoftwarePasskey, b64u } from "./passkey-helpers.mjs";
import {
  APP_REDIRECT, LOCAL_REDIRECT, PUBLIC_HOST, PUBLIC_URL, adminCode, approveWithPasskey, codeOf, connectApp, enrollPasskey, exchange, openConsent, pageState, pkce, registerApp, setPublic,
  startAuthorization, web,
} from "./oauth-helpers.mjs";

// The consent page (S7, phase B, R3): what the owner sees and what its script says to the server. The script is run against the real server, so what the two agree on is tested, not assumed.

const arrayBuffer = (base64url) => Uint8Array.from(Buffer.from(base64url, "base64url")).buffer;

/** The consent page opened in a browser that has `passkey` (or none), with every request it makes answered by the real server. */
async function openPage(w, started, { passkey, webauthn = true, hash = "", language = "en-GB" } = {}) {
  const script = (await w.get("/oauth/assets/page.js")).text;
  const navigations = [];
  const requests = [];
  const fetch = async (route, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ route, method: init.method ?? "GET", body, headers: init.headers ?? {} });
    const answer = await w.send(init.method ?? "GET", route, { json: body, headers: init.headers ?? {} });
    return { status: answer.status, ok: answer.status < 400, text: async () => answer.text, json: async () => JSON.parse(answer.text) };
  };
  const credentials = {
    get: async ({ publicKey }) => {
      assert.ok(publicKey.challenge instanceof ArrayBuffer, "the challenge is given to the browser as bytes");
      const made = passkey.get({ challenge: b64u(Buffer.from(publicKey.challenge)), origin: w.origin, rpId: publicKey.rpId });
      return { id: made.id, rawId: arrayBuffer(made.rawId), type: "public-key", response: { clientDataJSON: arrayBuffer(made.response.clientDataJSON), authenticatorData: arrayBuffer(made.response.authenticatorData), signature: arrayBuffer(made.response.signature), userHandle: null } };
    },
    create: async ({ publicKey }) => {
      assert.ok(publicKey.challenge instanceof ArrayBuffer && publicKey.user.id instanceof ArrayBuffer, "challenge and user handle are bytes");
      for (const entry of publicKey.excludeCredentials ?? []) assert.ok(entry.id instanceof ArrayBuffer, "so are the credentials to exclude");
      const made = passkey.create({ challenge: b64u(Buffer.from(publicKey.challenge)), origin: w.origin, rpId: publicKey.rp.id });
      return { id: made.id, rawId: arrayBuffer(made.rawId), type: "public-key", response: { clientDataJSON: arrayBuffer(made.response.clientDataJSON), attestationObject: arrayBuffer(made.response.attestationObject), getTransports: () => ["internal"] } };
    },
  };
  const location = { origin: w.origin, hash, assign: (url) => navigations.push(String(url)), replace: (url) => navigations.push(String(url)) };
  const browser = fakeBrowser(started.html ?? started.text, script, {
    fetch,
    location,
    navigator: { language: language, ...(webauthn ? { credentials } : {}) },
    extra: webauthn ? { PublicKeyCredential: function PublicKeyCredential() {} } : {},
    filename: "page.js",
  });
  await browser.ready;
  return { browser, navigations, requests, location };
}

const submit = async (ui, code) => {
  ui.browser.$("code").value = code;
  await ui.browser.$("form").dispatch("submit");
  await settle(20);
};

test("S7B consent: the page is served under the strict policy and says who asks for what: the app, where the owner goes back to, the book and the permissions", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const started = await startAuthorization(w, { slug, scope: "mcp:read mcp:write" });
    assert.equal(started.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(started.headers["content-security-policy"], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const html = started.html;
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]*Claude[^<]*<\/title>/);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, "one heading");
    assert.match(html, /<h1[^>]*>[^<]*Claude[^<]*<\/h1>/);
    assert.ok(html.includes("claude.example"), "where the owner will be sent back to");
    assert.ok(html.includes(`${PUBLIC_URL}/mcp/${slug}`), "the book's address");
    assert.match(html, /<link rel="stylesheet" href="\/oauth\/assets\/page\.css">/);
    assert.match(html, /<script src="\/oauth\/assets\/page\.js" defer><\/script>/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);

    const { page } = started;
    assert.deepEqual(Object.keys(page).sort(), ["bookInput", "client", "csrf", "lang", "messages", "passkeys", "requestId", "resource", "scopes"]);
    assert.match(page.requestId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(page.csrf, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([page.lang, page.bookInput, page.client], ["en", false, { name: "Claude", redirectHost: "claude.example" }]);
    assert.deepEqual(page.scopes.map((entry) => entry.scope), ["read", "write"], "only what the app asked for, and read");
    const again = await startAuthorization(w, { slug });
    assert.notEqual(again.page.requestId, page.requestId);
    assert.notEqual(again.page.csrf, page.csrf, "a token for each page");
    for (const key of ["admin_login", "too_many_attempts", "passkey_invalid", "challenge_expired", "request_expired", "invalid_target", "book_required", "csrf", "cancelled", "unsupported", "network", "error"]) {
      assert.equal(typeof page.messages[key], "string", `a message for ${key}`);
    }
  });
});

test("S7B consent: the page speaks the language of the browser, Italian or English, and English when it knows no other", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const languageOf = async (header) => {
      const started = await startAuthorization(w, { slug, headers: header === undefined ? {} : { "accept-language": header } });
      return { lang: started.page.lang, html: started.html, started };
    };
    const table = [
      [undefined, "en"], ["en-US,en;q=0.9", "en"], ["it", "it"], ["it-IT,it;q=0.9,en;q=0.8", "it"], ["en;q=0.5, it;q=0.9", "it"], ["fr-FR,fr;q=0.9", "en"], ["fr, it;q=0.5", "it"],
      ["de, en;q=0.1, it;q=0.9", "it"], ["*", "en"], ["", "en"], ["it;q=0, en", "en"], ["xx-garbage;;;q==", "en"], ["IT-it", "it"], [`${"it,".repeat(300)}en`, "it"],
    ];
    for (const [header, expected] of table) assert.equal((await languageOf(header)).lang, expected, JSON.stringify(header)?.slice(0, 40));

    const italian = await languageOf("it-IT,it;q=0.9");
    assert.match(italian.html, /<html lang="it">/);
    assert.match(italian.html, /Codice admin/);
    assert.match(italian.html, /Consenti/);
    assert.match(italian.html, /Rifiuta/);
    assert.doesNotMatch(italian.html, /Admin code|>Allow</);
    const english = await languageOf("en");
    assert.match(english.html, /Admin code/);
    assert.match(english.html, /Allow/);
    assert.match(english.html, /Deny/);
    assert.doesNotMatch(english.html, /Codice admin|Consenti/);
    assert.match(italian.started.page.messages.admin_login, /codice/i, "the messages of the script are Italian too");
    assert.match(english.started.page.messages.admin_login, /admin code/i);
  });
});

test("S7B consent: the page can be used with a keyboard and a screen reader: a language, one heading, a main part, a label for every field, text on every button, and a live region for what goes wrong", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    for (const header of ["en", "it"]) {
      const { html } = await startAuthorization(w, { slug, headers: { "accept-language": header } });
      assert.match(html, /<main\b/);
      const inputs = [...html.matchAll(/<input\b[^>]*>/g)].filter((match) => !/type="hidden"/.test(match[0]));
      assert.ok(inputs.length >= 4, "the three toggles and the code");
      for (const match of inputs) {
        const tag = match[0];
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        const before = html.slice(0, match.index);
        const insideLabel = before.lastIndexOf("<label") > before.lastIndexOf("</label>");
        const labelled = (id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(html)) || /\baria-label(?:ledby)?="/.test(tag) || insideLabel;
        assert.ok(labelled, `${header}: ${tag} has no label`);
      }
      for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(match[1].replace(/<[^>]*>/g, "").trim().length > 0, `${header}: a button without text`);
      assert.match(html, /\baria-live="(?:assertive|polite)"|role="alert"|role="status"/, `${header}: a live region`);
      assert.match(html, /<input[^>]*id="code"[^>]*type="password"|<input[^>]*type="password"[^>]*id="code"/, "the code is typed in a password field");
      assert.match(html, /autocomplete="(?:off|one-time-code|current-password)"/, "and the browser is not asked to keep it as a password of the site");
      assert.match(html, /<input[^>]*value="read"[^>]*(?:checked[^>]*disabled|disabled[^>]*checked)|<input[^>]*(?:checked[^>]*disabled|disabled[^>]*checked)[^>]*value="read"/, "read is on and cannot be turned off");
      assert.equal(/<img\b/i.test(html), false, "no pictures to describe");
    }
  });
});

test("S7B consent: what an app says about itself is text: a name with markup is escaped, a look-alike host is shown as it really is, and an address on this computer says so", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const evil = `<img src=x onerror=alert(1)>"'&</title><script>alert(2)</script>`;
    const markup = await startAuthorization(w, { slug });
    const shown = await registerApp(w, { client_name: evil, redirect_uris: [APP_REDIRECT] });
    const opened = await openConsent(w, { clientId: shown.client_id, redirectUri: APP_REDIRECT, challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` });
    assert.equal(opened.status, 200);
    assert.equal(opened.text.includes("<img src=x"), false);
    assert.equal(opened.text.includes("<script>alert"), false);
    assert.equal(opened.text.includes("</title><script"), false);
    assert.ok(opened.text.includes("&lt;img src=x onerror=alert(1)&gt;"), "shown as text");
    assert.equal(opened.page.client.name, evil, "and the script gets it whole, from an attribute that is escaped too");
    assert.equal(markup.page.client.name, "Claude");

    const lookalike = await registerApp(w, { client_name: "Claude", redirect_uris: ["https://аррӏе.example/cb"] });
    const homograph = await openConsent(w, { clientId: lookalike.client_id, redirectUri: "https://аррӏе.example/cb", challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` });
    assert.equal(homograph.status, 200);
    assert.match(homograph.page.client.redirectHost, /^xn--[a-z0-9-]+\.example$/, "an address with look-alike letters is shown in its real, ASCII form");

    const withPort = await registerApp(w, { redirect_uris: ["https://app.example:8443/cb"] });
    assert.equal((await openConsent(w, { clientId: withPort.client_id, redirectUri: "https://app.example:8443/cb", challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` })).page.client.redirectHost, "app.example:8443");

    const local = await registerApp(w, { redirect_uris: [LOCAL_REDIRECT] });
    const onThisComputer = await openConsent(w, { clientId: local.client_id, redirectUri: LOCAL_REDIRECT, challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` });
    assert.equal(onThisComputer.page.client.redirectHost, "127.0.0.1:8765");
    assert.match(onThisComputer.text, /on this computer|on the computer/i, "an app that sends the owner to an address of his own computer says so: that computer is the one at the browser, not the server");
    const italian = await openConsent(w, { clientId: local.client_id, redirectUri: LOCAL_REDIRECT, challenge: pkce().challenge, resource: `${server.url}/mcp/${slug}` }, { headers: { "accept-language": "it" } });
    assert.match(italian.text, /su questo computer|sul computer/i);
  });
});

test("S7B consent: an error page says what is wrong in the language of the browser, with no script and nothing that was sent turned into a link", async () => {
  await withServer(async (server) => {
    const w = web(server);
    for (const [header, pattern] of [["en", /not recognised|unknown|cannot/i], ["it", /riconosciut|sconosciut|impossibile/i]]) {
      const answer = await w.get(`/oauth/authorize?client_id=${encodeURIComponent("<b>x</b>")}&redirect_uri=https://evil.example`, { headers: { "accept-language": header } });
      assert.equal(answer.status, 400);
      assert.match(answer.text, new RegExp(`<html lang="${header}">`));
      assert.match(answer.text, pattern);
      assert.equal(answer.text.includes("<b>x</b>"), false);
      assert.equal(/href="[^"]*evil\.example/.test(answer.text), false);
      assert.equal(/<script/i.test(answer.text), false, "an error page needs no script");
      assert.equal(/<form/i.test(answer.text), false, "and offers nothing to approve");
    }
  });
});

test("S7B consent: the script and the style are served from the server itself, as text, with nothing in them that builds markup from data", async () => {
  await withServer(async (server) => {
    const w = web(server);
    const script = await w.get("/oauth/assets/page.js");
    const style = await w.get("/oauth/assets/page.css");
    assert.deepEqual([script.status, script.headers["content-type"]], [200, "text/javascript; charset=utf-8"]);
    assert.deepEqual([style.status, style.headers["content-type"]], [200, "text/css; charset=utf-8"]);
    assert.ok(script.text.length > 1000 && style.text.length > 200);
    assert.equal(/\burl\(\s*["']?https?:/i.test(style.text), false, "the style loads nothing from elsewhere");
    assert.equal(/@import/i.test(style.text), false);
    assert.equal(/https?:\/\//.test(script.text), false, "the script talks to the server it came from, with relative addresses");
    assert.equal((await w.get("/oauth/assets/page.map")).status, 404);
  });
});

test("S7B consent script: the admin code, the toggles, and a redirect to the app with a code that works", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const started = await startAuthorization(w, { slug, scope: "mcp:read mcp:write mcp:run" });
    const ui = await openPage(w, started);
    const toggles = ui.browser.all('input[name="scope"]');
    assert.deepEqual(toggles.map((toggle) => [toggle.attributes.value, toggle.checked, toggle.disabled]), [["read", true, true], ["write", false, false], ["run", false, false]]);
    assert.equal(ui.browser.$("passkey").hidden, true, "no passkey here: the button is not offered");

    await submit(ui, "not the code");
    assert.equal(ui.browser.$("message").textContent, started.page.messages.admin_login);
    assert.equal(ui.navigations.length, 0);
    assert.equal(ui.browser.$("approve").disabled, false, "and the owner can try again");
    assert.equal(ui.browser.$("code").value === "not the code" || ui.browser.$("code").value === "", true);

    toggles[1].checked = true;
    await submit(ui, await adminCode(server));
    const approval = ui.requests.find((request) => request.route === "/oauth/authorize/approve" && request.body.proof.code !== "not the code");
    assert.deepEqual(approval.body.scopes, ["read", "write"]);
    assert.equal(approval.headers["x-csrf-token"], started.page.csrf);
    assert.equal(approval.body.requestId, started.page.requestId);
    assert.equal(ui.navigations.length, 1);
    const back = new URL(ui.navigations[0]);
    assert.equal(`${back.origin}${back.pathname}`, LOCAL_REDIRECT);
    assert.equal(back.searchParams.get("state"), "state-1");
    const tokens = await exchange(w, { code: codeOf(ui.navigations[0]), verifier: started.verifier, clientId: started.app.client_id, redirectUri: started.redirectUri, resource: started.resource });
    assert.equal(tokens.json.scope, "mcp:read mcp:write");
  });
});

test("S7B consent script: Deny sends the app back with access_denied, and a book that is not named asks the owner for it", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const w = web(server);
    const denying = await openPage(w, await startAuthorization(w, { slug }));
    await denying.browser.$("deny").click();
    await settle(20);
    assert.equal(new URL(denying.navigations[0]).searchParams.get("error"), "access_denied");

    const started = await startAuthorization(w, { slug, resource: null });
    const ui = await openPage(w, started);
    assert.equal(started.page.bookInput, true);
    ui.browser.$("book").value = "no-such-book";
    await submit(ui, await adminCode(server));
    assert.equal(ui.browser.$("message").textContent, started.page.messages.invalid_target);
    assert.equal(ui.navigations.length, 0);
    ui.browser.$("book").value = `${server.url}/mcp/${slug}`;
    await submit(ui, await adminCode(server));
    assert.equal(ui.requests.at(-1).body.book, `${server.url}/mcp/${slug}`);
    assert.equal(ui.navigations.length, 1);
  });
});

test("S7B consent script: on the public address the admin code offers a passkey, and adding it or not leads to the app all the same", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const passkey = new SoftwarePasskey();

    const skipping = await openPage(w, await startAuthorization(w, { slug }), { passkey });
    assert.equal(skipping.browser.$("offer").hidden, true, "nothing is offered before the code");
    await submit(skipping, await adminCode(server));
    assert.equal(skipping.browser.$("offer").hidden, false, "after the code");
    assert.equal(skipping.navigations.length, 0, "and the owner is not sent away before he has answered");
    await skipping.browser.$("offer-skip").click();
    await settle(20);
    assert.equal(skipping.navigations.length, 1);
    assert.equal(skipping.requests.some((request) => request.route === "/oauth/passkeys/register"), false);

    const adding = await openPage(w, await startAuthorization(w, { slug }), { passkey });
    await submit(adding, await adminCode(server));
    adding.browser.$("offer-label").value = "Alessandro's phone";
    await adding.browser.$("offer-add").click();
    await settle(30);
    const register = adding.requests.find((request) => request.route === "/oauth/passkeys/register");
    assert.equal(register.body.label, "Alessandro's phone");
    assert.equal(register.body.credential.id, passkey.id);
    assert.equal(typeof register.body.credential.response.attestationObject, "string", "the browser's bytes go as text");
    assert.deepEqual(register.body.credential.response.transports, ["internal"]);
    assert.equal(adding.navigations.length, 1, "then to the app");

    const next = await startAuthorization(w, { slug });
    assert.equal(next.page.passkeys.available, true);
    const using = await openPage(w, next, { passkey });
    assert.equal(using.browser.$("passkey").hidden, false, "the passkey button is there now");
    await using.browser.$("passkey").click();
    await settle(30);
    assert.deepEqual(using.requests.map((request) => request.route), ["/oauth/authorize/challenge", "/oauth/authorize/approve"]);
    const approve = using.requests[1].body;
    assert.deepEqual(Object.keys(approve.proof.credential.response).sort(), ["authenticatorData", "clientDataJSON", "signature"].sort(), "no user handle when the browser sends none");
    assert.equal(using.navigations.length, 1);
    assert.match(using.navigations[0], /^https:\/\/claude\.example\/api\/mcp\/auth_callback\?/);
  });
});

test("S7B consent script: a passkey the owner cancels, or a browser that has none, leaves the admin code and a message, and does not break the page", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const passkey = new SoftwarePasskey();
    await enrollPasskey(server, passkey, { slug });
    const started = await startAuthorization(w, { slug });

    const without = await openPage(w, started, { webauthn: false });
    assert.equal(without.browser.$("passkey").hidden || without.browser.$("passkey").disabled, true, "a browser without WebAuthn is not offered a passkey");

    const cancelling = await openPage(w, started, { passkey });
    cancelling.browser.window.navigator.credentials.get = async () => {
      throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    };
    await cancelling.browser.$("passkey").click();
    await settle(20);
    assert.equal(cancelling.browser.$("message").textContent, started.page.messages.cancelled);
    assert.equal(cancelling.navigations.length, 0);
    assert.equal(cancelling.browser.$("passkey").disabled, false, "and he can try again");
    await submit(cancelling, await adminCode(server));
    assert.equal(cancelling.browser.$("offer").hidden, false, "the admin code still works, and on the public address it offers a passkey again");
    await cancelling.browser.$("offer-skip").click();
    await settle(20);
    assert.equal(cancelling.navigations.length, 1);
  });
});

test("S7B consent script: the page that adds a passkey takes its ticket from the address after the #, never from what the server saw, and registers the one the owner makes", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const w = web(server, { host: PUBLIC_HOST });
    const connected = await connectApp(server, { slug, w });
    const ticket = connected.approved.passkeyOffer.ticket;
    const page = await w.get("/oauth/passkeys/add");
    assert.equal(page.status, 200);
    assert.equal(page.text.includes(ticket), false);
    assert.match(page.text, /<html lang="en">/);
    assert.equal(pageState(page.text).kind, "register");
    assert.equal((await w.get(`/oauth/passkeys/add?ticket=${ticket}`)).text.includes(ticket), false, "a ticket in the query is not read, and not repeated");

    const passkey = new SoftwarePasskey();
    const ui = await openPage(w, { html: page.text }, { passkey, hash: `#${ticket}` });
    ui.browser.$("passkey-label").value = "Laptop";
    await ui.browser.$("register").click();
    await settle(40);
    assert.deepEqual(ui.requests.map((request) => request.route), ["/oauth/passkeys/options", "/oauth/passkeys/register"]);
    assert.equal(ui.requests[0].body.ticket, ticket);
    assert.equal(ui.requests[1].body.label, "Laptop");
    assert.equal(ui.browser.$("message").textContent, pageState(page.text).messages.registered);
    const approved = await approveWithPasskey(w, (await startAuthorization(w, { slug })).page, { passkey });
    assert.equal(approved.status, 200, "the passkey that was made on that page works");

    const spent = await openPage(w, { html: page.text }, { passkey: new SoftwarePasskey(), hash: `#${ticket}` });
    await spent.browser.$("register").click();
    await settle(40);
    assert.equal(spent.browser.$("message").textContent, pageState(page.text).messages.ticket_invalid, "a link that was used says so");
    const none = await openPage(w, { html: page.text }, { passkey: new SoftwarePasskey(), hash: "" });
    await none.browser.$("register").click();
    await settle(20);
    assert.equal(none.requests.length, 0, "no ticket, no request");
    assert.equal(none.browser.$("message").textContent, pageState(page.text).messages.ticket_invalid);
  });
});
