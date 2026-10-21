// Mutation test for the duplicate-file decision logic and its guards.
//
// A green suite proves nothing unless the assertions can actually fail. Each
// mutation below breaks ONE real behaviour — the direction a plausible bug
// would take — and the suite must report it.
//
// House rules this follows (see .workbuddy/memory/METHODOLOGY.md):
//   - the suite imports the PRODUCTION module, so a mutation is visible;
//   - the mutator prints `anchor found: N` and ASSERTS N === 1, because a
//     `count == 0` (bad anchor / wrong line ending) reads as "0 failures" and
//     would be mistaken for "the assertions are blind";
//   - restore from the in-memory original only, NEVER `git checkout`.
//
// Run: node scripts/dedup-rules-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULES = path.join(ROOT, "src", "dedupRules.js");
const DIALOG = path.join(ROOT, "src", "components", "DedupDialog.vue");
const LIB = path.join(ROOT, "src-tauri", "src", "lib.rs");
const SUITE = path.join(ROOT, "scripts", "dedup-rules-check.mjs");

const original = new Map();
function read(p) {
  if (!original.has(p)) original.set(p, fs.readFileSync(p, "utf8"));
  return original.get(p);
}
function write(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

function runSuite() {
  try {
    const out = execFileSync(process.execPath, [SUITE], { encoding: "utf8", stdio: "pipe" });
    return { failed: 0, out };
  } catch (e) {
    // Non-zero exit = the suite caught it. That is the outcome we want.
    return { failed: 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// Collapse every whitespace run to a single space, keeping a map from each
// normalised index back to the ORIGINAL source index.
//
// Why this exists: `cargo fmt` freely rewraps Rust call sites, so a needle
// written against the pre-fmt line breaks silently stops matching. That is not
// a harmless annoyance — the mutation then never lands, and the runner reports
// "SURVIVED", i.e. it blames the assertions for a mutation that did not
// happen. It already bit this file twice (an emit call and a `let result`
// chain). With a map, needles can be written flat and still match wrapped
// source, while the file on disk keeps its original formatting.
function normalizeWithMap(src) {
  const chars = [];
  const map = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      while (i < src.length && /\s/.test(src[i])) i++;
      chars.push(" ");
      map.push(i - 1);
    } else {
      chars.push(src[i]);
      map.push(i);
      i++;
    }
  }
  return { text: chars.join(""), map };
}

// Replace `needle` with `replacement`, requiring EXACTLY one occurrence.
function mutate(p, needle, replacement, label) {
  const src = read(p);
  // Match against the normalised text, then splice the ORIGINAL by index so
  // nothing else in the file shifts.
  const { text, map } = normalizeWithMap(src);
  const nNorm = needle.replace(/\s+/g, " ").trim();
  const count = text.split(nNorm).length - 1;
  console.log(`  anchor found: ${count}`);
  if (count !== 1) {
    console.error(`✗ ${label}: anchor matched ${count} times (expected 1) — the mutation was NOT injected`);
    process.exitCode = 1;
    return false;
  }
  const startNorm = text.indexOf(nNorm);
  const startOrig = map[startNorm];
  // End: the character after the match, mapped back and stepped over the run of
  // whitespace that `normalizeWithMap` collapsed.
  let endNorm = startNorm + nNorm.length;
  while (endNorm < text.length && text[endNorm] === " ") endNorm++;
  const endOrig = map[endNorm - 1] + 1;
  write(p, src.slice(0, startOrig) + replacement + src.slice(endOrig));
  return true;
}

// ── Confirm the unmutated suite is green, so a later 0-failure is meaningful ──
console.log("baseline (no mutation)");
{
  const r = runSuite();
  if (r.failed !== 0) {
    console.error("✗ baseline suite is NOT green — fix that before mutating");
    console.error(r.out.split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
  console.log("  suite green ✓");
}

const mutations = [
  {
    label: "keeper picks the OLDEST instead of the newest",
    file: RULES,
    needle: "if (am !== bm) return am > bm;",
    replacement: "if (am !== bm) return am < bm;",
  },
  {
    label: "keeper tie-break picks the LARGER path (still deterministic, still wrong)",
    file: RULES,
    needle: "return String(a.path) < String(b.path);",
    replacement: "return String(a.path) > String(b.path);",
  },
  {
    label: "defaultKeepers defaults to 0 instead of scanning for the newest",
    file: RULES,
    needle: "let best = 0;\n    for (let i = 1; i < files.length; i++) {\n      if (isNewer(files[i], files[best])) best = i;\n    }",
    replacement: "let best = 0;\n    for (let i = 1; i < files.length; i++) {\n      if (false && isNewer(files[i], files[best])) best = i;\n    }",
  },
  {
    label: "redundantFiles keeps the keeper too (would delete EVERY copy)",
    file: RULES,
    needle: "if (fi === keep) return;",
    replacement: "if (false && fi === keep) return;",
  },
  {
    label: "redundantFiles ignores the user's per-file opt-out",
    file: RULES,
    needle: "if (checked && checked.get(f.path) === false) return;",
    replacement: "if (false && checked && checked.get(f.path) === false) return;",
  },
  {
    label: "redundantFiles treats a single-member group as deletable",
    file: RULES,
    needle: "if (files.length < 2) return;",
    replacement: "if (files.length < 1) return;",
  },
  {
    label: "switchKeeper accepts an out-of-range index",
    file: RULES,
    needle: "if (fileIndex < 0 || fileIndex >= files.length) return keepers;",
    replacement: "if (false) return keepers;",
  },
  {
    label: "switchKeeper mutates the caller's map instead of returning a new one",
    file: RULES,
    needle: "const next = new Map(keepers);\n  next.set(groupIndex, fileIndex);\n  return next;",
    replacement: "keepers.set(groupIndex, fileIndex);\n  return keepers;",
  },
  {
    label: "toggleChecked lets the keeper be checked (footer count would lie)",
    file: RULES,
    needle: "if (fileIndex === keep) return checked;",
    replacement: "if (false && fileIndex === keep) return checked;",
  },
  {
    label: "checkAllInGroup drops other groups' opt-outs",
    file: RULES,
    needle: "const next = new Map(checked);\n  files.forEach((f, fi) => {\n    if (fi === keep) next.delete(f.path);\n    else next.set(f.path, true);\n  });",
    replacement: "const next = new Map();\n  files.forEach((f, fi) => {\n    if (fi === keep) next.delete(f.path);\n    else next.set(f.path, true);\n  });",
  },
  {
    label: "reclaimableBytes drops the last file (off-by-one in the sum)",
    file: RULES,
    needle: "return redundant.reduce((sum, f) => sum + (f.size || 0), 0);",
    replacement: "return redundant.slice(0, -1).reduce((sum, f) => sum + (f.size || 0), 0);",
  },
  {
    label: "buildDeletePayload drops the mtime → the backend cannot detect a stale file",
    file: RULES,
    needle: "modified: f.modified,",
    replacement: "modified: 0,",
  },
  {
    label: "buildDeletePayload drops the size → same, for the length check",
    file: RULES,
    needle: "size: f.size,",
    replacement: "size: 0,",
  },
  {
    label: "backend stops checking mtime before trashing",
    file: LIB,
    needle: "|| system_time_to_millis(meta.modified()) != item.modified",
    replacement: "|| false",
  },
  {
    label: "backend stops checking size before trashing",
    file: LIB,
    needle: "|| meta.len() != item.size",
    replacement: "|| false",
  },
  {
    label: "backend follows symlinks when re-checking (was symlink_metadata)",
    file: LIB,
    needle: "let meta = match fs::symlink_metadata(p) {",
    replacement: "let meta = match fs::metadata(p) {",
  },
  {
    label: "backend no longer refuses a path that became a symlink",
    file: LIB,
    needle: "if meta.file_type().is_symlink()\n            || !meta.is_file()",
    replacement: "if false\n            || !meta.is_file()",
  },
  {
    label: "backend no longer refuses a path that is no longer a plain file",
    file: LIB,
    needle: "|| !meta.is_file()\n            || meta.len() != item.size",
    replacement: "|| false\n            || meta.len() != item.size",
  },
  {
    // ⚠️ The mutations below live in code that appears TWICE: `dedup_delete` is
    // a pair of cfg-gated twins (Windows / not-Windows) with near-identical
    // bodies. `mutate` requires exactly one match, so the needle has to carry
    // enough context to pin ONE of them — the Windows variant, which is the one
    // that actually runs here. Without that context these read "ANCHOR MISS",
    // i.e. the mutation silently did nothing.
    // Needle anchored on the `Err(_)` arm alone (unique: the delete loop is the
    // only place that pushes to `changed` from a stat failure). An earlier
    // version included the leading `match` + its indentation, which stopped
    // matching the moment `cargo fmt` reindented the line — "ANCHOR MISS" on
    // correct code. Keep needles short and free of indentation assumptions.
    label: "the changed arm warns but falls through and trashes anyway",
    file: LIB,
    needle:
      "Err(_) => {\n                changed.push(item.path.clone());\n                on_step(i + 1, total, deleted.len(), &item.path);\n                continue;\n            }",
    replacement: "Err(_) => {\n                changed.push(item.path.clone());\n            }",
  },
  {
    label: "one undo bracket per batch is replaced by none",
    file: LIB,
    needle:
      "    let before = trash_snapshot_ids();\n    // Start the clock \"already expired\" so the first file reports immediately",
    replacement: "    // Start the clock \"already expired\" so the first file reports immediately",
  },
  {
    label: "the dedup cancel slot shares the search slot's cancel-and-replace",
    file: LIB,
    needle: "if let Some(prev) = guard.insert(id, flag.clone()) {\n            prev.store(true, std::sync::atomic::Ordering::SeqCst);\n        }",
    replacement: "guard.clear();\n        guard.insert(id, flag.clone());",
  },
  {
    label: "the dialog stops gating the global keyboard",
    // The gate lives in App.vue's onGlobalKeydown, NOT in the dialog — an
    // earlier draft of this script pointed at the wrong file and reported
    // "anchor found: 0" (correctly flagged, but it mutated nothing).
    //
    // `if (dedupVisible.value) return;` appears TWICE in App.vue (the re-entry
    // guard in openDedup and the modal gate in onGlobalKeydown), so the anchor
    // has to carry its surrounding context to pin the one we mean.
    file: path.join(ROOT, "src", "App.vue"),
    needle: "if (dedupVisible.value) return;\n\n  // The conflict prompt",
    replacement: "if (false && dedupVisible.value) return;\n\n  // The conflict prompt",
  },
  {
    label: "the dialog accepts events from a stale scan (onDone)",
    file: DIALOG,
    needle: "clearTimeout(stopFallback);\n  if (!payload || payload.id !== dedupId) return;",
    replacement: "clearTimeout(stopFallback);\n  if (!payload) return;",
  },
  {
    label: "the dialog accepts events from a stale scan (onProgress)",
    file: DIALOG,
    needle: 'console.warn(`[dedup] ${name}: event carried no payload`, event);\n    return null;\n  }\n  return p;\n}\n\nfunction onProgress(event) {\n  const payload = unwrap(event, "dedup-progress");\n  if (!payload || payload.id !== dedupId) return;',
    replacement: 'console.warn(`[dedup] ${name}: event carried no payload`, event);\n    return null;\n  }\n  return p;\n}\n\nfunction onProgress(event) {\n  const payload = unwrap(event, "dedup-progress");\n  if (!payload) return;',
  },
  {
    label: "the dialog reads the wrapper instead of the payload",
    file: DIALOG,
    needle: "  const p = event?.payload;",
    replacement: "  const p = event;",
  },
  {
    label: "the dialog stops excluding empty files from the scan",
    file: DIALOG,
    needle: "includeEmpty: false,",
    replacement: "includeEmpty: true,",
  },
  {
    label: "the dialog deletes without waiting for the confirmation",
    file: DIALOG,
    needle: 'if (choice !== "ok") return;',
    replacement: 'if (choice === "__never__") return;',
  },
  {
    label: "the dialog swallows the changed/failed report",
    file: DIALOG,
    needle: "if (res.changed?.length) {",
    replacement: "if (false && res.changed?.length) {",
  },
  {
    label: "the delete list is hidden while a delete runs",
    file: DIALOG,
    needle: 'v-if="groups.length && !deleting"',
    replacement: 'v-if="groups.length"',
  },
  {
    label: "the dialog refuses to close mid-delete",
    file: DIALOG,
    needle: '  if (deleting.value) {\n    notice.value = "正在删除，请稍候…";\n    return;\n  }',
    replacement: '  if (false && deleting.value) {\n    notice.value = "正在删除，请稍候…";\n    return;\n  }',
  },
  {
    label: "the delete no longer clears the compare list (the reported bug)",
    file: DIALOG,
    needle: '    resetResults();\n    emit("deleted", res);',
    replacement: '    emit("deleted", res);',
  },
  {
    label: "resetResults stops returning hasRun to false (the scan button stays dead)",
    file: DIALOG,
    needle: "  hasRun.value = false;\n  doneInfo.value = null;",
    replacement: "  doneInfo.value = null;",
  },
  {
    label: "the scan button is disabled by hasRun again (the original defect)",
    file: DIALOG,
    needle: 'v-if="!scanning && !deleting" class="btn-primary" @click="run"',
    replacement: 'v-if="!scanning" class="btn-primary" :disabled="hasRun" @click="run"',
  },
  {
    label: "the delete button no longer disables while deleting",
    file: DIALOG,
    needle: ':disabled="!summary.redundantCount || deleting"',
    replacement: ':disabled="!summary.redundantCount"',
  },
  {
    // ⚠️ `if (false && A || B)` does NOT remove A: `&&` binds tighter than
    // `||`, so it parses as `(false && A) || B` == `B` — the mutation was a
    // no-op and "survived" for the wrong reason. Remove the guard outright.
    label: "deletePercent loses its total guard",
    file: RULES,
    needle: "  if (!Number.isFinite(total) || total <= 0) return 0;\n  if (!Number.isFinite(deleted)) return 0;",
    replacement: "  if (total <= 0) return 0;",
  },
  {
    label: "deletePercent loses its NaN guard (clamping cannot absorb NaN)",
    file: RULES,
    needle: "  if (!Number.isFinite(deleted)) return 0;\n  return Math.max(0, Math.min(100, Math.round((deleted / total) * 100)));",
    replacement: "  return Math.max(0, Math.min(100, Math.round((deleted / total) * 100)));",
  },
  {
    label: "the dialog applies delete-progress events while idle",
    file: DIALOG,
    needle: "  if (!payload || !deleting.value) return;\n  deleteProgress.value = {",
    replacement: "  if (!payload) return;\n  deleteProgress.value = {",
  },
  {
    label: "the delete-progress listener is never torn down",
    file: DIALOG,
    needle: "  unlistenDeleteProgress?.();\n",
    replacement: "",
  },
  {
    // `processed == total, &mut last,` occurs TWICE — the emit call is spelled
    // identically in both cfg-gated `dedup_delete` twins. Anchor through the
    // preceding statements, which only the Windows variant has (the other has
    // no bin snapshot around it).
    //
    // ⚠️ Written FLAT on purpose: `cargo fmt` rewraps these calls (this needle
    // broke once for exactly that reason, and `mutate()` correctly reported
    // "anchor found: 0" rather than pretending the mutation landed).
    // `normalizeWithMap` collapses whitespace before matching, so a flat needle
    // still finds the wrapped source.
    label: "the backend stops force-emitting the final progress step",
    file: LIB,
    needle:
      "let mut last = std::time::Instant::now() - std::time::Duration::from_millis(DEDUP_DELETE_PROGRESS_INTERVAL_MS as u64); let result = trash_dedup_items(&items, |processed, total, deleted, name| { emit_dedup_delete_progress( &app, processed, total, deleted, name, processed == total, &mut last,",
    replacement:
      "let mut last = std::time::Instant::now() - std::time::Duration::from_millis(DEDUP_DELETE_PROGRESS_INTERVAL_MS as u64); let result = trash_dedup_items(&items, |processed, total, deleted, name| { emit_dedup_delete_progress( &app, processed, total, deleted, name, false, &mut last,",
  },
  {
    label: "the backend skips progress on the changed-file arm (the bar freezes)",
    file: LIB,
    needle:
      "        if meta.file_type().is_symlink()\n            || !meta.is_file()\n            || meta.len() != item.size\n            || system_time_to_millis(meta.modified()) != item.modified\n        {\n            changed.push(item.path.clone());\n            on_step(i + 1, total, deleted.len(), &item.path);\n            continue;\n        }",
    replacement:
      "        if meta.file_type().is_symlink()\n            || !meta.is_file()\n            || meta.len() != item.size\n            || system_time_to_millis(meta.modified()) != item.modified\n        {\n            changed.push(item.path.clone());\n            continue;\n        }",
  },
  {
    label: "a failed delete is reported as a plain success",
    file: DIALOG,
    needle: "    if (res.failed?.length) error.value = notice.value;",
    replacement: "    if (false && res.failed?.length) error.value = notice.value;",
  },
  {
    label: "run() no longer clears the previous delete's notice",
    file: DIALOG,
    needle: '  error.value = "";\n  notice.value = "";\n  resetResults();',
    replacement: '  error.value = "";\n  resetResults();',
  },
];

let survived = 0;
const survivors = [];

for (const m of mutations) {
  console.log(`\nmutation: ${m.label}`);
  if (!mutate(m.file, m.needle, m.replacement, m.label)) {
    survived++;
    survivors.push(`${m.label} (ANCHOR MISS — not injected)`);
    continue;
  }
  const r = runSuite();
  if (r.failed === 0) {
    survived++;
    survivors.push(m.label);
    console.log("  ✗ SURVIVED — the suite did not notice");
  } else {
    console.log("  ✓ caught");
  }
  write(m.file, read(m.file));
}

// Everything restored from memory, never from git (METHODOLOGY: `git checkout`
// would roll back this whole session's work).
console.log("");
for (const [p, s] of original) write(p, s);

if (survived) {
  console.error(`✗ ${survived}/${mutations.length} 个变异存活：`);
  for (const s of survivors) console.error("  - " + s);
  process.exit(1);
}
console.log(`✓ dedup-rules-mutation: ${mutations.length} 个变异全部被捕获`);