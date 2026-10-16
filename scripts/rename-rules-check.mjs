// Standalone sanity run for the pure rename logic. Not part of the app build —
// run with:  node scripts/rename-rules-check.mjs
//
// The batch-rename feature's risk is entirely in renameRules.js / renameRunner.js
// (collision detection, the two-phase swap, per-directory grouping), and none of
// that is reachable from `vite build`. This exercises it directly with a stub for
// the IPC layer.

import fs from "node:fs";

import {
  splitName,
  validateName,
  computeNewName,
  buildRenamePlan,
  summarizePlan,
  planPhases,
  defaultRules,
} from "../src/renameRules.js";
import { runRenamePlan, applyRenamePlan } from "../src/renameRunner.js";

const base = defaultRules();
const R = (over) => ({ ...base, ...over });

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL ${label}\n  expected ${b}\n  actual   ${a}`);
  }
}
function ok(cond, label) {
  eq(!!cond, true, label);
}

// ── splitName ──
eq(splitName("a.txt"), { stem: "a", ext: ".txt" }, "splitName simple");
eq(splitName("archive.tar.gz"), { stem: "archive.tar", ext: ".gz" }, "splitName multi-dot");
eq(splitName("noext"), { stem: "noext", ext: "" }, "splitName no ext");
eq(splitName(".gitignore"), { stem: ".gitignore", ext: "" }, "splitName dotfile");
eq(splitName(""), { stem: "", ext: "" }, "splitName empty");

// ── validateName ──
eq(validateName("ok.txt"), null, "validate ok");
ok(validateName(""), "validate empty");
ok(validateName("   "), "validate blank");
ok(validateName("a/b"), "validate slash");
ok(validateName("a\\b"), "validate backslash");
ok(validateName("a:b"), "validate colon");
ok(validateName("a*b?c"), "validate wildcard");
ok(validateName("trailing."), "validate trailing dot");
ok(validateName("trailing "), "validate trailing space");
ok(validateName("CON"), "validate reserved CON");
ok(validateName("nul.txt"), "validate reserved NUL with ext");
ok(validateName("com1"), "validate reserved COM1");
ok(!validateName("console"), "validate 'console' is NOT reserved");
ok(!validateName("com10"), "validate 'com10' is NOT reserved");
ok(validateName("x".repeat(256)), "validate too long");
ok(!validateName("x".repeat(255)), "validate 255 ok");

// ── computeNewName: find / replace ──
eq(computeNewName("Hello.txt", 0, R({ find: "l", replace: "L" })).name, "HeLLo.txt", "replace all occurrences");
// "HELLO" must match "Hello" when case sensitivity is OFF (the default) — this
// asserts the insensitive path is actually insensitive, not just permissive.
eq(computeNewName("Hello.txt", 0, R({ find: "HELLO", replace: "x" })).name, "x.txt", "replace case-insensitive hit");
eq(computeNewName("Hello.txt", 0, R({ find: "ZZZ", replace: "x" })).name, "Hello.txt", "replace no match leaves name");
eq(computeNewName("Hello.txt", 0, R({ find: "HELLO", replace: "x", caseSensitive: true })).name, "Hello.txt", "replace case-sensitive miss");
eq(computeNewName("a1b2.txt", 0, R({ find: "\\d", replace: "#", useRegex: true })).name, "a#b#.txt", "regex global");
eq(computeNewName("a1b2.txt", 0, R({ find: "a(\\d)", replace: "$1", useRegex: true })).name, "1b2.txt", "regex capture group");
eq(computeNewName("a+b.txt", 0, R({ find: "a+b", replace: "x" })).name, "x.txt", "literal plus is escaped");
ok(computeNewName("a.txt", 0, R({ find: "(", replace: "x", useRegex: true })).error, "invalid regex reports error");

// ── computeNewName: numbering ──
const num = (over) => R({ numbering: true, ...over });
eq(computeNewName("a.txt", 0, num({})).name, "a_1.txt", "seq default first");
eq(computeNewName("a.txt", 1, num({})).name, "a_2.txt", "seq default second");
eq(computeNewName("a.txt", 0, num({ seqStart: 10 })).name, "a_10.txt", "seq start");
eq(computeNewName("a.txt", 2, num({ seqStart: 10, seqStep: 5 })).name, "a_20.txt", "seq start+step");
eq(computeNewName("a.txt", 0, num({ seqPad: 3 })).name, "a_001.txt", "seq pad");
eq(computeNewName("a.txt", 9, num({ seqPad: 2 })).name, "a_10.txt", "seq pad not truncating");
eq(computeNewName("a.txt", 0, num({ seqMode: "placeholder" })).name, "a.txt", "placeholder mode without token = no number");
eq(
  computeNewName("a.txt", 4, num({ seqMode: "placeholder", prefix: "[N]_" })).name,
  "5_a.txt",
  "placeholder in prefix"
);
eq(
  computeNewName("a.txt", 4, num({ seqMode: "placeholder", suffix: "_[N]" })).name,
  "a_5.txt",
  "placeholder in suffix"
);
eq(
  computeNewName("a.txt", 6, num({ seqMode: "placeholder", prefix: "[N]img", suffix: "x[N]" })).name,
  "7imgax7.txt",
  "token in both prefix and suffix, same number in each"
);
// A literal bracket that isn't a token must survive untouched.
eq(
  computeNewName("a.txt", 0, num({ seqMode: "placeholder", prefix: "img[", suffix: "]" })).name,
  "img[a].txt",
  "non-token brackets are left alone"
);
// Token resolution must happen BEFORE the append mode adds its own number.
eq(
  computeNewName("a.txt", 1, num({ seqMode: "placeholder", find: "a", replace: "[N]" })).name,
  "2.txt",
  "placeholder inside replacement"
);

// ── numbering: emptied inputs must fall back, NOT become 0 ──
// The dialog binds seqStart/seqStep/seqPad with `v-model.number` on
// `<input type="number">`. Clearing one leaves the empty STRING (Vue's
// `looseToNumber("")` is `parseFloat("") || ""`), not 0 — and the old guard
// `Number.isFinite(+v) ? +v : 1` was blind to it because `+""` is 0, which is
// finite, so the fallback could never fire.
//
// Every case below is asserted against the DEFAULT the dialog starts from, so
// they pin "empty behaves as untouched" rather than a magic number.
{
  const seqOf = (over, index) => computeNewName("a.txt", index, num(over)).seq;

  // Clearing START must number from 1, not from 0.
  eq(seqOf({ seqStart: "" }, 0), "1", "emptied seqStart falls back to 1");
  eq(seqOf({ seqStart: "" }, 2), "3", "emptied seqStart keeps numbering per row");
  // Clearing STEP must advance by 1. This is the load-bearing one: with step 0
  // every row computes the SAME number.
  eq(seqOf({ seqStep: "" }, 0), "1", "emptied seqStep falls back to 1");
  eq(seqOf({ seqStep: "" }, 2), "3", "emptied seqStep still advances across rows");
  // Whitespace is what a user actually leaves behind after select-all + space.
  eq(seqOf({ seqStart: "   " }, 1), "2", "whitespace-only seqStart falls back");
  eq(seqOf({ seqStep: "  " }, 1), "2", "whitespace-only seqStep falls back");
  // Both at once, and together with a padding that IS set. index 3 with the
  // defaults gives n = 4, which is already two digits — so pad 2 leaves it
  // alone. (Asserted at index 1 too, where padding genuinely shows.)
  eq(seqOf({ seqStart: "", seqStep: "", seqPad: 2 }, 1), "02", "both emptied, padding still applies");
  eq(seqOf({ seqStart: "", seqStep: "", seqPad: 2 }, 3), "04", "both emptied, two-digit number is not truncated");

  // 0 is a LEGAL start (the input is min="0"), so it must be honoured rather
  // than treated as "absent" — this is what separates a falsy check from an
  // emptiness check.
  eq(seqOf({ seqStart: 0 }, 0), "0", "seqStart 0 is honoured, not treated as empty");
  eq(seqOf({ seqStart: 0 }, 2), "2", "seqStart 0 still advances");
  eq(seqOf({ seqStep: 0 }, 2), "1", "explicit step 0 is honoured (frozen numbering)");

  // seqPad's own default is 0, which is why the old `parseInt(...) || 0`
  // happened to dodge the same trap — assert the empty case anyway so a future
  // refactor can't quietly reintroduce it there.
  eq(seqOf({ seqPad: "" }, 0), "1", "emptied seqPad falls back to no padding");
  eq(seqOf({ seqPad: "" }, 5), "6", "emptied seqPad still numbers per row");

  // Non-numeric junk falls back too, and must not partially parse.
  // The discriminating case: `parseInt("3abc")` is 3, `Number("3abc")` is NaN.
  // At index 1 that is n = 2 (fallback step 1) versus n = 4 (partial parse), so
  // this single assertion separates the two implementations.
  eq(seqOf({ seqStart: "abc" }, 1), "2", "non-numeric seqStart falls back");
  eq(seqOf({ seqStep: "3abc" }, 1), "2", "partial numeric is not parsed as 3");
  eq(seqOf({ seqStart: null }, 1), "2", "null seqStart falls back");
  eq(seqOf({ seqStep: undefined }, 1), "2", "undefined seqStep falls back");

  // Padding is still clamped to the input's 0..10 range — 99 becomes ten zeros.
  eq(seqOf({ seqPad: 99 }, 0), "0000000001", "seqPad clamped to 10");
  eq(seqOf({ seqPad: -5 }, 0), "1", "negative seqPad clamped to 0");
}

// End-to-end through the real planner: with STEP emptied the three rows used to
// land on a_1/b_1/c_1 — all distinct, so the duplicate check never fired and the
// batch ran silently with the wrong numbers. Assert the whole batch, not just
// the helper, so a future change to the collision check can't mask this.
{
  const SRC = [
    { path: "D:\\d\\a.txt", name: "a.txt" },
    { path: "D:\\d\\b.txt", name: "b.txt" },
    { path: "D:\\d\\c.txt", name: "c.txt" },
  ];
  const namesFor = (over) =>
    buildRenamePlan(SRC, new Set(), { ...base, numbering: true, ...over }).map((r) => r.newName);

  eq(namesFor({ seqStep: "" }), ["a_1.txt", "b_2.txt", "c_3.txt"], "emptied step numbers the batch correctly");
  eq(namesFor({ seqStart: "" }), ["a_1.txt", "b_2.txt", "c_3.txt"], "emptied start numbers the batch correctly");

  // Control arm proving the assertions above have teeth: the OLD behaviour is
  // reachable by asking for step 0 explicitly, and it is genuinely different.
  eq(namesFor({ seqStep: 0 }), ["a_1.txt", "b_1.txt", "c_1.txt"], "control: explicit step 0 freezes numbering");

  // And the frozen case really does pass the collision check — which is why
  // this was a silent wrong-write rather than a visible refusal.
  const frozen = buildRenamePlan(SRC, new Set(), { ...base, numbering: true, seqStep: 0 });
  eq(summarizePlan(frozen), { total: 3, ok: 3, unchanged: 0, errors: 0 },
    "control: frozen numbering is NOT caught by the duplicate check");
}

// ── computeNewName: prefix / suffix / case ──
eq(computeNewName("a.txt", 0, R({ prefix: "pre_", suffix: "_suf" })).name, "pre_a_suf.txt", "prefix+suffix");
eq(computeNewName("My File.TXT", 0, R({ caseMode: "lower" })).name, "my file.TXT", "lower only stem");
eq(computeNewName("My File.TXT", 0, R({ extMode: "lower" })).name, "My File.txt", "ext lower only");
eq(computeNewName("my file name.txt", 0, R({ caseMode: "kebab" })).name, "my-file-name.txt", "kebab");
eq(computeNewName("my-file-name.txt", 0, R({ caseMode: "camel" })).name, "myFileName.txt", "camel");
eq(computeNewName("myFileName.txt", 0, R({ caseMode: "snake" })).name, "my_file_name.txt", "snake");
eq(computeNewName("hello world.txt", 0, R({ caseMode: "title" })).name, "Hello World.txt", "title");
eq(computeNewName("a.txt", 0, R({ extMode: "remove" })).name, "a", "ext removed");
eq(computeNewName("a.txt", 0, R({ extMode: "replace", newExt: "png" })).name, "a.png", "ext replaced");
eq(computeNewName("a.txt", 0, R({ extMode: "replace", newExt: ".png" })).name, "a.png", "ext replaced, leading dot");
ok(computeNewName("a.txt", 0, R({ extMode: "replace", newExt: "  " })).error, "empty ext replacement errors");
eq(computeNewName(".gitignore", 0, R({ prefix: "x" })).name, "x.gitignore", "dotfile stem is whole name");

// A prefix that pushes the result over 255 chars must be reported, not written.
ok(computeNewName("a.txt", 0, R({ prefix: "p".repeat(300) })).error, "over-long result errors");
// Illegal character introduced by a rule is caught too.
ok(computeNewName("a.txt", 0, R({ prefix: "x/" })).error, "rule-introduced illegal char errors");

// ── buildRenamePlan: statuses ──
const item = (name, dir = "C:/d") => ({ name, path: `${dir}/${name}` });
{
  const rows = buildRenamePlan([item("a.txt"), item("b.txt")], null, base);
  eq(summarizePlan(rows), { total: 2, ok: 0, unchanged: 2, errors: 0 }, "no rules = all unchanged");
}
{
  const rows = buildRenamePlan(
    [item("a.txt"), item("b.txt")],
    null,
    R({ prefix: "x" })
  );
  eq(rows.map((r) => r.status), ["ok", "ok"], "prefix makes both ok");
  eq(rows.map((r) => r.newName), ["xa.txt", "xb.txt"], "prefix applied");
}
// Two rows computing the same target in the SAME directory is unfixable.
{
  const rows = buildRenamePlan(
    [item("a.txt"), item("b.txt")],
    null,
    R({ find: "^[ab]$", replace: "z", useRegex: true })
  );
  eq(rows.map((r) => r.status), ["error", "error"], "intra-batch dup detected");
  ok(rows.every((r) => r.error.includes("重名")), "dup error message");
}
// Same names in DIFFERENT directories is perfectly fine.
{
  const rows = buildRenamePlan(
    [item("a.txt", "C:/d1"), item("b.txt", "C:/d2")],
    null,
    R({ find: "^[ab]$", replace: "z", useRegex: true })
  );
  eq(rows.map((r) => r.status), ["ok", "ok"], "cross-directory dup allowed");
}
// Target collides with a bystander that is NOT in the batch.
{
  const rows = buildRenamePlan(
    [item("a.txt")],
    new Set(["z.txt"]),
    R({ find: "^a$", replace: "z", useRegex: true })
  );
  eq(rows[0].status, "error", "existing target detected");
  ok(rows[0].error.includes("已存在"), "existing error message");
}
// Target collides with a name another row in the batch is VACATING → legal (swap).
{
  const rows = buildRenamePlan([item("a.txt"), item("b.txt")], null, R({ prefix: "" }));
  // Identity rules produce no change, so use an explicit swap instead:
  const swap = buildRenamePlan(
    [item("a.txt"), item("b.txt")],
    new Set(["a.txt", "b.txt"]),
    { ...base, find: "a", replace: "TMP" }
  );
  eq(rows.length, 2, "identity rows still two");
  eq(swap[0].status, "ok", "swap target allowed");
  eq(swap[1].status, "unchanged", "non-moving row unchanged");
}
// Case-insensitive collision: A.txt → b.txt while b.txt exists.
{
  const rows = buildRenamePlan(
    [item("A.txt")],
    new Set(["b.txt"]),
    R({ caseMode: "lower", find: "A", replace: "b", caseSensitive: true })
  );
  eq(rows[0].status, "error", "case-insensitive existing detected");
}

// ── planPhases ──
{
  // a.txt → b.txt and b.txt → a.txt: both targets are occupied → both phase 1.
  const rows = buildRenamePlan(
    [item("a.txt"), item("b.txt")],
    new Set(["a.txt", "b.txt"]),
    { ...base, find: "a", replace: "b" }
  );
  // After the find/replace both rows want "b.txt" → that's a dup, not a swap.
  // Build the swap plan by hand to test planPhases directly.
  const hand = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "b.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "a.txt", status: "ok" },
  ];
  const { phase1, phase2, tempNameOf } = planPhases(hand, new Set(["a.txt", "b.txt"]));
  eq(phase1.length, 2, "swap: both in phase 1");
  eq(phase2.length, 0, "swap: none in phase 2");
  ok(tempNameOf(phase1[0]) && tempNameOf(phase1[0]) !== tempNameOf(phase1[1]), "temp names distinct");
  eq(rows.length, 2, "sanity");
}
{
  const hand = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "c.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "a.txt", status: "ok" },
  ];
  // a→c (free target), b→a (a is being vacated by the first row) → still phase 1.
  const { phase1, phase2 } = planPhases(hand, new Set(["a.txt", "b.txt"]));
  eq(phase2.map((r) => r.name), ["a.txt"], "chain: the free one runs in place");
  eq(phase1.map((r) => r.name), ["b.txt"], "chain: the blocked one is staged");
}
{
  const hand = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "c.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "d.txt", status: "ok" },
  ];
  const { phase1, phase2 } = planPhases(hand, new Set(["a.txt", "b.txt"]));
  eq(phase1.length, 0, "no cycle → nothing staged");
  eq(phase2.length, 2, "no cycle → both in place");
}

// ── runRenamePlan: real filesystem-free execution against a stub ──
// The stub models a directory as a Map path→name, which is enough to observe
// ordering and to force failures.
function makeFs() {
  const files = new Map();
  return {
    files,
    rename(from, to) {
      if (!files.has(from)) throw new Error(`Path does not exist: ${from}`);
      const dest = from.slice(0, Math.max(from.lastIndexOf("/"), from.lastIndexOf("\\")) + 1) + to;
      if (files.has(dest)) throw new Error(`Target already exists: ${dest}`);
      files.set(dest, to);
      files.delete(from);
    },
  };
}

{
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  fsys.files.set("C:/d/c.txt", "c.txt");
  const renameFile = (from, to) => fsys.rename(from, to);

  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "x1.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "x2.txt", status: "ok" },
    { path: "C:/d/c.txt", name: "c.txt", newName: "c.txt", status: "unchanged" },
  ];
  const res = await runRenamePlan(rows, {
    existing: new Set(["a.txt", "b.txt", "c.txt"]),
    move: renameFile,
  });
  ok(res.ok, "simple batch succeeded");
  eq(res.done.length, 2, "two renamed");
  eq([...fsys.files.keys()].sort(), ["C:/d/c.txt", "C:/d/x1.txt", "C:/d/x2.txt"], "files in place");
  ok(![...fsys.files.keys()].some((k) => k.includes("minitc_tmp")), "no temp files left behind");
}

{
  // The real swap: a→b, b→a.
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  const renameFile = (from, to) => fsys.rename(from, to);

  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "b.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "a.txt", status: "ok" },
  ];
  const res = await runRenamePlan(rows, {
    existing: new Set(["a.txt", "b.txt"]),
    move: renameFile,
  });
  ok(res.ok, "swap succeeded");
  eq([...fsys.files.keys()].sort(), ["C:/d/a.txt", "C:/d/b.txt"], "swap: both names still present");
  eq(fsys.files.get("C:/d/a.txt"), "a.txt", "swap: a.txt holds a.txt's content");
  eq(fsys.files.get("C:/d/b.txt"), "b.txt", "swap: b.txt holds b.txt's content");
}

{
  // Chain: a→c (free), b→a (a vacated). Phase 2 first, then phase 1's temp→final.
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  const renameFile = (from, to) => fsys.rename(from, to);
  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "c.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "a.txt", status: "ok" },
  ];
  const res = await runRenamePlan(rows, {
    existing: new Set(["a.txt", "b.txt"]),
    move: renameFile,
  });
  ok(res.ok, "chain succeeded");
  eq([...fsys.files.keys()].sort(), ["C:/d/a.txt", "C:/d/c.txt"], "chain: final state");
  ok(![...fsys.files.keys()].some((k) => k.includes("minitc_tmp")), "chain: no temp left");
}

{
  // Failure mid-batch must roll everything back.
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  fsys.files.set("C:/d/c.txt", "c.txt");
  let calls = 0;
  const renameFile = (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error("boom");
    fsys.rename(from, to);
  };
  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "x1.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "x2.txt", status: "ok" },
    { path: "C:/d/c.txt", name: "c.txt", newName: "x3.txt", status: "ok" },
  ];
  const res = await runRenamePlan(rows, {
    existing: new Set(["a.txt", "b.txt", "c.txt"]),
    move: renameFile,
  });
  ok(!res.ok, "failure reported");
  ok(res.rolledBack, "rollback claimed");
  eq(
    [...fsys.files.keys()].sort(),
    ["C:/d/a.txt", "C:/d/b.txt", "C:/d/c.txt"],
    "rolled back to original state"
  );
  ok(res.failed.some((f) => f.includes("boom")), "failure reason surfaced");
}

{
  // Error rows block the whole batch — nothing is touched.
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  let called = false;
  const renameFile = (from, to) => {
    called = true;
    fsys.rename(from, to);
  };
  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "x.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "y", status: "error", error: "名称为空" },
  ];
  const res = await runRenamePlan(rows, { move: renameFile });
  ok(!res.ok, "blocked batch not ok");
  ok(!called, "blocked batch performed no IO");
  eq([...fsys.files.keys()], ["C:/d/a.txt"], "blocked batch left the dir untouched");
}

{
  // A failure inside the SWAP phase must also unwind — including the temporary
  // names, which are the most visible mess if they leak (a directory suddenly
  // full of `~minitc_tmp_*` files).
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  const renameFile = (from, to) => fsys.rename(from, to);
  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "b.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "a.txt", status: "ok" },
  ];
  let calls = 0;
  const flaky = (from, to) => {
    calls += 1;
    if (calls === 3) throw new Error("boom in phase 1b");
    return renameFile(from, to);
  };
  const res = await runRenamePlan(rows, {
    existing: new Set(["a.txt", "b.txt"]),
    move: flaky,
  });
  ok(!res.ok, "swap failure reported");
  ok(res.rolledBack, "swap failure rolled back");
  eq([...fsys.files.keys()].sort(), ["C:/d/a.txt", "C:/d/b.txt"], "swap rolled back to original");
  ok(![...fsys.files.keys()].some((k) => k.includes("minitc_tmp")), "swap: no temp leaked");
}

{
  // Rollback that itself fails must be reported, not silently swallowed.
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");
  let calls = 0;
  const renameFile = (from, to) => {
    calls += 1;
    if (calls === 1) {
      fsys.rename(from, to);
      return;
    }
    if (calls === 2) throw new Error("boom");
    throw new Error("rollback blocked"); // every undo fails too
  };
  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "x.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "y.txt", status: "ok" },
  ];
  const res = await runRenamePlan(rows, { move: renameFile });
  ok(!res.ok, "failed rollback batch not ok");
  ok(!res.rolledBack, "rolledBack false when undo failed");
  ok(res.failed.some((f) => f.includes("回滚失败")), "unrestored items reported");
}

{
  // An empty / all-unchanged plan is a no-op success, not a failure.
  const res = await runRenamePlan(
    [{ path: "C:/d/a.txt", name: "a.txt", newName: "a.txt", status: "unchanged" }],
    { move: () => Promise.reject(new Error("must not be called")) }
  );
  ok(res.ok, "all-unchanged plan is ok");
  eq(res.done.length, 0, "all-unchanged plan renamed nothing");
}

// ── applyRenamePlan: the pairs handed back must describe what landed on disk ──
//
// The dialog passes `() => plan.value`, a getter over reactive rules, and the
// run is awaited. If the plan were re-read after the await, the panel would be
// told the names the rules produce NOW while the disk holds the old ones. The
// <fieldset disabled> makes that unreachable by keyboard, but the guarantee has
// to live in the code that owns the await, so it does.
{
  const fsys = makeFs();
  fsys.files.set("C:/d/a.txt", "a.txt");
  fsys.files.set("C:/d/b.txt", "b.txt");

  const rows = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "OLD-a.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "OLD-b.txt", status: "ok" },
  ];
  // What the rules would say if they changed mid-run: same paths, different
  // names. Reading this after the await is exactly the bug.
  const drifted = [
    { path: "C:/d/a.txt", name: "a.txt", newName: "NEW-a.txt", status: "ok" },
    { path: "C:/d/b.txt", name: "b.txt", newName: "NEW-b.txt", status: "ok" },
  ];
  let reads = 0;
  const getRows = () => (reads++ === 0 ? rows : drifted);

  const { res, pairs } = await applyRenamePlan(getRows, {
    existing: new Set(["a.txt", "b.txt"]),
    move: async (from, to) => fsys.rename(from, to),
  });

  ok(res.ok, "applyRenamePlan succeeded");
  eq(reads, 1, "plan getter read exactly once");
  // The disk state is the ground truth — compare the pairs against it rather
  // than against the row objects. A pair is [oldPath, newName], and oldPath is
  // by definition gone after the rename, so the path on disk is the old
  // directory plus the new name.
  const dirOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);
  const onDisk = [...fsys.files.keys()].sort();
  const fromPairs = pairs.map(([p, n]) => dirOf(p) + n).sort();
  eq(fromPairs, onDisk, "reported pairs resolve to the paths that now exist on disk");
  const namesOnDisk = [...fsys.files.values()].sort();
  const newNames = pairs.map(([, n]) => n).sort();
  eq(newNames, namesOnDisk, "reported new names are the names on disk");
  ok(!newNames.includes("NEW-a.txt"), "post-await rule drift did not leak into pairs");
}

{
  // Pairs are empty on failure — the panel must not patch rows for a batch
  // that was rolled back.
  const rows = [{ path: "C:/d/a.txt", name: "a.txt", newName: "x.txt", status: "ok" }];
  const { res, pairs } = await applyRenamePlan(() => rows, {
    move: () => Promise.reject(new Error("boom")),
  });
  ok(!res.ok, "failing run reported as not ok");
  eq(pairs, [], "no pairs emitted on failure");
}

{
  // `move` missing must throw rather than fail mysteriously later.
  let threw = false;
  try {
    await applyRenamePlan(() => [], {});
  } catch {
    threw = true;
  }
  ok(threw, "applyRenamePlan rejects without a move callback");
}

// ── static check: the three numbering fields must all go through seqNumber ──
// Pure-logic assertions stay green if someone reintroduces an inline coercion
// at ONE call site, so pin the wiring as well. This is the "changed the
// implementation, not the caller" guard.
{
  const src = fs.readFileSync(new URL("../src/renameRules.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function sequenceNumber"));
  const seqBody = body.slice(0, body.indexOf("\n}"));

  eq(
    (seqBody.match(/seqNumber\(/g) || []).length,
    3,
    "all three numbering fields route through seqNumber"
  );
  ok(/seqNumber\(rules\.seqStart,\s*1\)/.test(seqBody), "seqStart uses the 1 default");
  ok(/seqNumber\(rules\.seqStep,\s*1\)/.test(seqBody), "seqStep uses the 1 default");
  ok(/seqNumber\(rules\.seqPad,\s*0\)/.test(seqBody), "seqPad uses the 0 default");

  // The trap itself must not reappear anywhere in the numbering code.
  const seqSrc = src.slice(src.indexOf("function seqNumber"), src.indexOf("function sequenceNumber"));
  ok(!/\+\s*rules\.seq/.test(src), "no `+rules.seq*` coercion is left anywhere");
  ok(!/parseInt\(\s*rules\.seqPad/.test(src), "seqPad is not parseInt-based");
  ok(seqSrc.length > 0, "seqNumber helper is present");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
