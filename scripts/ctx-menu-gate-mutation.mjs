// Mutation harness for the context-menu landing gate.
//
// Why: the failure this guard prevents is SILENT and destructive — a stale
// right-click used to take over the newer row's menu, so「重命名」/「以管理员
// 身份运行」applied to a different file than the one on screen, with no error.
// A test that passes for the wrong reason would be worse than no test, so every
// mutant below must be caught.
//
// Per project methodology the script prints `anchor found: N` and asserts
// N === 1: a failed substitution would exit 0 and a 0-FAIL result could not
// then distinguish "the assertions have no teeth" from "the mutation never
// landed".
//
// Run: node scripts/ctx-menu-gate-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "src", "ctxMenuGate.js");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const SUITE = path.join(ROOT, "scripts", "ctx-menu-gate-check.mjs");

const originals = {
  [GATE]: fs.readFileSync(GATE, "utf8"),
  [PANEL]: fs.readFileSync(PANEL, "utf8"),
};

/// Replace every occurrence of `anchor`; hard-fail unless there is exactly one.
function mutate(file, anchor, replacement) {
  const src = originals[file];
  const parts = src.split(anchor);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    throw new Error(`anchor must occur exactly once, got ${parts.length - 1}: ${anchor}`);
  }
  return parts.join(replacement);
}

const G = GATE;
const P = PANEL;

const MUTANTS = [
  // ── 判据本身 ──
  {
    file: G,
    name: "判据退化为恒 true（= 没有守卫）",
    from: `  if (token !== current) return false;`,
    to: ``,
  },
  {
    file: G,
    name: "只比 token，丢掉目的地（导航后仍会落地）",
    from: `  if (path !== currentPath) return false;
  if (tabId !== currentTabId) return false;
  return true;`,
    to: `  return true;`,
  },
  {
    file: G,
    name: "只比路径，丢掉 tabId（切 tab 后仍会落地）",
    from: `  if (tabId !== currentTabId) return false;
  return true;`,
    to: `  return true;`,
  },
  {
    file: G,
    name: "路径用宽松相等（'' == undefined，路径刚清空时判为没变）",
    from: `  if (path !== currentPath) return false;`,
    to: `  // eslint-disable-next-line eqeqeq
  if (path == currentPath) return false;`,
  },
  {
    file: G,
    name: "reset() 不清 current（在飞构建永远不会被作废）",
    from: `    reset() {
      current = null;
    },`,
    to: `    reset() {
      /* no-op */
    },`,
  },
  {
    file: G,
    name: "begin() 不换 token（第二次右键无法作废第一次）",
    from: `      current = {};
      return current;`,
    to: `      if (!current) current = {};
      return current;`,
  },

  // ── 调用点 ──
  // 纯逻辑断言管不了这些：改 FilePanel.vue 的调用点，判据函数本身仍然全绿。
  {
    file: P,
    name: "调用点：删掉 ensureArchiveTools 之后的复核",
    from: `  await ensureArchiveTools();
  if (superseded()) return;`,
    to: `  await ensureArchiveTools();`,
  },
  {
    file: P,
    name: "调用点：删掉 isExecutable 之后的复核（最隐蔽的那个 await）",
    from: `      isExecutableRow = await isExecutable(full);
      if (superseded()) return;`,
    to: `      isExecutableRow = await isExecutable(full);`,
  },
  {
    file: P,
    name: "调用点：所有复核都堆到最后一个 await 之后（总数不变，逐个查才抓得到）",
    from: `  await ensureArchiveTools();
  if (superseded()) return;`,
    to: `  await ensureArchiveTools();`,
  },
  {
    file: P,
    name: "调用点：ctxEntry 又提前到 await 之前赋值（原 bug 的形状）",
    from: `  ctxEntry.value = entry;
  ctxMenu.value = { visible: true, x, y, items: buildMenuItems(entry), path };`,
    to: `  ctxMenu.value = { visible: true, x, y, items: buildMenuItems(entry), path };`,
  },
  {
    file: P,
    name: "调用点：ctxIsExecutable 直接写共享 ref（半更新的中间态会漏进菜单）",
    from: `  let isExecutableRow = false;`,
    to: `  ctxIsExecutable.value = false;
  let isExecutableRow = false;`,
  },
  {
    file: P,
    name: "调用点：closeCtxMenu 不 reset（关掉菜单后探测完成会再弹一次）",
    from: `  ctxMenu.value = { ...ctxMenu.value, visible: false };
  // Also invalidate builds that haven't produced a menu yet: dismissing a menu
  // (or any click landing outside it) is the user saying "not that one", and a
  // probe still in flight must not pop a menu afterwards. Safe to call from
  // \`handleCtxSelect\` — by then the menu is already on screen, so the token has
  // landed and there is nothing left to cancel.
  ctxGate.reset();`,
    to: `  ctxMenu.value = { ...ctxMenu.value, visible: false };`,
  },
  {
    file: P,
    name: "调用点：handleCtxSelect 改回重读 activeTab（路径快照丢失）",
    from: `  const path = ctxMenu.value.path;
  if (!path) return;`,
    to: `  const path = activeTab.value?.path;
  if (!path) return;`,
  },
  {
    file: P,
    name: "调用点：doExtract 不接 basePath（快照只传了一半）",
    from: `async function doExtract(targets, tool, mode, basePath) {
  const path = basePath || activeTab.value?.path;`,
    to: `async function doExtract(targets, tool, mode) {
  const path = activeTab.value?.path;`,
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = originals[m.file];
  const mutated = mutate(m.file, m.from, m.to);

  if (mutated === before) {
    console.log(`  FAIL  ${m.name} — mutation produced no change`);
    missed += 1;
    continue;
  }

  fs.writeFileSync(m.file, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    tail = (out.match(/^\d+ passed \/ \d+ failed.*$/m) || [""])[0];
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = (out.match(/^\d+ passed \/ \d+ failed.*$/m) || [""])[0] || "threw";
  } finally {
    fs.writeFileSync(m.file, before, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}  (${tail})`);
  }
}

// The files must be byte-identical to how we found them.
console.log("");
let dirty = false;
for (const [file, src] of Object.entries(originals)) {
  const now = fs.readFileSync(file, "utf8");
  const same = now === src;
  console.log(`  source restored: ${path.basename(file)} = ${same}`);
  if (!same) {
    dirty = true;
    fs.writeFileSync(file, src, "utf8");
    console.log("    rewrote original");
  }
}
if (dirty) process.exit(1);

console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0) process.exit(1);