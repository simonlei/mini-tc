// Pure decision logic for the duplicate-file dialog.
//
// Split out of DedupDialog.vue for the same reason deleteScope.js / paths.js
// exist: a judgement that decides WHICH FILE GETS DELETED must be testable from
// plain node. `vite build` and `cargo check` both pass happily over a
// reversed comparison here, and the only symptom is that the user's newest
// copy is the one that disappears.
//
// Everything here is pure — no IPC, no filesystem. The dialog owns the state,
// this module only answers questions about it.

/// One file in a duplicate group, as the backend reports it.
export function makeFile(path, size, modified, dir = "", name = "") {
  return {
    path,
    size,
    modified,
    dir,
    name: name || path.split(/[\\/]/).pop() || path,
  };
}

/// Make one file per group the keeper.
///
/// Rule: the most recently modified copy survives (newest wins), ties broken by
/// path so the choice is deterministic across rescans of the same folder.
///
/// Returns a Map keyed by `groupIndex` → index INTO the group's file array.
/// Index-based on purpose: it is what the radio group and the checkbox logic
/// both speak, and it stays valid when the group is re-sorted.
export function defaultKeepers(groups) {
  const keepers = new Map();
  groups.forEach((g, gi) => {
    const files = g.files || [];
    if (!files.length) return;
    let best = 0;
    for (let i = 1; i < files.length; i++) {
      if (isNewer(files[i], files[best])) best = i;
    }
    keepers.set(gi, best);
  });
  return keepers;
}

/// True when `a` should be preferred over `b` as the copy to keep.
export function isNewer(a, b) {
  const am = a.modified || 0;
  const bm = b.modified || 0;
  if (am !== bm) return am > bm;
  // Deterministic tie-break: the lexicographically SMALLER path wins. Which
  // index that lands on depends on the group's order, and the backend sorts by
  // path, so the choice is stable across rescans of the same folder.
  return String(a.path) < String(b.path);
}

/// Files that would be deleted: every member of every group except the keeper
/// the user currently has selected.
///
/// This is the function that makes the confirmation dialog honest — whatever it
/// returns is exactly what gets passed to the backend. `keepers` maps group
/// index → keeper index; a group missing from the map keeps `files[0]`, which
/// is what the dialog shows before anything is picked.
export function redundantFiles(groups, keepers, checked) {
  const out = [];
  groups.forEach((g, gi) => {
    const files = g.files || [];
    if (files.length < 2) return;
    const keep = keepers && keepers.has(gi) ? keepers.get(gi) : 0;
    files.forEach((f, fi) => {
      if (fi === keep) return;
      // Per-file opt-out: a user may want to keep one extra copy on purpose.
      if (checked && checked.get(f.path) === false) return;
      out.push(f);
    });
  });
  return out;
}

/// The single file each group keeps, in group order.
export function keptFiles(groups, keepers) {
  const out = [];
  groups.forEach((g, gi) => {
    const files = g.files || [];
    if (!files.length) return;
    const keep = keepers && keepers.has(gi) ? keepers.get(gi) : 0;
    out.push(files[keep]);
  });
  return out;
}

/// Space that deleting `redundant` would free — one copy's length per removed
/// file, since every member of a group is the same size.
export function reclaimableBytes(redundant) {
  return redundant.reduce((sum, f) => sum + (f.size || 0), 0);
}

/// Roll the per-group counts for the status line.
export function summarize(groups, keepers, checked) {
  const redundant = redundantFiles(groups, keepers, checked);
  return {
    groups: (groups || []).filter((g) => (g.files || []).length >= 2).length,
    redundantCount: redundant.length,
    redundantBytes: reclaimableBytes(redundant),
  };
}

/// Move the keeper of one group to `fileIndex`, carrying the check state along.
///
/// The file that stops being the keeper becomes deletable again, and the new
/// keeper is never offered for deletion — a keeper with `checked === false`
/// would make the dialog claim it deletes N files while the user sees N-1.
export function switchKeeper(groups, keepers, checked, groupIndex, fileIndex) {
  const files = (groups[groupIndex] || {}).files || [];
  if (fileIndex < 0 || fileIndex >= files.length) return keepers;
  const next = new Map(keepers);
  next.set(groupIndex, fileIndex);
  return next;
}

/// The checkbox state a group should show for the file at `fileIndex`.
///
/// Derived rather than stored: the keeper is always unchecked, everything else
/// defaults to checked (that is the whole point of the dialog), and an explicit
/// user opt-out in `checked` still wins.
export function fileChecked(files, keepers, checked, groupIndex, fileIndex) {
  const keep = keepers && keepers.has(groupIndex) ? keepers.get(groupIndex) : 0;
  if (fileIndex === keep) return false;
  const f = (files || [])[fileIndex];
  if (!f) return false;
  return !(checked && checked.get(f.path) === false);
}

/// Toggle one file's delete checkbox. Clicking the keeper is a no-op: it is not
/// offered for deletion, so there is nothing to toggle — and recording a state
/// for it would be a lie the UI cannot show.
export function toggleChecked(groups, keepers, checked, groupIndex, fileIndex) {
  const files = (groups[groupIndex] || {}).files || [];
  const f = files[fileIndex];
  if (!f) return checked;
  const keep = keepers && keepers.has(groupIndex) ? keepers.get(groupIndex) : 0;
  if (fileIndex === keep) return checked;
  const next = new Map(checked);
  next.set(f.path, !fileChecked(files, keepers, checked, groupIndex, fileIndex));
  return next;
}

/// Re-check every non-keeper of one group ("本组全选").
///
/// The other groups' opt-outs are carried over: this action is scoped to one
/// group, and returning a fresh map would silently resurrect files the user
/// deliberately unchecked elsewhere in the same dialog.
export function checkAllInGroup(groups, groupIndex, keepers, checked) {
  const files = (groups[groupIndex] || {}).files || [];
  const keep = keepers && keepers.has(groupIndex) ? keepers.get(groupIndex) : 0;
  const next = new Map(checked);
  files.forEach((f, fi) => {
    if (fi === keep) next.delete(f.path);
    else next.set(f.path, true);
  });
  return next;
}

/// The confirmation payload: exactly the files that will be handed to the
/// backend. Carries the size/mtime observed at scan time — the backend re-checks
/// both before trashing, so a file edited since the scan is skipped rather than
/// deleted on stale evidence.
export function buildDeletePayload(redundant) {
  return redundant.map((f) => ({
    path: f.path,
    size: f.size,
    modified: f.modified,
  }));
}

// ── Delete progress ──

/// Fill fraction of the delete bar, 0..100.
///
/// The numerator is files actually DELETED, not files processed: a skipped
/// (changed) or failed file never reaches the bin, and a bar counting it would
/// promise deletions that did not happen. A run with failures therefore ends
/// below 100% rather than claiming a complete delete.
///
/// (This one earns its place in this module — it is a judgement about what the
/// number MEANS, and the component calls it rather than restating it.)
export function deletePercent(deleted, total) {
  // `Number.isFinite` first, NOT `Math.max(0, Math.min(100, …))`: clamping
  // cannot absorb NaN (`Math.min(100, NaN)` is NaN), so a non-numeric field
  // would render as `width: NaN%` — the bar silently vanishing with no error.
  // The payload comes off IPC, where a missing/renamed field is `undefined`.
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(deleted)) return 0;
  return Math.max(0, Math.min(100, Math.round((deleted / total) * 100)));
}