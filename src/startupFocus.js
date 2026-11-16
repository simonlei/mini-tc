// ── Startup keyboard focus ──
//
// Cold start used to leave document.activeElement on <body>: the only code that
// ever handed focus to a file list was the *window focus regain* handler (and
// the preview-restore path, which only runs when a preview was open on exit).
// Neither fires on a launch where the window already owns system focus, so ↑/↓,
// Enter and Tab did nothing until the user clicked a row by hand.
//
// The fix has two halves, and both live outside this file:
//   • App.vue persists which panel was active, so "the file list of the tab I
//     was last using" is the one that gets focus (each panel restores its own
//     active tab from tabs-<panelId>.json).
//   • App.vue waits for the splash to be gone, then calls that panel's
//     focusList(). main.js already holds the splash up until BOTH panels have
//     listed, so splash removal is the single "the restored tab is on screen"
//     signal — no second counter that can get out of sync.
//
// This module owns the *decision*: when it is safe to claim focus, and when to
// stop trying. It is deliberately DOM-free so scripts/startup-focus-check.mjs
// can run the whole truth table in plain Node.

/// Hard ceiling on the wait. main.js fades the splash out after at most
/// SPLASH_MAX_SHOW_MS (2500ms) + SPLASH_FADE_MS (250ms); a little slack covers
/// the transitionend event never arriving (reduced-motion / CSS disabled).
export const STARTUP_FOCUS_TIMEOUT_MS = 3200;

/// rAF ticks before giving up entirely (~4s at 60fps). Bounds the loop even
/// when the window never gains system focus (user launched and switched away).
export const STARTUP_FOCUS_MAX_FRAMES = 240;

/// focusList() calls. focus() on a document without system focus is silently
/// dropped, so a few retries are expected — but an unbounded retry would keep
/// yanking focus back after the user started interacting.
export const STARTUP_FOCUS_MAX_ATTEMPTS = 8;

/// Only two panels exist. A hand-edited/corrupt view-state.json must never be
/// able to name a third one — otherwise both the active-panel outline and the
/// startup focus would land on nothing. Shared by viewState.js's sanitizer and
/// kept here so the rule is testable in plain Node.
export function normalizeActivePanel(value) {
  return value === "left" || value === "right" ? value : null;
}

/// True when the keyboard is already on a file list. The list container is the
/// `tabindex="0"` `.file-list` div in FileList.vue.
export function isListFocused(activeElement) {
  return !!(
    activeElement &&
    activeElement.classList &&
    typeof activeElement.classList.contains === "function" &&
    activeElement.classList.contains("file-list")
  );
}

/// ...AND that list belongs to `panelId`. A window-focus event can fire very
/// early in a launch (before the saved active panel has been applied) and put
/// the caret on the default left panel's list. Treating "some list has focus"
/// as success would then silently leave the user in the wrong tab. FilePanel's
/// root carries `data-panel-id`, so this is exact rather than order-dependent.
export function isListFocusedInPanel(activeElement, panelId) {
  if (!isListFocused(activeElement)) return false;
  const panel =
    typeof activeElement.closest === "function"
      ? activeElement.closest(".file-panel")
      : null;
  return !!(panel && panel.dataset && panel.dataset.panelId === panelId);
}

/**
 * Decide what the startup focus loop should do on this tick.
 *
 * Returns one of:
 *   "wait"  — keep ticking (saved state not applied yet, splash still up, or
 *             the webview does not own system focus yet)
 *   "focus" — call the active panel's focusList() once
 *   "stop"  — done: either focus landed, the user is typing / inside a
 *             preview surface (never steal that focus), or we ran out of
 *             attempts/frames
 *
 * `timedOut` relaxes the splash/panels gate, NOT the guard rails: a slow launch
 * should still end up with a focused list, but must never steal focus from a
 * live interaction.
 */
export function startupFocusDecision({
  stateReady = true,
  splashGone = false,
  timedOut = false,
  frames = 0,
  maxFrames = STARTUP_FOCUS_MAX_FRAMES,
  attempts = 0,
  maxAttempts = STARTUP_FOCUS_MAX_ATTEMPTS,
  hasSystemFocus = true,
  typingTarget = false,
  inPreviewSurface = false,
  listFocused = false,
} = {}) {
  if (listFocused) return "stop";
  // Same guard rails as the window-focus-regain handler: never yank the caret
  // out of an address bar / filter / inline rename, nor out of a preview.
  if (typingTarget || inPreviewSurface) return "stop";
  if (frames >= maxFrames) return "stop";
  if (attempts >= maxAttempts) return "stop";

  // `stateReady` matters: the saved active panel arrives from an async config
  // read. Focusing before it lands would put the caret in the DEFAULT left
  // panel, i.e. the wrong tab for anyone who was working on the right.
  const ready = timedOut || (stateReady && splashGone);
  if (!ready) return "wait";
  // WebView2 is created hidden (tauri.conf.json "visible": false). Calling
  // focus() before the window owns system focus is a silent no-op; wait for
  // the window to come up instead of burning an attempt on a doomed call.
  if (!hasSystemFocus) return "wait";
  return "focus";
}
