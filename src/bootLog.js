// ── Startup instrumentation (diagnostics) ─────────────────────────────────
// Collects a timeline of launch milestones and prints a single console table
// once startup activity goes quiet (REPORT_QUIET_MS). Every row is a candidate
// for optimization: a big Δ means something blocking happened between the two
// marks, a big `dur` means an awaited IPC call was slow.
//
// Timestamps are `performance.now()` (ms since this webview's navigation
// start). The Rust side reports its own phases on the same wall clock, so
// both halves land in one comparable table.
//
// Silence entirely with:  localStorage.setItem("minitc-boot-log", "off")

import { invoke } from "@tauri-apps/api/core";

const OFF_KEY = "minitc-boot-log";

let enabled = true;
try {
  enabled =
    window.__MINITC_BOOT_LOG__ !== false &&
    localStorage.getItem(OFF_KEY) !== "off";
} catch {
  /* localStorage unavailable — keep logging on */
}

const REPORT_QUIET_MS = 400;
// The timeline is only complete once the splash is gone, so callers can name a
// mark to hold the report for. If it never arrives (e.g. the splash element
// was already removed), fall back to printing anyway.
const GATE_TIMEOUT_MS = 4000;

const marks = [];
let reportTimer = null;
let rustPrinted = false;
let reported = false;
let gate = null;

function now() {
  return performance.now();
}

/// Record a milestone. `at` is ms since navigation start.
export function mark(name, detail) {
  if (!enabled) return;
  marks.push({ name, at: now(), dur: null, detail: detail || "" });
  scheduleReport();
}

/// Record how long an already-started async boot task takes. The mark lands
/// when the promise settles; `dur` is its total wall time. The promise itself
/// is passed through untouched (errors still propagate to the caller).
export function track(name, promise, detail) {
  if (!enabled) return promise;
  const start = now();
  Promise.resolve(promise).then(
    () => {
      marks.push({ name, at: now(), dur: now() - start, detail: detail || "" });
      scheduleReport();
    },
    (e) => {
      marks.push({
        name,
        at: now(),
        dur: now() - start,
        detail: "FAILED: " + (e && e.message ? e.message : String(e)),
      });
      scheduleReport();
    }
  );
  return promise;
}

/// Hold the report until `name` has been marked (see GATE_TIMEOUT_MS).
export function waitFor(name) {
  gate = name;
}

/// Adopt marks recorded by the inline <script> in index.html, which runs
/// before this module is evaluated (and therefore before `enabled` existed).
export function adopt(entries) {
  if (!enabled || !Array.isArray(entries)) return;
  for (const [name, at] of entries) {
    marks.push({ name, at, dur: null, detail: "" });
  }
}

function scheduleReport() {
  if (reported) return;
  if (reportTimer) clearTimeout(reportTimer);
  const gated = gate && !marks.some((m) => m.name === gate);
  reportTimer = setTimeout(report, gated ? GATE_TIMEOUT_MS : REPORT_QUIET_MS);
}

function report() {
  reportTimer = null;
  reported = true;
  if (!marks.length) return;

  const rows = [...marks].sort((a, b) => a.at - b.at).map((m, i, arr) => ({
    phase: m.name,
    at: +m.at.toFixed(1),
    "Δ": i === 0 ? 0 : +(m.at - arr[i - 1].at).toFixed(1),
    dur: m.dur == null ? "" : +m.dur.toFixed(1),
    note: m.detail,
  }));

  const total = rows[rows.length - 1].at - rows[0].at;
  console.groupCollapsed(
    `%c[boot] mini-tc startup ${total.toFixed(0)} ms`,
    "color:#58a6ff;font-weight:600"
  );
  console.table(rows);
  console.groupEnd();

  printRustTimings();
}

// Rust-side phases (process start → plugin init → webview creation) live in
// `src-tauri/src/lib.rs` and are fetched once, here, so the JS table above and
// the native table below share the same clock.
async function printRustTimings() {
  if (rustPrinted) return;
  rustPrinted = true;
  try {
    const t = await invoke("boot_timings");
    const origin = performance.timeOrigin;
    const rows = [
      {
        phase: "process start",
        at: +(t.process_start_unix_ms - origin).toFixed(1),
        "Δ": "",
        dur: 0,
        note: "main() entered",
      },
      ...t.phases.map((p) => ({
        phase: p.name,
        at: +(t.process_start_unix_ms + p.ms - origin).toFixed(1),
        "Δ": "",
        dur: +p.ms.toFixed(1),
        note: "",
      })),
      // The last native milestone worth knowing: when the webview handed the
      // first HTML to the parser (`performance.timeOrigin`). Subtract the
      // preceding phase (setup) from this to see how much of the native half
      // is webview creation vs. waiting on the dev server / asset load.
      {
        phase: "html parse start",
        at: 0,
        "Δ": "",
        dur: +(origin - t.process_start_unix_ms).toFixed(1),
        note: "webview ready, first HTML byte",
      },
    ];
    console.groupCollapsed(
      `%c[boot] rust side ${rows[rows.length - 1].dur.toFixed(0)} ms`,
      "color:#3fb950;font-weight:600"
    );
    console.table(rows);
    console.groupEnd();
  } catch {
    /* boot_timings unavailable — JS-only timeline is still useful */
  }
}
