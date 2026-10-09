#!/usr/bin/env node
// Front-end static sanity check.
//
// `vite build` only parses — it never resolves names, so a missing `computed`
// import or a renamed export sails straight through and blows up at runtime
// with a white screen ("Unhandled error during execution of setup function").
// Both bugs actually happened in this project. This script catches them
// statically, in about a second, with no bundler.
//
// Two checks:
//   1. Vue reactivity API usage vs. the file's `from "vue"` import list.
//   2. Named imports from local modules vs. those modules' `export` names.
//
// Usage:  node scripts/lint-imports.js [file-or-dir ...]
//         (no arguments → scans all of src/)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

// Everything a .vue/.js file can legitimately pull from "vue".
const VUE_APIS = [
  "ref", "computed", "watch", "reactive", "readonly", "shallowRef",
  "shallowReactive", "shallowReadonly", "toRef", "toRefs", "toRaw",
  "onMounted", "onBeforeMount", "onUnmounted", "onBeforeUnmount",
  "onActivated", "onDeactivated", "onErrorCaptured", "onRenderTracked",
  "onRenderTriggered", "nextTick", "provide", "inject", "defineComponent",
  "defineAsyncComponent", "getCurrentInstance", "h", "mergeProps",
  "useSlots", "useAttrs", "useId", "Teleport", "Transition", "KeepAlive",
  "Suspense", "Fragment",
];

function walk(target, out = []) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      // Skip build output / deps if someone points this at the repo root.
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      walk(path.join(target, name), out);
    }
  } else if (/\.(js|vue)$/.test(target)) {
    out.push(target);
  }
  return out;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// Strip comments so a mention inside prose isn't mistaken for a call site.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

// ── Check 1: vue API imports ──

function checkVueImports(file, src) {
  const problems = [];
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']vue["']/);
  const imported = new Set(
    m ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : []
  );
  const body = src.slice(m ? m.index + m[0].length : 0);

  for (const api of VUE_APIS) {
    // A call site: `computed(` / `watch(`, but not `foo.computed(` / `obj.computed(`.
    const re = new RegExp(`(?<![\\w.$])${api}\\s*\\(`, "g");
    let mm;
    while ((mm = re.exec(body)) !== null) {
      problems.push({ file, line: body.slice(0, mm.index).split("\n").length, api });
      break; // one report per API is enough
    }
  }

  return problems
    .filter((p) => !imported.has(p.api))
    .map((p) => `${rel(p.file)}:${p.line}  '${p.api}' 已使用但未从 "vue" 导入`);
}

// ── Check 2: local named imports have a matching export ──

function collectExports(file, acc) {
  const src = stripComments(read(file));
  const names = new Set();
  const add = (m) => m && names.add(m[1]);
  let mm;
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+let\s+(\w+)/g,
    /export\s+var\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
  ];
  for (const re of patterns) while ((mm = re.exec(src)) !== null) add(mm);
  // Re-exports: export { a, b as c } from "./x"  /  export * from "./x"
  const star = /export\s+\*\s+from\s+["'](\.[^"']+)["']/g;
  while ((mm = star.exec(src)) !== null) {
    const target = resolveLocal(file, mm[1]);
    if (target) for (const n of collectExports(target, acc)) names.add(n);
  }
  return names;
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + ".js", base + ".vue", path.join(base, "index.js")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function checkLocalImports(file, src) {
  const problems = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;
  let mm;
  while ((mm = re.exec(src)) !== null) {
    const names = mm[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const target = resolveLocal(file, mm[2]);
    if (!target) {
      problems.push(`${rel(file)}  找不到模块 '${mm[2]}'`);
      continue;
    }
    const have = collectExports(target, new Set());
    for (const n of names) {
      if (!have.has(n)) {
        problems.push(
          `${rel(file)}  从 '${mm[2]}' 导入了 '${n}'，但对方没有导出它`
        );
      }
    }
  }
  return problems;
}

// ── main ──

function rel(f) {
  return path.relative(ROOT, f).replace(/\\/g, "/");
}

const args = process.argv.slice(2);
const targets = args.length ? args : [SRC];
const files = [...new Set(targets.flatMap((t) => walk(path.resolve(t))))];

const problems = [];
for (const f of files) {
  const src = stripComments(read(f));
  problems.push(...checkVueImports(f, src));
  problems.push(...checkLocalImports(f, src));
}

if (problems.length) {
  console.error(`✗ ${problems.length} 处问题：\n`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`✓ 导入检查通过（${files.length} 个文件）`);