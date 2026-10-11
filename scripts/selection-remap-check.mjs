// Standalone check for the selection-remap algorithm in FileList.vue.
//
// Why this exists: the remap used to hang off `showHidden` alone, so sorting
// by another column or typing in the `/` filter left `selectedIndices`
// pointing at whatever row landed on that index — Delete then removed a
// *different* file. The remap itself is pure index bookkeeping over entry
// identities, so it can be exercised without mounting the component.
//
// The function under test is COPIED from FileList.vue rather than imported:
// the component is a .vue SFC whose <script setup> cannot be loaded by plain
// node. `remapIdentities` below must stay byte-identical in behaviour to the
// watcher — if the component changes, change this too.

/**
 * Re-map index-based selection state across a reordering / filtering of the
 * displayed list, matching rows by entry identity.
 *
 * @param {Array} prev     the displayed list BEFORE the change
 * @param {Array} next     the displayed list AFTER the change
 * @param {Set<number>} selectedIndices
 * @param {number} activeIndex
 * @param {number} anchorIndex
 * @param {number} renamingIndex
 */
export function remapIdentities(
  prev,
  next,
  selectedIndices,
  activeIndex,
  anchorIndex,
  renamingIndex
) {
  const keepSel = new Set();
  for (const i of selectedIndices) {
    const e = prev[i];
    if (e) keepSel.add(e);
  }
  const keepActive = activeIndex >= 0 ? prev[activeIndex] : null;
  const keepAnchor = anchorIndex >= 0 ? prev[anchorIndex] : null;
  const keepRenaming = renamingIndex >= 0 ? prev[renamingIndex] : null;

  const nextSel = new Set();
  let nextActive = -1;
  let nextAnchor = -1;
  let nextRenaming = -1;
  next.forEach((e, i) => {
    if (keepSel.has(e)) nextSel.add(i);
    if (e === keepActive) nextActive = i;
    if (e === keepAnchor) nextAnchor = i;
    if (e === keepRenaming) nextRenaming = i;
  });

  return {
    selectedIndices: nextSel,
    activeIndex: nextActive,
    anchorIndex: nextAnchor,
    renamingIndex: nextRenaming,
  };
}

/** The cheap "did anything actually move" guard, mirrored from the watcher. */
export function sameOrder(prev, next) {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

// ── harness ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Entry objects are identified by reference, exactly like the real list.
const A = { name: "alpha.txt" };
const B = { name: "beta.txt" };
const C = { name: "gamma.txt" };
const D = { name: "delta.txt" };

// ── 1. re-sorting keeps the selection on the same FILE ──────────────────────
// This is the bug: select index 0, re-sort so a different file lands at index 0,
// and Delete used to remove that other file.
{
  const prev = [A, B, C, D];
  const next = [C, A, D, B]; // e.g. after clicking "Size"
  const r = remapIdentities(prev, next, new Set([0]), 0, 0, -1);
  // A was at index 0 and is now at index 1 in [C, A, D, B].
  check("re-sort keeps selection on the same entry", r.selectedIndices.has(1), `got ${[...r.selectedIndices]}`);
  check("re-sort moves active to the same entry", next[r.activeIndex] === A, `active -> ${r.activeIndex}`);
  check("re-sort moves anchor likewise", next[r.anchorIndex] === A, `anchor -> ${r.anchorIndex}`);
}

// ── 2. reverse sort (direction toggle) ─────────────────────────────────────
{
  const prev = [A, B, C, D];
  const next = [D, C, B, A];
  const r = remapIdentities(prev, next, new Set([1, 3]), 3, 3, -1);
  check("descending sort keeps both selections", next[r.activeIndex] === D, `active -> ${r.activeIndex}`);
  const selEntries = [...r.selectedIndices].map((i) => next[i]);
  check(
    "descending sort keeps the same two files selected",
    selEntries.includes(B) && selEntries.includes(D),
    `selected ${JSON.stringify(selEntries.map((e) => e.name))}`
  );
}

// ── 3. filtering rows out (the `/` filter) ─────────────────────────────────
{
  const prev = [A, B, C, D];
  // The filter hides A and C; B and D remain.
  const next = [B, D];
  // Selecting A (index 0), which the filter removes, must clear — NOT land on
  // whatever now sits at index 0 (that is B, a different file).
  const dropped = remapIdentities(prev, next, new Set([0]), 0, 0, -1);
  check("filtered-out selection is dropped", dropped.selectedIndices.size === 0, `got ${[...dropped.selectedIndices]}`);
  check("filtered-out active becomes -1", dropped.activeIndex === -1, `got ${dropped.activeIndex}`);

  // A surviving selection must follow its file to its new index.
  const kept = remapIdentities(prev, next, new Set([1]), 1, 1, -1);
  check("surviving selection follows to the new index", next[kept.activeIndex] === B, `active -> ${kept.activeIndex}`);
}

// ── 4. rows appearing (Ctrl+H shows hidden files) ──────────────────────────
{
  const prev = [A, C];
  const hidden = { name: ".git", hidden: true };
  const next = [hidden, A, C]; // hidden entries sort first by name class
  const r = remapIdentities(prev, next, new Set([1]), 1, 1, -1);
  check("existing selection survives new rows", next[r.activeIndex] === C, `active -> ${r.activeIndex}`);
  check("index actually shifted", r.activeIndex === 2, `active -> ${r.activeIndex}`);
}

// ── 5. renaming row follows the entry (F2 must not jump rows) ──────────────
{
  const prev = [A, B, C];
  const next = [C, A, B];
  const r = remapIdentities(prev, next, new Set(), -1, -1, 0);
  check("rename target follows its entry", next[r.renamingIndex] === A, `renaming -> ${r.renamingIndex}`);
}

// ── 6. a row disappearing must drop the rename, not leave it dangling ──────
{
  const prev = [A, B, C];
  const next = [A, C]; // B (being renamed) is gone
  const r = remapIdentities(prev, next, new Set(), -1, -1, 1);
  check("vanished rename row resets", r.renamingIndex === -1, `renaming -> ${r.renamingIndex}`);
}

// ── 7. entries replaced wholesale (directory re-listed) ───────────────────
// Identity no longer matches: everything resets rather than pointing at a
// random row of the new listing.
{
  const prev = [A, B, C];
  const X = { name: "x" };
  const Y = { name: "y" };
  const next = [X, Y];
  const r = remapIdentities(prev, next, new Set([0, 2]), 2, 2, 2);
  check("stale identities drop selection", r.selectedIndices.size === 0);
  check("stale identities reset active", r.activeIndex === -1);
  check("stale identities reset rename", r.renamingIndex === -1);
}

// ── 8. the no-op guard ─────────────────────────────────────────────────────
{
  check("identical array reference is a no-op", sameOrder([A, B], [A, B]));
  check("equal-content new array is a no-op", sameOrder([A, B, C], [A, B, C]));
  check("reorder is detected", !sameOrder([A, B, C], [C, A, B]));
  check("length change is detected", !sameOrder([A, B], [A, B, C]));
  check("duplicate-looking rows still compare by identity", !sameOrder([A, B], [B, A]));
}

// ── 9. no selection at all stays empty ─────────────────────────────────────
{
  const r = remapIdentities([A, B], [B, A], new Set(), -1, -1, -1);
  check("empty selection stays empty", r.selectedIndices.size === 0);
  check("empty active stays -1", r.activeIndex === -1);
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);