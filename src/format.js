// Human-readable byte size — the ONE implementation for the whole UI.
//
// This lived as eight near-copies (App.vue, FileList.vue, FilePanel.vue,
// FilePreview.vue, PathBar.vue, SearchDialog.vue, VideoPreview.vue's `fmtSize`,
// plus an earlier App.vue duplicate) and had already drifted on screen. All the
// figures below were measured by running the old copies verbatim
// (`scripts/format-size-check.mjs` arm ⑤ re-runs them), not reasoned about:
//
//   • `FilePreview.vue` — units capped at 4 with no index clamp:
//       2 TB   -> "2.0 undefined"      (i = 4, past the end)
//       0.5 B  -> "512.0 undefined"    (i = -1, see below)
//     while `SearchDialog.vue` clamped and rendered "2.0 TB" — the same file,
//     two different strings on screen at once.
//   • `FileList.vue` — units capped at 5 with no clamp:
//       1 PB   -> "1.0 undefined"      (i = 5, past the end)
//   • `FileList.vue` / `FilePreview.vue` guarded only `bytes === 0`, so a
//     missing `entry.size` ran `Math.log(undefined) = NaN`:
//       undefined -> "NaN undefined"
//   • The sub-1024 rendering differed per copy (`String(bytes)` vs
//     `val.toFixed(0)`). Worth stating precisely: this one had **no**
//     reachable consequence in practice — the copies agreed on every integer
//     below 1024, and fractional inputs never got that far because they
//     produced a negative index first. It is kept as `String` as a cheap
//     guarantee, not as a bug fix. Do not cite it as one.
//
// So there are three independent guards below, each covering one of the two
// ways an unguarded index escapes the units array:
//
//   • Clamp the index **both ways** (`Math.max(0, Math.min(...))`). An upper
//     clamp alone leaves the lower end open: any value below 1 byte yields
//     `log < 0` → `i = -1` → `units[-1]` → "undefined" inside a plausible
//     string. Both bounds were observed failing on the old copies.
//   • `Number.isFinite` + `<= 0` **before** the logarithm. `Math.log(negative)`
//     is NaN and `Math.log(Infinity)` is Infinity; both sail past a bare
//     `!bytes` check (which only rejects 0, null, undefined, "") and then index
//     out of range — the exact failure above.
//   • Rejecting the string "1024" rather than coercing it: the backend size is
//     a `u64`, so a string there means the IPC contract is broken, and silently
//     formatting it would hide that.
//
// One deliberate limit: inputs beyond the `u64` ceiling (max 2^64-1 bytes ≈ 16
// EB) clamp their *index* but not their *magnitude*, so 1e30 renders as
// "888178419700125.3 PB". That is arithmetically honest and unreachable in
// practice — the backend cannot report a size larger than u64 — so it is not
// worth truncating the number and lying about it.
//
// `empty` is the only per-caller difference worth keeping: PathBar shows a
// placeholder for an absent capacity because "0 B free" would be a lie, and
// VideoPreview shows nothing because it has no size to show.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const STEP = 1024;
const LAST = UNITS.length - 1;

/// Format `bytes` for display. `empty` is returned for anything that is not a
/// finite positive number (undefined, null, NaN, negative, Infinity, string).
export function formatBytes(bytes, empty = "0 B") {
  if (!Number.isFinite(bytes) || bytes <= 0) return empty;

  const i = Math.max(
    0,
    Math.min(LAST, Math.floor(Math.log(bytes) / Math.log(STEP)))
  );
  // `String` at i === 0 because the value already IS the byte count;
  // `toFixed(1)` would dress a bare "512" up as "512.0".
  const v = i === 0 ? String(bytes) : (bytes / Math.pow(STEP, i)).toFixed(1);
  return v + " " + UNITS[i];
}
