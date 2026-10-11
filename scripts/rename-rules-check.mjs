// Standalone sanity run for the pure rename logic. Not part of the app build —
// run with:  node scripts/rename-rules-check.mjs
//
// The batch-rename feature's risk is entirely in renameRules.js / renameRunner.js
// (collision detection, the two-phase swap, per-directory grouping), and none of
// that is reachable from `vite build`. This exercises it directly with a stub for
// the IPC layer.

import {
  splitName,
  validateName,
  computeNewName,
  buildRenamePlan,
  summarizePlan,
  planPhases,
  defaultRules,
} from "../src/renameRules.js";
import { runRenamePlan } from "../src/renameRunner.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
