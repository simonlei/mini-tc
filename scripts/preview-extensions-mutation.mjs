// Mutation harness for the "one suffix = one preview type" rules in
// src/previewExtensions.js.
//
// The failure mode is SILENT: a suffix claimed by two renderers would be
// previewed by whichever branch happens to run first, with no error anywhere.
// A suite that passes for the wrong reason is worse than no suite, so each
// mutant below must be caught. Per project methodology every substitution
// prints `anchor found: N` and asserts N === 1 — a substitution that never
// landed would otherwise make a blind suite look green.
//
// Run: node scripts/preview-extensions-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "src", "previewExtensions.js");
const SUITE = path.join(ROOT, "scripts", "preview-extensions-check.mjs");

const original = fs.readFileSync(TARGET, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const flat = (s) => s.replace(/\r\n/g, "\n");

function mutate(anchor, replacement) {
  const needle = flat(anchor).replace(/\n/g, eol);
  const parts = original.split(needle);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    throw new Error(`anchor must occur exactly once, got ${parts.length - 1}`);
  }
  return parts.join(flat(replacement).replace(/\n/g, eol));
}

const MUTANTS = [
  {
    name: "remove the cross-type collision guard in addExtToType",
    code: `  const owner = ownerOfExt(ext, mapping, type);
  if (owner) {
    return {
      mapping,
      error: \`后缀 \${extLabel(ext)} 已属于「\${typeLabel(owner)}」预览，请先从那里移除\`,
      owner,
    };
  }
`,
    restore: ``,
  },
  {
    name: "ownerOfExt never finds an owner",
    code: `    if (Array.isArray(list) && list.includes(ext)) return t.key;
`,
    restore: ``,
  },
  {
    name: "normalizeMapping stops deduplicating across types",
    code: `      if (claimed.has(ext)) return false;
      claimed.add(ext);
      return true;
`,
    restore: `      return true;
`,
  },
  {
    name: "classifyExt resolves a conflict to the LAST type instead of the first",
    code: `export function classifyExt(ext, mapping) {
  const needle = String(ext ?? "").trim().toLowerCase().replace(/^\\.+/, "");
  for (const t of PREVIEW_TYPES) {`,
    restore: `export function classifyExt(ext, mapping) {
  const needle = String(ext ?? "").trim().toLowerCase().replace(/^\\.+/, "");
  for (const t of [...PREVIEW_TYPES].reverse()) {`,
  },
  {
    name: "legacy delta array drops the built-in text suffixes",
    code: `    return cleanExtList([...defaultsFor("text"), ...parsed.map((e) => String(e))]);`,
    restore: `    return cleanExtList(parsed.map((e) => String(e)));`,
  },
  {
    name: "legacy {ext:bool} ignores the false entries",
    code: `        .filter(([, on]) => !!on)
`,
    restore: ``,
  },
  {
    name: "parseMapping ignores the new config file entirely",
    code: `      if (PREVIEW_TYPE_KEYS.some((k) => Array.isArray(body[k]))) {
        return normalizeMapping(body);
      }
`,
    restore: ``,
  },
  {
    name: "cleanExtList drops the extension-less '' sentinel",
    code: `    const sentinel = raw === "";
    const ext = sentinel ? "" : normalizeExt(raw);
    if (!sentinel && !ext) continue;
`,
    restore: `    const sentinel = false;
    const ext = normalizeExt(raw);
    if (!ext) continue;
`,
  },
  {
    name: "normalizeExt stops lowercasing",
    code: `  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\\.+/, "")
    .replace(/[^a-z0-9]/g, "");`,
    restore: `  return String(raw ?? "")
    .trim()
    .replace(/^\\.+/, "")
    .replace(/[^a-z0-9]/g, "");`,
  },
  {
    name: "serializeMapping persists a conflicting mapping verbatim",
    code: `  return JSON.stringify({ version: 2, types: normalizeMapping(mapping) });`,
    restore: `  return JSON.stringify({ version: 2, types: mapping });`,
  },
  {
    name: "extLabel no longer renders the (无后缀) sentinel",
    code: `  return ext === "" ? "(无后缀)" : "." + ext;`,
    restore: `  return "." + ext;`,
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const mutated = mutate(m.code, m.restore);
  if (mutated === original) {
    console.log(`  FAIL  ${m.name} — mutation produced no change`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(TARGET, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    tail = out.trim().split("\n").slice(-1)[0] || "";
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = out.trim().split("\n").filter((l) => /passed/.test(l)).slice(-1)[0] || "threw";
  } finally {
    // Restore from the in-memory original, NEVER from git: the restore
    // baseline is "how we found it this run", which may include uncommitted
    // work that a checkout would roll back.
    fs.writeFileSync(TARGET, original, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}`);
  }
}

const now = fs.readFileSync(TARGET, "utf8");
console.log(`\n  source restored: ${now === original}`);
if (now !== original) {
  fs.writeFileSync(TARGET, original, "utf8");
  console.log("  rewrote original");
  process.exit(1);
}

console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0) process.exit(1);
