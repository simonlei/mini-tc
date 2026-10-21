// Behaviour + static checks for the duplicate-file dialog's decision logic.
//
// The judgement being protected here decides WHICH FILE SURVIVES. A reversed
// comparison, a `<=` for `<`, or an off-by-one in the keeper index compiles
// fine, passes `vite build` and `cargo check`, and the only symptom is that the
// user's newest copy is the one that gets deleted.
//
// Structure follows the project's existing suites: behaviour assertions against
// the PRODUCTION module (never a copy pasted in here — a copy is a second thing
// to fix and would keep passing after the real code broke), then static
// assertions for the things only a text read can check (the Rust side refusing
// a stale file, the dialog actually gating the global keyboard).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultKeepers,
  isNewer,
  redundantFiles,
  keptFiles,
  reclaimableBytes,
  summarize,
  switchKeeper,
  fileChecked,
  toggleChecked,
  checkAllInGroup,
  buildDeletePayload,
  makeFile,
  deletePercent,
} from "../src/dedupRules.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    pass++;
  } else {
    failures.push(label);
    console.error("  FAIL " + label);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    failures.push(`${label}  (got ${a}, want ${e})`);
    console.error(`  FAIL ${label}\n       got  ${a}\n       want ${e}`);
  }
}

/// Compare two Maps by CONTENT.
///
/// 🚨 Do NOT compare Maps with `eq`/`JSON.stringify`: a Map serialises to `{}`
/// regardless of its entries, so `eq(new Map([["a",1]]), new Map())` passes.
/// That made every "the keeper map is unchanged / unchanged index" assertion a
/// silent恒真 — and it is exactly the class of assertion that hides the bug it
/// was written for.
function eqMap(actual, expected, label) {
  const norm = (m) =>
    m instanceof Map ? [...m.entries()].sort((x, y) => String(x[0]).localeCompare(String(y[0]))) : m;
  const a = JSON.stringify(norm(actual));
  const e = JSON.stringify(norm(expected));
  if (a === e) {
    pass++;
  } else {
    failures.push(`${label}  (got ${a}, want ${e})`);
    console.error(`  FAIL ${label}\n       got  ${a}\n       want ${e}`);
  }
}

// ── Fixtures ──
// `t1` is newest, `t2` middle, `t3` oldest — deliberately NOT in that order in
// the array, so a keeper choice that happens to match index 0 is not passing
// for the wrong reason.
const g1 = {
  size: 100,
  files: [
    makeFile("C:\\d\\a.txt", 100, 300, "C:\\d", "a.txt"),
    makeFile("C:\\d\\b.txt", 100, 100, "C:\\d", "b.txt"),
    makeFile("C:\\d\\c.txt", 100, 200, "C:\\d", "c.txt"),
  ],
};
const g2 = {
  size: 50,
  files: [
    makeFile("C:\\d\\x.bin", 50, 10, "C:\\d", "x.bin"),
    makeFile("C:\\d\\y.bin", 50, 20, "C:\\d", "y.bin"),
  ],
};
const groups = [g1, g2];

// ── defaultKeepers: newest copy survives ──
console.log("defaultKeepers");
{
  const k = defaultKeepers(groups);
  eq(k.get(0), 0, "group 0 keeps the newest file (index 0)");
  eq(k.get(1), 1, "group 1 keeps the newer of its two");

  // The fixture must actually be unsorted, or the assertion above proves
  // nothing. (METHODOLOGY: prove the branch is reachable.)
  eq(
    g1.files.map((f) => f.modified),
    [300, 100, 200],
    "fixture is NOT pre-sorted (so keeper choice is not accidentally index 0)"
  );
}

console.log("defaultKeepers on a group whose newest is NOT first");
{
  const unsorted = {
    size: 10,
    files: [
      makeFile("C:\\d\\old", 10, 5),
      makeFile("C:\\d\\new", 10, 900),
    ],
  };
  const k = defaultKeepers([unsorted]);
  eq(k.get(0), 1, "picks index 1 when the newest file sits there");
  eq(
    keptFiles([unsorted], k).map((f) => f.path),
    ["C:\\d\\new"],
    "and that file is the one reported as kept"
  );
}

console.log("defaultKeepers tie-break");
{
  const tie = {
    size: 10,
    files: [
      makeFile("C:\\d\\zzz", 10, 500),
      makeFile("C:\\d\\aaa", 10, 500),
    ],
  };
  const k = defaultKeepers([tie]);
  // `aaa` < `zzz`, so `isNewer(zzz, aaa)` is false and the smaller path is
  // preferred — which sits at index 1 here. The property that matters is that
  // the answer is DEFINED and order-independent, not that it lands on 0.
  eq(k.get(0), 1, "equal mtime → the smaller path wins (index 1 here)");
  ok(isNewer({ path: "a", modified: 1 }, { path: "b", modified: 1 }) === true, "isNewer: equal mtime, a<b → true");
  ok(isNewer({ path: "b", modified: 1 }, { path: "a", modified: 1 }) === false, "isNewer: equal mtime, b>a → false");
  ok(isNewer({ path: "b", modified: 2 }, { path: "a", modified: 1 }) === true, "isNewer: newer mtime wins regardless of path");
  // Same two files, reversed order → the same FILE survives.
  const tieRev = { size: 10, files: [tie.files[1], tie.files[0]] };
  eq(
    keptFiles([tieRev], defaultKeepers([tieRev]))[0].path,
    keptFiles([tie], defaultKeepers([tie]))[0].path,
    "the tie-break does not depend on the order the group happens to be listed in"
  );
}

// ── redundantFiles: what would actually be deleted ──
console.log("redundantFiles");
{
  const k = defaultKeepers(groups);
  eq(
    redundantFiles(groups, k, new Map()).map((f) => f.path),
    ["C:\\d\\b.txt", "C:\\d\\c.txt", "C:\\d\\x.bin"],
    "every non-keeper, across both groups"
  );
  eq(
    redundantFiles(groups, k, new Map()).length,
    3,
    "3 redundant files total (3+2 members, 2 keepers)"
  );
}

console.log("redundantFiles never returns the keeper");
{
  const k = defaultKeepers(groups);
  const red = redundantFiles(groups, k, new Map());
  for (const [gi, g] of groups.entries()) {
    const keeperPath = g.files[k.get(gi)].path;
    ok(
      !red.some((f) => f.path === keeperPath),
      `group ${gi}: keeper ${keeperPath} is not in the delete list`
    );
  }
}

console.log("redundantFiles with NO keepers map (dialog before any pick)");
{
  // Falls back to files[0]. For g1 that is `a.txt`; for g2 the fixture order is
  // x.bin (mtime 10) then y.bin (mtime 20), so files[0] is x.bin and y.bin is
  // the redundant one — the fallback is "whatever is listed first", NOT "the
  // newest". That distinction is the point of the assertion.
  eq(
    redundantFiles(groups, undefined, undefined).map((f) => f.path),
    ["C:\\d\\b.txt", "C:\\d\\c.txt", "C:\\d\\y.bin"],
    "falls back to files[0] as keeper — matches what is rendered"
  );
}

console.log("redundantFiles ignores a one-member group");
{
  const solo = { size: 7, files: [makeFile("C:\\d\\only", 7, 1)] };
  eq(redundantFiles([solo], new Map(), new Map()), [], "a group of one yields nothing");
  eq(summarize([solo], new Map(), new Map()).groups, 0, "and is not counted as a group");

  // The assertion above would ALSO pass if the `files.length < 2` guard were
  // removed and the keeper check alone did the work — a real blind spot (the
  // mutation suite caught it). The keeper check compares INDICES, so a keeper
  // index that is not in the array defeats it entirely: only the length guard
  // can save us then. That is the case the guard has to hold.
  eq(redundantFiles([{ size: 7, files: [] }], new Map(), new Map()), [], "an empty group yields nothing");
  eq(
    redundantFiles([solo], new Map([[0, 0]]), new Map()),
    [],
    "one-member group, keeper index in range → nothing (keeper check would also catch it)"
  );
  eq(
    redundantFiles([solo], new Map([[0, 5]]), new Map()),
    [],
    "one-member group whose keeper index is OUT OF RANGE → still nothing (only the length guard holds)"
  );
  // Contrast: a two-member group with the same out-of-range keeper DOES get
  // emptied, which proves the length guard (not some blanket early return) is
  // what suppressed the case above.
  const two = {
    size: 7,
    files: [makeFile("C:\\d\\k", 7, 9), makeFile("C:\\d\\r", 7, 1)],
  };
  eq(
    redundantFiles([two], new Map([[0, 5]]), new Map()).map((f) => f.path),
    ["C:\\d\\k", "C:\\d\\r"],
    "two members with an out-of-range keeper → both are treated as redundant"
  );
  eq(
    redundantFiles([two], new Map([[0, 0]]), new Map()).map((f) => f.path),
    ["C:\\d\\r"],
    "two members with a pinned keeper → the non-keeper IS returned"
  );
}

console.log("redundantFiles honours a per-file opt-out");
{
  const k = defaultKeepers(groups);
  const optOut = new Map([["C:\\d\\b.txt", false]]);
  eq(
    redundantFiles(groups, k, optOut).map((f) => f.path),
    ["C:\\d\\c.txt", "C:\\d\\x.bin"],
    "an unchecked file drops out of the delete list"
  );
  // The other direction must be distinguishable, or the assertion above would
  // also pass if `checked` were ignored entirely.
  const optIn = new Map([["C:\\d\\b.txt", true]]);
  eq(
    redundantFiles(groups, k, optIn).length,
    3,
    "an explicitly checked file is still in the list"
  );
}

// ── switchKeeper ──
console.log("switchKeeper");
{
  const k = defaultKeepers(groups);
  const swapped = switchKeeper(groups, k, new Map(), 0, 2);
  eq(swapped.get(0), 2, "keeper moves to the chosen index");
  eq(k.get(0), 0, "the input map is NOT mutated");
  eq(
    redundantFiles(groups, swapped, new Map()).map((f) => f.path),
    ["C:\\d\\a.txt", "C:\\d\\b.txt", "C:\\d\\x.bin"],
    "the old keeper becomes deletable, the new one is spared"
  );
  eq(
    keptFiles(groups, swapped).map((f) => f.path),
    ["C:\\d\\c.txt", "C:\\d\\y.bin"],
    "keptFiles follows the swap"
  );
}

console.log("switchKeeper rejects an out-of-range index");
{
  const k = defaultKeepers(groups);
  // Compared as a MAP: with a one-member group, an accepted index 0 is
  // indistinguishable from an unchanged map by value alone (both hold 0), so
  // the group must have 2+ members for this assertion to have teeth.
  eqMap(switchKeeper(groups, k, new Map(), 0, 99), k, "index 99 → map unchanged");
  eqMap(switchKeeper(groups, k, new Map(), 0, -1), k, "index -1 → map unchanged");
  eqMap(switchKeeper(groups, k, new Map(), 42, 0), k, "unknown group → map unchanged");
  // And the counterpart: a VALID index must actually change it (without this,
  // "always return keepers" would pass every line above).
  ok(
    switchKeeper(groups, k, new Map(), 0, 2).get(0) === 2,
    "a valid index DOES change the map"
  );
}

// ── fileChecked / toggleChecked ──
console.log("fileChecked");
{
  const k = defaultKeepers(groups);
  ok(fileChecked(g1.files, k, new Map(), 0, 0) === false, "the keeper is never checked");
  ok(fileChecked(g1.files, k, new Map(), 0, 1) === true, "a non-keeper defaults to checked");
  ok(
    fileChecked(g1.files, k, new Map([["C:\\d\\b.txt", false]]), 0, 1) === false,
    "an explicit opt-out is honoured"
  );
  ok(fileChecked(g1.files, k, new Map(), 0, 99) === false, "out-of-range index → unchecked, not a crash");
  ok(fileChecked(undefined, k, new Map(), 0, 0) === false, "missing files array → unchecked");
}

console.log("toggleChecked");
{
  const k = defaultKeepers(groups);
  let c = new Map();
  c = toggleChecked(groups, k, c, 0, 1);
  ok(c.get("C:\\d\\b.txt") === false, "toggling a checked non-keeper unchecks it");
  c = toggleChecked(groups, k, c, 0, 1);
  ok(c.get("C:\\d\\b.txt") === true, "toggling it back re-checks it");

  // Clicking the keeper must be a no-op: it is not offered for deletion, so a
  // "checked keeper" would make the footer claim N deletions the user cannot
  // see.
  const before = new Map();
  const after = toggleChecked(groups, k, before, 0, 0);
  ok(!after.has("C:\\d\\a.txt"), "toggling the keeper records nothing");
  eq(
    redundantFiles(groups, k, after).length,
    3,
    "and the delete list is unchanged"
  );
}

console.log("checkAllInGroup");
{
  const k = defaultKeepers(groups);
  const c = checkAllInGroup(groups, 0, k, new Map());
  ok(c.get("C:\\d\\b.txt") === true, "b.txt checked");
  ok(c.get("C:\\d\\c.txt") === true, "c.txt checked");
  eq(
    redundantFiles(groups, k, c).map((f) => f.path),
    ["C:\\d\\b.txt", "C:\\d\\c.txt", "C:\\d\\x.bin"],
    "本组全选 restores both of g1's non-keepers (its keeper still spared); g2 untouched"
  );
}

console.log("checkAllInGroup does not resurrect another group's opt-out");
{
  const k = defaultKeepers(groups);
  // g1's default keeper is `a.txt`; opting `b.txt` out of g1 means only `c.txt`
  // is left to delete there.
  const before = new Map([["C:\\d\\b.txt", false]]);
  const after = checkAllInGroup(groups, 0, k, before);
  ok(after.get("C:\\d\\b.txt") === true, "g1's own opt-out IS cleared by 本组全选");
  // A DIFFERENT group's opt-out must be carried over untouched.
  const otherGroup = new Map([["C:\\d\\x.bin", false]]);
  const after2 = checkAllInGroup(groups, 0, k, otherGroup);
  ok(after2.get("C:\\d\\x.bin") === false, "g2's opt-out survives a 本组全选 on g1");
  eq(
    redundantFiles(groups, k, after2).map((f) => f.path),
    ["C:\\d\\b.txt", "C:\\d\\c.txt"],
    "g2 contributes nothing: its keeper is y.bin and x.bin was opted out"
  );
}

// ── summarize / reclaimableBytes ──
console.log("summarize");
{
  const k = defaultKeepers(groups);
  const s = summarize(groups, k, new Map());
  eq(s.groups, 2, "2 groups");
  eq(s.redundantCount, 3, "3 redundant files");
  eq(s.redundantBytes, 250, "100+100+50 bytes");
  ok(
    summarize(groups, k, new Map([["C:\\d\\b.txt", false]])).redundantBytes === 150,
    "opting out reduces the reclaimable total"
  );
  eq(summarize([], new Map(), new Map()), { groups: 0, redundantCount: 0, redundantBytes: 0 }, "empty input → zeroed summary");
}

console.log("reclaimableBytes");
{
  eq(reclaimableBytes([]), 0, "no files → 0");
  eq(
    reclaimableBytes([{ size: 5 }, { size: 7 }, { size: 0 }]),
    12,
    "sums sizes, treating a missing size as 0"
  );
}

// ── buildDeletePayload: the stale-check evidence ──
console.log("buildDeletePayload");
{
  const k = defaultKeepers(groups);
  const payload = buildDeletePayload(redundantFiles(groups, k, new Map()));
  eq(payload.length, 3, "one entry per redundant file");
  eq(
    payload[0],
    { path: "C:\\d\\b.txt", size: 100, modified: 100 },
    "carries path + the size/mtime observed AT SCAN TIME"
  );
  // The backend skips anything whose size/mtime no longer matches. Without
  // these two fields it would have nothing to compare against and would delete
  // on trust.
  ok(
    payload.every((p) => typeof p.size === "number" && typeof p.modified === "number"),
    "every entry carries numeric size AND modified (the stale check needs both)"
  );
  eq(buildDeletePayload([]), [], "empty input → empty payload");
}

// ── Cross-boundary static assertions ──
// Pure-logic tests stay green if only the CALL SITE is wrong, so pin the parts
// that live in other files.

console.log("static: backend refuses to delete a file that changed since the scan");
{
  const lib = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
  const start = lib.indexOf("fn trash_dedup_items");
  ok(start > 0, "trash_dedup_items exists");
  // Whitespace-normalised: `cargo fmt` rewraps the bodies freely, and an
  // assertion anchored on the pre-fmt line breaks fails on correct code.
  const body = lib.slice(start, lib.indexOf("fn log_dedup_delete", start)).replace(/\s+/g, " ");

  ok(
    body.includes("fs::symlink_metadata(p)"),
    "uses symlink_metadata, not metadata (a path that became a symlink must not be checked as its target)"
  );
  ok(
    !/\bfull_path|fs::metadata\(p\)/.test(body),
    "does NOT use fs::metadata anywhere in the delete path"
  );
  ok(
    body.includes("meta.len() != item.size"),
    "re-checks size against the scan-time value"
  );
  ok(
    body.includes("system_time_to_millis(meta.modified()) != item.modified"),
    "re-checks mtime against the scan-time value"
  );
  ok(
    body.includes("meta.file_type().is_symlink()"),
    "refuses a path that has become a symlink since the scan"
  );
  ok(
    body.includes("!meta.is_file()"),
    "refuses a path that is no longer a plain file (e.g. swapped for a directory)"
  );
  // The failure mode of a TOCTOU check that only warns instead of skipping:
  // `changed.push(...)` then falling through to `trash::delete` anyway. Count
  // the arms and require every one of them to `continue` — "there is at least
  // one continue somewhere" would be true even if one arm fell through.
  const arms = (body.match(/changed\.push\(/g) || []).length;
  eq(arms, 2, "exactly two skip arms record into `changed`");
  const continues = (body.match(/\bcontinue;/g) || []).length;
  eq(continues, arms, "every `changed` arm is followed by a `continue` (none falls through to trash)");
  // And the composite condition must cover all four refusals.
  const guard = body.slice(body.indexOf("if meta.file_type().is_symlink()"));
  for (const cond of [
    "meta.file_type().is_symlink()",
    "!meta.is_file()",
    "meta.len() != item.size",
    "system_time_to_millis(meta.modified()) != item.modified",
  ]) {
    ok(guard.includes(cond), `the skip condition includes \`${cond}\``);
  }
  ok(
    !body.includes("delete_permanently") && !body.includes("remove_link_or_tree"),
    "never falls back to a permanent delete"
  );
}

console.log("static: the whole batch shares ONE undo step");
{
  const lib = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
  // ⚠️ Anchor on TOKENS, never on the formatted signature. `cargo fmt` collapses
  // `fn dedup_delete(\n    app: …,\n    items: …,\n) -> …` back onto one line, so a
  // multi-line anchor silently stopped matching — and because `fmt` runs
  // between test runs, the suite passed standalone and then failed 8 assertions
  // when run in sequence. Normalise whitespace before matching, and assert the
  // pieces are present rather than the exact line breaks.
  const start = lib.indexOf("fn dedup_delete(app: tauri::AppHandle, items: Vec<DedupDeleteItem>)");
  ok(start > 0, "the undoable dedup_delete variant exists (AppHandle + items signature)");
  const body = lib
    .slice(start, lib.indexOf("fn log_dedup_delete", start))
    .replace(/\s+/g, " ");
  eq(
    (body.match(/trash_snapshot_ids\(\)/g) || []).length,
    1,
    "exactly ONE bin snapshot for the batch (a per-file snapshot would leave only the last file undoable)"
  );
  eq(
    (body.match(/push_trash_undo_batch\(/g) || []).length,
    1,
    "exactly ONE undo commit for the batch"
  );
  // Compare by INDEX, not by `indexOf(a) < indexOf(b)`: the latter compares
  // -1 (not found) against a real position and can read true for the wrong
  // reason. Require each call to be PRESENT first, then check the order.
  // (`body` is whitespace-normalised — `cargo fmt` freely wraps these calls.)
  const snapAt = body.indexOf("trash_snapshot_ids()");
  const runAt = body.indexOf("trash_dedup_items(&items");
  const pushAt = body.indexOf("push_trash_undo_batch(");
  ok(snapAt > 0, "the batch takes its bin snapshot");
  ok(runAt > 0, "the batch runs the delete");
  ok(pushAt > 0, "the batch commits its undo step");
  ok(snapAt < runAt, "the snapshot is taken BEFORE anything is trashed");
  ok(pushAt > runAt, "the undo commit happens AFTER the deletes");
  // One bracket per file would silently destroy every earlier batch.
  ok(
    !/for .* in .*items/.test(body),
    "no loop inside dedup_delete — the whole batch is bracketed once"
  );
}

console.log("static: the dedup cancel slot is independent of the search one");
{
  const lib = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
  const dedupSlot = lib.indexOf("static DEDUP_CANCEL");
  const searchSlot = lib.indexOf("static SEARCH_CANCEL");
  ok(dedupSlot > 0, "DEDUP_CANCEL exists");
  ok(searchSlot > 0, "SEARCH_CANCEL exists");
  const decl = lib.slice(dedupSlot, lib.indexOf(";", dedupSlot));
  ok(
    decl.includes("HashMap<u64") || decl.includes("Mutex<HashMap<u64"),
    "keyed by scan id, not a single shared slot"
  );
  // `start_search` cancels-and-replaces whatever is in its slot, so sharing the
  // slot would let a search kill an unrelated dedup scan.
  const startSearch = lib.slice(lib.indexOf("fn start_search"), lib.indexOf("fn cancel_search"));
  ok(
    !startSearch.includes("DEDUP_CANCEL"),
    "start_search never touches DEDUP_CANCEL"
  );
  const startDedup = lib.slice(lib.indexOf("fn start_dedup"), lib.indexOf("fn cancel_dedup"));
  ok(!startDedup.includes("SEARCH_CANCEL"), "start_dedup never touches SEARCH_CANCEL");

  // The id-keyed map is only worth anything if starting a scan does NOT cancel
  // every other id. `guard.clear()` would keep the HashMap type and still pass
  // the assertions above while killing both panels' scans — so pin the
  // behaviour, not the type.
  //
  // Slice on the two STABLE anchors (`let mut guard = DEDUP_CANCEL` and the
  // `std::thread::spawn` that follows the slot block) rather than on a guessed
  // indentation run: a slice that silently comes up empty makes every
  // assertion inside it vacuously false-passing in one direction.
  const startBody = lib.slice(
    lib.indexOf("let mut guard = DEDUP_CANCEL"),
    lib.indexOf("std::thread::spawn", lib.indexOf("let mut guard = DEDUP_CANCEL"))
  );
  ok(startBody.length > 0, "the DEDUP_CANCEL slot block was located");
  ok(startBody.includes("guard.insert(id, flag.clone())"), "the new flag is inserted under its own id");
  ok(!startBody.includes("guard.clear()"), "starting a scan never clears the whole map (that would cancel other ids)");
  // Only the PREVIOUS flag of the SAME id may be cancelled.
  ok(
    /if let Some\(prev\) = guard\.insert\(id, flag\.clone\(\)\) \{\s*prev\.store\(true/.test(startBody),
    "only the flag being replaced (same id) is cancelled"
  );
  // The thread teardown must also be id-scoped, or finishing one scan would
  // remove another scan's flag.
  const teardown = lib.slice(lib.indexOf("fn start_dedup"), lib.indexOf("fn cancel_dedup"));
  ok(
    /guard\.get\(&id\)/.test(teardown) && /guard\.remove\(&id\)/.test(teardown),
    "teardown looks up and removes by id, not the whole map"
  );
  ok(
    /std::sync::Arc::ptr_eq\(cur, &log_flag\)/.test(teardown),
    "teardown only removes its OWN flag (a newer scan under the same id survives)"
  );
}

console.log("static: the dialog gates the global keyboard");
{
  const app = fs.readFileSync(path.join(ROOT, "src", "App.vue"), "utf8");
  ok(
    app.includes("if (dedupVisible.value) return;"),
    "onGlobalKeydown returns early while the dialog is open (Delete/Backspace must not reach the panels)"
  );
  // The gate has to sit BEFORE the key bindings that would fire.
  const keydown = app.indexOf("function onGlobalKeydown");
  const gate = app.indexOf("if (dedupVisible.value) return;", keydown);
  const firstBind = app.indexOf('matches("preview.close"', keydown);
  ok(gate > 0 && firstBind > 0 && gate < firstBind, "the gate precedes the first shortcut binding");
}

console.log("static: the dialog unwraps the event payload");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  // `listen` yields `{event, id, payload}` where `id` is a GLOBAL event sequence
  // number. Comparing that to the scan id never matches → every event dropped →
  // the dialog spins forever.
  ok(dlg.includes("event?.payload"), "reads `.payload` off the event wrapper");
  ok(
    !/\bevent\.id\s*===/.test(dlg) && !/=== event\.id/.test(dlg),
    "never compares the wrapper's global Event.id to the scan id"
  );

  // 🚨 "The token appears somewhere" is not enough: BOTH handlers must reject a
  // stale scan, and an earlier draft asserted only that the guard existed once
  // — so deleting it from either `onProgress` or `onDone` kept the suite green
  // while a superseded scan could overwrite the current one's results. Locate
  // each handler and check the guard INSIDE it.
  for (const [fn, next] of [
    ["function onProgress(event)", "function onDone(event)"],
    ["function onDone(event)", "function stopTicker()"],
  ]) {
    const start = dlg.indexOf(fn);
    ok(start > 0, `${fn} exists`);
    const body = dlg.slice(start, dlg.indexOf(next, start));
    ok(
      /if \(!payload \|\| payload\.id !== dedupId\) return;/.test(body),
      `${fn} drops events whose payload id is not the current scan`
    );
  }
  // And the exact count, so a third unguarded listener cannot slip in.
  eq(
    (dlg.match(/payload\.id !== dedupId/g) || []).length,
    2,
    "exactly two handlers carry the stale-scan guard (onProgress + onDone)"
  );
}

console.log("static: nothing is deleted without going through the dialog");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  ok(dlg.includes("dedupDelete(buildDeletePayload(doomed))"), "delete uses the confirmed payload");
  // `includeEmpty: false` — the product rule that empty files are not copies.
  ok(
    /includeEmpty:\s*false/.test(dlg),
    "the scan excludes 0-byte files by default"
  );
  ok(
    !dlg.includes("deletePermanently") && !dlg.includes("deleteToTrash"),
    "never calls a permanent/trash delete directly — only the backend's batched, re-checking one"
  );
  ok(dlg.includes('if (choice !== "ok") return;'), "cancelling the confirm aborts the delete");
}

console.log("static: the changed/failed report is really wired up");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  // 🚨 `includes("res.changed?.length")` alone is a "does the token exist"
  // assertion: wrapping the condition in `false && …` keeps the token and still
  // silences the report, which is precisely the bug. Assert the BRANCH BODY —
  // a live `if` whose consequent actually pushes text into `parts`.
  const changedBranch = /if \(res\.changed\?\.length\) \{\s*parts\.push\(/.test(dlg);
  ok(changedBranch, "a changed file is pushed into the reported summary");
  const failedBranch = /if \(res\.failed\?\.length\) \{/.test(dlg);
  ok(failedBranch, "a failed file has its own branch");
  ok(
    /res\.failed\.slice\(0, 2\)\.join/.test(dlg),
    "the failure branch includes the backend's message, not just a count"
  );
  // And the summary has to reach the user rather than being computed and lost.
  // The failure case writes to BOTH `notice` and `error`; a clean run writes to
  // `notice` only (a success must not be styled as a danger).
  ok(
    /notice\.value = parts\.join\(" · "\);/.test(dlg),
    "the summary is assembled into the notice"
  );
  ok(
    /if \(res\.failed\?\.length\) error\.value = notice\.value;/.test(dlg),
    "and a failed run also goes to the error line"
  );
  ok(
    !/error\.value = res\.failed\?\.length \? parts\.join/.test(dlg),
    "the old one-liner (which lost a successful summary entirely) is gone"
  );
  // `res.deleted` must be counted too — a report that only ever mentions
  // failures would read as "nothing happened".
  ok(/res\.deleted\?\.length \|\| 0/.test(dlg), "the deleted count is reported");
}

console.log("deletePercent");
{
  eq(deletePercent(0, 10), 0, "nothing deleted → 0%");
  eq(deletePercent(10, 10), 100, "all deleted → 100%");
  eq(deletePercent(3, 10), 30, "partial → proportional");
  eq(deletePercent(1, 3), 33, "rounded");
  // The whole point: the numerator is DELETED, not PROCESSED. A run where 2 of
  // 5 were skipped/failed must NOT look complete.
  eq(deletePercent(3, 5), 60, "skipped files hold the bar below 100%");
  // A zero total must not divide by zero (NaN would render as an empty/invalid
  // width and, before the clamp, could escape as a bogus percentage).
  eq(deletePercent(0, 0), 0, "zero total → 0%, not NaN");
  eq(deletePercent(5, 0), 0, "deleted>0 with zero total → still 0%");
  // Out-of-range inputs are clamped, not trusted: the backend's final event
  // carries processed == total, and a stray event after the reset could report
  // more than was requested.
  eq(deletePercent(15, 10), 100, "deleted > total clamps to 100%");
  eq(deletePercent(-3, 10), 0, "negative deleted clamps to 0%");
  eq(deletePercent(Number.NaN, 10), 0, "NaN deleted → 0% (Math.max/min absorb it)");
  // `eq` compares via JSON.stringify, where NaN serialises to null — assert the
  // numeric value directly so a regression to NaN cannot read as "some number".
  ok(Number.isFinite(deletePercent(Number.NaN, 10)), "NaN never escapes as a non-finite width");
  ok(Number.isFinite(deletePercent(1 / 0, 10)), "Infinity clamps to a finite 100%");
}

console.log("static: a finished delete re-arms the dialog");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");

  // The reported bug: after confirming, the compare list stayed on screen and
  // 「删除所选」 was still live. The fix is that a finished delete must clear
  // `groups` (and the per-file decisions that produced the delete list).
  const reset = dlg.slice(dlg.indexOf("function resetResults"), dlg.indexOf("function formatDate"));
  ok(reset.length > 0, "resetResults exists");
  for (const [line, what] of [
    ["groups.value = [];", "clears the compare list"],
    ["keepers.value = new Map();", "clears the keeper decisions"],
    ["checked.value = new Map();", "clears the per-file opt-outs"],
    ["hasRun.value = false;", "returns hasRun to false so the list is gone"],
  ]) {
    ok(reset.includes(line), `resetResults ${what}`);
  }
  // And it must actually be CALLED on the delete path — a helper nobody calls
  // is the exact shape of the original bug.
  const confirm = dlg.slice(dlg.indexOf("async function confirmDelete"), dlg.indexOf("function askConfirm"));
  ok(confirm.includes("resetResults();"), "confirmDelete calls resetResults after the delete returns");
  // ...and BEFORE emitting, so the panels refresh on an already-cleared dialog.
  ok(
    confirm.indexOf("resetResults();") < confirm.indexOf('emit("deleted"'),
    "resetResults runs before the panel-refresh emit"
  );
  // `run` reuses the same helper, so a rescan cannot inherit a stale list.
  const run = dlg.slice(dlg.indexOf("async function run()"), dlg.indexOf("async function stop()"));
  ok(run.includes("resetResults();"), "run() also resets, so a rescan starts clean");
}

console.log("static: the 扫描 button is re-armed, and only blocked while busy");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  // Slice the TEMPLATE, not the whole file: `indexOf("btn-primary")` finds the
  // first occurrence, which is the style block at the bottom — the assertions
  // then pass or fail for reasons unrelated to the button.
  const tmplEnd = dlg.indexOf("<script setup>");
  ok(tmplEnd > 0, "the template precedes the script block");
  const tmpl = dlg.slice(0, tmplEnd);
  // Slice from the `<button` TAG, not from `class="btn-primary"` — the `v-if`
  // sits BEFORE the class attribute, so anchoring on the class cuts it off and
  // every assertion below passes for the wrong reason. (Real failure mode hit
  // here: this reported 3 phantom failures on correct code.)
  const btnStart = tmpl.lastIndexOf("<button", tmpl.indexOf('class="btn-primary"'));
  const btn = tmpl.slice(btnStart, tmpl.indexOf('class="btn-stop"'));
  ok(btn.includes("<button"), "the scan button element was located in the template");
  ok(btn.includes('v-if="!scanning && !deleting"'), "扫描 shows only when neither scan nor delete is running");
  ok(
    !btn.includes('v-if="!scanning"'),
    "the old `v-if=\"!scanning\"` alone is gone — it let a scan start during a delete"
  );
  // 🚨 The original defect: `:disabled="hasRun"` made the button permanently
  // unusable after one scan.
  ok(!btn.includes(':disabled="hasRun"'), "扫描 is NOT disabled by hasRun (that made it dead after one scan)");
  ok(!/:disabled=/.test(btn), "no disabled binding at all on the scan button");
  // The delete button must stay disabled whenever nothing is selected. Same
  // anchoring rule: start at the tag. There are TWO `.btn-danger` elements
  // (the confirm box's 确认删除 and the footer's 删除所选) — anchor on the one
  // that carries the `summary.redundantCount` binding rather than the first.
  const delAt = tmpl.indexOf(':disabled="!summary.redundantCount || deleting"');
  ok(delAt > 0, "the footer delete button's disabled binding exists");
  const delStart = tmpl.lastIndexOf("<button", delAt);
  const del = tmpl.slice(delStart, tmpl.indexOf("@click=\"requestClose\"", delStart));
  ok(del.includes(":disabled="), "删除所选 is disabled with nothing selected AND while deleting");
  // The confirm box's own button must NOT carry that binding — it is a
  // different action (it does not read `summary`).
  const confirmBtnAt = tmpl.indexOf("@click=\"answerConfirm('ok')\"");
  ok(confirmBtnAt > 0, "the confirm box's own 确认删除 button exists");
  ok(
    !tmpl.slice(confirmBtnAt, tmpl.indexOf(">", confirmBtnAt)).includes(":disabled"),
    "and it does not inherit the footer's disabled binding"
  );
}

console.log("static: the delete list is hidden while a delete runs");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  // `groups` is only cleared once the delete RETURNS, so mid-delete the rows
  // still exist in state. Showing them invites clicking files already in the bin.
  ok(
    dlg.includes('v-if="groups.length && !deleting"'),
    "the compare list is hidden while deleting, not just after"
  );
  // And closing must be refused mid-delete, with an explanation rather than a
  // silently swallowed Esc.
  const close = dlg.slice(dlg.indexOf("function requestClose"), dlg.indexOf("function formatDate"));
  ok(close.includes("if (deleting.value)"), "requestClose refuses to close mid-delete");
  ok(
    /if \(deleting\.value\) \{[^}]*notice\.value =/.test(close),
    "and says why, instead of swallowing the key"
  );
  ok(!/if \(deleting\.value\) return;/.test(close), "no bare silent `return` on the mid-delete close path");
}

console.log("static: delete progress is driven by events, not by the frontend counting");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  const lib = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");

  // The delete is ONE IPC call on purpose (one bracket → one Ctrl+Z). Chunking
  // it from the frontend would break that, so progress must come from events.
  ok(
    dlg.includes('listen("dedup-delete-progress"'),
    "the dialog subscribes to dedup-delete-progress"
  );
  ok(dlg.includes("function onDeleteProgress"), "onDeleteProgress exists");
  ok(
    /if \(!payload \|\| !deleting\.value\) return;/.test(dlg),
    "a stray progress event on an idle dialog is ignored"
  );
  ok(
    dlg.includes("unlistenDeleteProgress?.()"),
    "the listener is torn down on unmount (otherwise it outlives the dialog)"
  );
  // The bar must advance on `deleted`, not `processed`.
  ok(
    /deletePercentRule\(deleteProgress\.value\.deleted, deleteProgress\.value\.total\)/.test(dlg),
    "the bar is computed from deleted/total, not processed"
  );
  ok(
    !/deletePercentRule\([\s\S]{0,80}processed/.test(dlg),
    "and never from processed"
  );
  // Backend side: it must emit as it goes, and the last event must be forced.
  ok(lib.includes('"dedup-delete-progress"'), "the backend emits dedup-delete-progress");
  ok(
    /fn emit_dedup_delete_progress/.test(lib) && /app\.emit\(\s*"dedup-delete-progress"/.test(lib),
    "the emitter is a real function that emits"
  );
  ok(
    /force: bool/.test(lib) && /processed == total/.test(lib),
    "the final step is force-emitted so the bar always reaches its end state"
  );
  // ⚠️ The assertion above is a real blind spot on its own: replacing
  // `processed == total` with `false` removes every occurrence of the token and
  // still satisfies it. What actually matters is the INVARIANT — the last file
  // is always reported, regardless of throttle. Two ways that can break:
  //   a) the `force` argument is no longer derived from `processed == total`;
  //   b) the throttle can swallow the last step even when force is true.
  // Every emit call must pass the comparison as its force argument. Checking
  // "at least one" would be satisfied by the Windows twin alone and would let
  // the not-Windows variant fall through to throttling; checking an exact COUNT
  // would break every time a platform variant is added. Assert all of them.
  const emitCalls = lib.match(
    /emit_dedup_delete_progress\(([\s\S]{0,200}?)\);/g
  ) || [];
  ok(emitCalls.length >= 2, `the emit call exists in both cfg variants (found ${emitCalls.length})`);
  const forced = emitCalls.filter((c) => /processed == total/.test(c));
  eq(
    forced.length,
    emitCalls.length,
    "EVERY emit call passes `processed == total` as its force argument"
  );
  // And the throttle must honour `force`: a `!force && <throttle>` shape means
  // a forced step can never be dropped. Normalise whitespace first — the source
  // wraps the condition across lines.
  const emitFn = lib.slice(
    lib.indexOf("fn emit_dedup_delete_progress"),
    lib.indexOf("/// Trash every confirmed duplicate")
  ).replace(/\s+/g, " ");
  ok(
    /if !force &&/.test(emitFn),
    "the throttle is gated on `!force` (a forced step is never dropped)"
  );
  // The `if !force && … { return; }` shape: a forced step falls THROUGH to the
  // emit, a throttled one returns early. Assert the early-return is INSIDE that
  // guard — `{ return; }` outside it would drop forced steps too.
  ok(
    /if !force && [^}]*\{ return; \}/.test(emitFn),
    "the early return is inside the `!force` guard, so a forced step falls through to the emit"
  );
  // Every branch of the delete loop must report — a `continue` that skipped
  // on_step would freeze the bar on the first changed/failed file.
  const trash = lib
    .slice(
      lib.indexOf("fn trash_dedup_items"),
      lib.indexOf("fn log_dedup_delete")
    )
    .replace(/\s+/g, " ");
  const steps = (trash.match(/on_step\(/g) || []).length;
  ok(steps >= 4, `all four outcomes of the loop call on_step (found ${steps})`);
  eq(
    (trash.match(/continue;/g) || []).length,
    2,
    "and both skip arms report BEFORE their `continue`"
  );
}

console.log("static: a success message never wears the danger colour");
{
  const dlg = fs.readFileSync(path.join(ROOT, "src", "components", "DedupDialog.vue"), "utf8");
  const tmpl = dlg.slice(0, dlg.indexOf("<script setup>"));
  // `error` is styled as danger; a successful delete must not be reported there.
  ok(dlg.includes("const notice = ref(\"\");"), "a separate `notice` ref exists for non-fatal outcomes");
  ok(
    tmpl.includes('v-if="notice && !error"'),
    "the notice renders only when there is no error to show instead"
  );
  ok(
    dlg.includes('class="dedup-notice"'),
    "and it uses its own class, not the danger-styled error line"
  );
  ok(
    dlg.includes(".dedup-notice {"),
    "that class is actually styled (a class with no rule renders unstyled)"
  );
  // The delete summary goes to BOTH when something failed — otherwise a partial
  // failure is styled as a clean success.
  ok(
    /if \(res\.failed\?\.length\) error\.value = notice\.value;/.test(dlg),
    "a failed run is also written to the error line"
  );
  // And the scan path must not inherit a stale success banner.
  const run = dlg.slice(dlg.indexOf("async function run()"), dlg.indexOf("async function stop()"));
  ok(/notice\.value = "";/.test(run), "run() clears a previous delete's notice");
}

// ── Known-bad arm ──
// METHODOLOGY: prove the harness can actually fail. It runs the SAME assertions
// against deliberately corrupted input, in a separate collector — clearing the
// shared `failures` array instead would wipe any REAL failure recorded above
// and let a broken suite report itself green (which is exactly what an earlier
// draft of this file did).
console.log("known-bad arm (must report failures)");
{
  const control = [];
  const cEq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) control.push(label);
  };

  // The reverse of the real assertion must be caught: if the implementation kept
  // the OLDEST copy, `k.get(0)` would be 2 and the real suite's `eq(k.get(0), 0)`
  // would have failed above. Run it explicitly and require the control to bite.
  cEq(defaultKeepers(groups).get(0), 0, "keeper is the newest");
  ok(control.length === 0, "control collector starts empty");

  cEq(defaultKeepers(groups).get(0), 2, "CONTROL: keeper is the oldest");
  ok(
    control.length === 1,
    "a deliberately wrong expectation IS recorded as a failure by the same comparison the suite uses"
  );
  control.length = 0;

  // And a second shape: an empty delete list when the keeper is present would
  // mean "nothing gets deleted", which must also be distinguishable.
  const k = defaultKeepers(groups);
  cEq(
    redundantFiles(groups, k, new Map()).map((f) => f.path),
    [],
    "CONTROL: nothing is redundant"
  );
  ok(
    control.length === 1,
    "an empty delete list is distinguishable from the real one"
  );
}

// ── report ──
console.log("");
if (failures.length) {
  console.error(`✗ ${failures.length} 条断言失败 / ${pass} 条通过`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ dedup-rules: ${pass} 条断言全部通过`);