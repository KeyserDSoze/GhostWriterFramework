/**
 * "Remember this device" in the admin panel: the page keeps the device token that the server made (and nothing of the admin code), signs in with it when its session has ended, and lists the
 * devices on the Security page, where each can be revoked. The token is in `localStorage` under a key of this address (scheme, host and port), so two servers on one computer do not mix them
 * up, and it is deleted as soon as the server says that it does not know it. Like the rest of the panel, everything the server says is put in as text.
 */

export const DEVICES_HTML = `<section class="panel" id="devices">
        <div class="panel-head"><h2 id="devices-title" data-i18n="devicesTitle">Remembered devices</h2><button type="button" class="ghost danger small" id="devices-revoke-all" data-i18n="devRevokeAll">Revoke all devices</button></div>
        <p class="panel-help" data-i18n="devicesHelp">Browsers that signed in with “Remember this device forever”. Each holds a random key that this server can check but cannot read back. A device that is revoked asks for the admin code again.</p>
        <div class="table-wrap" tabindex="0" role="region" aria-labelledby="devices-title"><table class="stack" role="table" aria-labelledby="devices-title"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col" data-i18n="devName">Device</th><th role="columnheader" scope="col" data-i18n="devSince">Remembered since</th><th role="columnheader" scope="col" data-i18n="devLast">Last used</th><th role="columnheader" scope="col"><span class="sr-only" data-i18n="colActions">Actions</span></th></tr></thead><tbody role="rowgroup" id="device-rows"></tbody></table></div>
        <p class="notice hidden" id="device-warning" role="status"></p>
      </section>`;

/** Runs inside the panel's own function: it uses its `t`, `pick`, `el`, `call`, `when`, `$`, `csrf`, `toast`, `fail`, `signOut` and the helpers of the views. */
export const DEVICES_JS = String.raw`  // ---- remembered devices
  var DEVICE_KEY = "narrarium-admin-device:" + location.origin;
  var devices = null;
  var silentRun = null;
  function readDevice() {
    try { var saved = JSON.parse(localStorage.getItem(DEVICE_KEY) || "null"); return saved && typeof saved.id === "string" && typeof saved.token === "string" ? saved : null; } catch (error) { return null; }
  }
  function saveDevice(device) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: device.id, token: device.token })); } catch (error) { /* a browser that keeps nothing just asks for the code */ } }
  function forgetDevice() { try { localStorage.removeItem(DEVICE_KEY); } catch (error) { /* nothing to forget */ } }
  /** An error that says that this page cannot sign in by itself: the sign-in is shown. */
  function rejection(message) { var error = new Error(message); error.rejected = true; return error; }
  /** Sign in with the device's token, one at a time however many requests found the session over. A token that the server refuses is deleted here; one that could not be tried (offline, too many attempts) is kept. */
  function silentLogin() {
    if (silentRun) return silentRun;
    var device = readDevice();
    if (!device) return Promise.reject(rejection(t("sessionExpired")));
    silentRun = fetch("/admin/api/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ deviceToken: device.token }) }).then(function (response) {
      return response.text().then(function (text) {
        var data = {}; try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
        if (response.ok && typeof data.csrf === "string") { csrf = data.csrf; sessionStorage.setItem("narrarium-admin-csrf", csrf); return true; }
        if (response.status === 401) { forgetDevice(); throw rejection(t("deviceRejected")); }
        throw new Error(data.message || ("HTTP " + response.status));
      });
    }).then(function (value) { silentRun = null; return value; }, function (error) { silentRun = null; throw error; });
    return silentRun;
  }
  function deviceName(label) { var unknown = "Unknown browser"; return String(label).indexOf(unknown) === 0 ? t("devUnknown") + String(label).slice(unknown.length) : String(label); }
  function renderDevices() {
    if (!devices) return;
    var body = $("device-rows"); body.textContent = ""; var mine = readDevice(); var list = devices.devices || [];
    if (!list.length) emptyRow(body, 4, t("devicesNone"));
    list.forEach(function (device) {
      var isMine = !!mine && mine.id === device.id;
      var row = trow(); var name = rowHead(); name.appendChild(el("div", "", deviceName(device.label)));
      if (isMine) name.appendChild(badge(t("devThis"), "info", "●"));
      row.appendChild(name);
      var since = tcell("devSince", "nowrap"); since.textContent = when(device.createdAt); row.appendChild(since);
      var last = tcell("devLast", "nowrap"); last.textContent = when(device.lastUsedAt); row.appendChild(last);
      var actions = tcell("colActions"); var revoke = el("button", "ghost small danger", t("devRevoke")); revoke.type = "button";
      revoke.setAttribute("aria-label", t("devRevoke") + ": " + deviceName(device.label));
      revoke.addEventListener("click", function () { revokeDevice(device, isMine); });
      actions.appendChild(revoke); row.appendChild(actions); body.appendChild(row);
    });
    $("devices-revoke-all").disabled = !list.length;
    var warning = $("device-warning"); warning.textContent = devices.warning ? t("devicesDamaged") : "";
    if (devices.warning) warning.classList.remove("hidden"); else warning.classList.add("hidden");
    renderChrome();
  }
  function loadDevices() { return call("GET", "/admin/api/devices").then(function (data) { if (signed) { devices = data; renderDevices(); } }, function () { if (signed) clearLoading("device-rows"); }); }
  /** Revoking this very device ends this session too: the page says so and shows the sign-in. */
  function revokeDevice(device, isMine) {
    if (!confirm(t("devRevokeConfirm"))) return;
    call("POST", "/admin/api/devices/revoke", { id: device.id }).then(function () {
      if (isMine) { forgetDevice(); signOut(t("devRevokedThis")); } else { toast(t("devRevoked")); loadDevices(); }
    }, fail);
  }
  function revokeAllDevices() {
    if (!confirm(t("devRevokeAllConfirm"))) return;
    call("POST", "/admin/api/devices/revoke-all", {}).then(function (result) {
      if (readDevice()) { forgetDevice(); signOut(t("devRevokedThis")); } else { toast(plural("devRevokedAll", result.revoked, { n: result.revoked })); loadDevices(); }
    }, fail);
  }
  function resetDevices() { devices = null; $("device-rows").textContent = ""; $("device-warning").textContent = ""; $("device-warning").classList.add("hidden"); }
  function bindDevices() { $("devices-revoke-all").addEventListener("click", revokeAllDevices); }
`;
