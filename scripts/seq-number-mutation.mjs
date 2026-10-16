// Mutation harness for the seqNumber fallback in src/renameRules.js.
//
// Why: the fix is three lines of input coercion, and the failure it prevents is
// SILENT — an emptied number box used to yield 0 and write wrong names with no
// error. A test that passes for the wrong reason would be worse than no test,
// so each mutant below must be caught. Per project methodology the script
// prints `anchor found: N` and asserts N === 1: a failed substitution exits 0
// and would otherwise be misread as "the assertions have no teeth".
//
// Run: node scripts/seq-number-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "src", "renameRules.js");
const SUITE = path.join(ROOT, "scripts", "rename-rules-check.mjs");

const original = fs.readFileSync(TARGET, "utf8");

/// Replace the single occurrence of `anchor`; hard-fail if it is not exactly one.
function mutate(anchor, replacement) {
  const parts = original.split(anchor);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    throw new Error(`anchor must occur exactly once, got ${parts.length - 1}: ${anchor}`);
  }
  return parts.join(replacement);
}

const MUTANTS = [
  {
    // The original bug, verbatim: `+""` is 0, which is finite, so the fallback
    // can never fire. This is the mutant that must be caught above all.
    name: "revert to the old guard (`Number.isFinite(+v) ? +v : fallback`)",
    code: `function seqNumber(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}`,
    restore: `function seqNumber(value, fallback) {
  return Number.isFinite(+value) ? +value : fallback;
}`,
  },
  {
    name: "drop the empty-string check entirely",
    code: `  if (typeof value === "string" && value.trim() === "") return fallback;`,
    restore: ``,
  },
  {
    name: "use a falsy check — 0 becomes indistinguishable from empty",
    code: `  if (typeof value === "string" && value.trim() === "") return fallback;`,
    restore: `  if (!value) return fallback;`,
  },
  {
    name: "whitespace-only no longer falls back",
    code: `  if (typeof value === "string" && value.trim() === "") return fallback;`,
    restore: `  if (value === "") return fallback;`,
  },
  {
    name: "skip the null/undefined guard",
    code: `  if (value === null || value === undefined) return fallback;`,
    restore: `  if (value === undefined) return fallback;`,
  },
  {
    name: "partial parse: parseInt instead of Number",
    code: `  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;`,
    restore: `  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;`,
  },
  {
    name: "trust NaN instead of falling back",
    code: `  return Number.isFinite(n) ? n : fallback;`,
    restore: `  return n;`,
  },
  {
    name: "fall back to 0 rather than the caller's default (step would freeze again)",
    code: `  return Number.isFinite(n) ? n : fallback;`,
    restore: `  return Number.isFinite(n) ? n : 0;`,
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = original;
  const anchor = m.code;
  const mutated = mutate(anchor, m.restore);

  if (mutated === original) {
    console.log(`  FAIL  ${m.name} — mutation produced no change`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(TARGET, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    tail = out.trim().split("\n").slice(-1)[0] || "";
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = out.trim().split("\n").filter((l) => /passed/.test(l)).slice(-1)[0] || "threw";
  } finally {
    fs.writeFileSync(TARGET, before, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}`);
  }
}

// The file must be byte-identical to how we found it.
const now = fs.readFileSync(TARGET, "utf8");
console.log(`\n  source restored: ${now === original}`);
if (now !== original) {
  fs.writeFileSync(TARGET, original, "utf8");
  console.log("  rewrote original");
  process.exit(1);
}

console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0) process.exit(1);
