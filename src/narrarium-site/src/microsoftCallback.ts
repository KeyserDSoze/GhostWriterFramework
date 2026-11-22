// Return page of the Microsoft sign-in window (auth/microsoft-callback.html). Deliberately tiny and without imports:
// it reads code, state and error from the address, tells the window that opened it (and a BroadcastChannel named after
// the state, in case the browser cut that link), and closes. It logs nothing and keeps nothing.
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "";
const code = params.get("code") ?? "";
const error = params.get("error") ?? "";

// The code does not stay in the address bar or in the history.
window.history.replaceState(null, "", window.location.pathname);

const usable = state.length > 0 && state.length <= 128 && (error ? error.length <= 64 : code.length > 0 && code.length <= 4096);

if (usable) {
  // Only the error code travels, never Microsoft's description of it.
  const message = error ? { type: "narrarium:microsoft-callback", error, state } : { type: "narrarium:microsoft-callback", code, state };
  try {
    window.opener?.postMessage(message, window.location.origin);
  } catch {
    // The opener cannot be reached: the channel below still can.
  }
  try {
    const channel = new BroadcastChannel(`narrarium-microsoft-callback:${state}`);
    channel.postMessage(message);
    channel.close();
  } catch {
    // No BroadcastChannel: the opener has the message already.
  }
  window.close();
}
