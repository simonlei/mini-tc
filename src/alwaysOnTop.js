import { getCurrentWindow } from "@tauri-apps/api/window";

// ── Window always-on-top controller ──
// Always-on-top is an OS *window* property, not a DOM one: no browser API can
// raise a single element (e.g. the <video> inside the preview panel) above
// other applications' windows. So while a video preview is open we raise the
// whole main window instead, and drop it back when the preview goes away.
//
// State lives here rather than in App.vue so that (a) the "am I currently
// on top?" bookkeeping survives across the many call sites that can change the
// preview state, and (b) the reducer logic is testable in isolation.

// What we have asked the OS for. `null` = unknown (never touched this session).
// Used to suppress redundant IPC: the preview state changes on every arrow-key
// navigation between clips, and each transition would otherwise re-issue the
// same call.
let applied = null;

// User preference (设置 → 通用设置 → 视频预览时窗口置顶). When false we never
// raise the window, no matter what the preview is doing.
let enabled = false;

/// Set the user preference. Turning it off while a preview is open immediately
/// un-pins the window.
export function setEnabled(v) {
  enabled = !!v;
  if (!enabled) apply(false);
}

/// Reconcile the window against the current preview state. `want` is true when
/// a video preview is showing. Safe to call on every state change — it only
/// issues an IPC call when the desired state actually differs.
export function sync(want) {
  apply(!!want && enabled);
}

async function apply(on) {
  if (applied === on) return;
  // Record the intent before awaiting so overlapping calls can't interleave
  // into a stale final state: whoever asked LAST owns the guard, and Tauri
  // dispatches window ops in order, so the last request also wins at the OS.
  applied = on;
  try {
    await getCurrentWindow().setAlwaysOnTop(on);
  } catch (e) {
    // The call threw, so the OS state is unknown. Reset the guard rather than
    // leaving it lying about reality — otherwise a transient failure would
    // permanently pin (or un-pin) the window for the rest of the session.
    // Note this also discards any newer intent set while we were awaiting; the
    // next sync() call re-issues it, which is the safe direction to err in.
    applied = null;
    console.error("setAlwaysOnTop failed:", e);
  }
}

/// Force the window back to normal z-order. Called on teardown so we never exit
/// leaving a pinned window behind (a stray topmost window would linger over
/// other apps until the process dies).
export async function reset() {
  applied = false;
  try {
    await getCurrentWindow().setAlwaysOnTop(false);
  } catch {
    // Teardown is best-effort; a failure here is not actionable.
  }
}
