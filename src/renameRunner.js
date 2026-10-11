// ── Batch rename executor ──
//
// Runs a plan produced by `renameRules.buildRenamePlan`. Two properties matter
// here, and both come straight from the project's "don't lose the user's data"
// rule:
//
//  1. **Every new name is computed BEFORE anything is renamed.** The dialog owns
//     that (it shows the plan), and this module refuses to start if any row is
//     still in error — a half-validated batch is worse than none.
//
//  2. **A partial failure must never leave the directory in a state the user
//     didn't ask for.** Cyclic renames (a→b, b→a) therefore go through a
//     temporary-name phase, and if anything fails we roll back everything we
//     already moved — reporting which items could not be restored rather than
//     silently leaving a mess.
//
// The actual rename is INJECTED as `move(fromPath, toName)`. That keeps this
// module free of the IPC layer (`api.js` reaches for the Tauri runtime), so the
// ordering logic — the part that is genuinely hard to get right — can be run
// against a plain in-memory filesystem by scripts/rename-rules-check.mjs.

import { planPhases, withNewName } from "./renameRules.js";

/// Execute the plan for `rows` (the array returned by `buildRenamePlan`).
///
/// `existing` — the Set of lower-cased names already in the target directory,
///              used only to pick collision-free temporary names. Pass null when
///              unknown.
/// `move`     — `(fromPath, toName) => Promise<void>`, the rename primitive.
///              In the app this is the backend's `rename_file`; `from` is a full
///              path and `to` a bare name in the same folder.
///
/// Resolves to `{ ok, done, failed, rolledBack }`:
///   `done`      — "old → new" lines for the report.
///   `failed`    — human-readable reasons (rule errors, IO errors, unrestored).
///   `rolledBack` — true when a failure was unwound cleanly.
export async function runRenamePlan(rows, { existing = null, move }) {
  if (typeof move !== "function") {
    throw new Error("runRenamePlan 需要 move(fromPath, toName) 回调");
  }
  const blocked = (rows || []).filter((r) => r.status === "error");
  if (blocked.length) {
    return {
      ok: false,
      done: [],
      failed: blocked.map((r) => `${r.name}: ${r.error}`),
      rolledBack: false,
    };
  }
  const moving = (rows || []).filter((r) => r.status === "ok");
  if (moving.length === 0) {
    return { ok: true, done: [], failed: [], rolledBack: false };
  }

  const { phase1, phase2, tempNameOf } = planPhases(rows, existing);

  // Every completed step, in order, as `{ to, backTo }` pairs so a failure can
  // be unwound by replaying them backwards. Deliberately NOT derived from
  // `rows` — a row's own fields are what we're mutating, so they can't double
  // as the undo log.
  const applied = [];
  const done = [];

  try {
    // ── Phase 1a: park the cyclic items under temporary names ──
    // Needed because `a→b, b→a` cannot be done in place: at the moment `a` is
    // renamed, `b` still exists and the OS refuses the overwrite.
    const tempPaths = new Map();
    for (const row of phase1) {
      const tmp = tempNameOf(row);
      const tmpPath = withNewName(row.path, tmp);
      await move(row.path, tmp);
      applied.push({ to: tmpPath, backTo: row.name });
      tempPaths.set(row, tmpPath);
    }

    // ── Phase 2: everything whose target was already free ──
    // ⚠️ This must run BEFORE phase 1b. A chained rename (`a→c`, `b→a`) puts
    // `b→a` in phase 1 precisely because `a` is still occupied at that moment —
    // and it is THIS loop's `a→c` that frees it. Parking first and finishing
    // phase 1 before phase 2 would try to create `a` while `a` still exists,
    // and the batch would fail on an ordering bug that looks like a
    // permissions problem.
    for (const row of phase2) {
      await move(row.path, row.newName);
      applied.push({ to: withNewName(row.path, row.newName), backTo: row.name });
      done.push(`${row.name} → ${row.newName}`);
    }

    // ── Phase 1b: temporary names → final names ──
    // Everything occupying a target name has now been moved out of the way (by
    // phase 1a for pure swaps, by phase 2 for chains), so these can land.
    for (const row of phase1) {
      await move(tempPaths.get(row), row.newName);
      applied.push({ to: withNewName(row.path, row.newName), backTo: tempNameOf(row) });
      done.push(`${row.name} → ${row.newName}`);
    }
  } catch (e) {
    // Unwind in reverse. A step can itself fail (something else touched the
    // file meanwhile) — keep going so the rest still get restored, and report
    // whatever is left behind rather than pretending the directory is clean.
    const unrestored = [];
    for (let i = applied.length - 1; i >= 0; i--) {
      try {
        await move(applied[i].to, applied[i].backTo);
      } catch {
        unrestored.push(applied[i].to);
      }
    }
    const failed = [`重命名失败：${e}`];
    if (unrestored.length) {
      failed.push(`以下项目回滚失败，请手动检查：${unrestored.join("、")}`);
    }
    return { ok: false, done, failed, rolledBack: unrestored.length === 0 };
  }

  return { ok: true, done, failed: [], rolledBack: false };
}
