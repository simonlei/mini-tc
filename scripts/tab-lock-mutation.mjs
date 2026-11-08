// 变异测试：确认 tab-lock-check.mjs 的断言真能抓到「回到锁定位置无效」的退化实现。
//
// 这个 bug 的失效是**静默**的：点完菜单，用户看到的目录一点没变 —— 没有报错、
// 没有提示，连内部状态都改对了（tab.path 确实是锁定位置）。所以「测试全绿」
// 和「bug 还在」可以同时成立。这里每个变异都必须让套件 FAIL；漏掉一个即视为
// 断言没有分辨力。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的修复一起回滚）。
//
// Run: node scripts/tab-lock-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "tab-lock-check.mjs");
const LOCK = path.join(ROOT, "src", "tabLock.js");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");

const originals = {
  [LOCK]: fs.readFileSync(LOCK, "utf8"),
  [PANEL]: fs.readFileSync(PANEL, "utf8"),
};

// ⚠️ 锚点的换行符必须按目标文件归一化（方法论记着这条：锚点 count==0 →
// 变异没注入 → 套件全绿 → 被误读成「断言瞎」）。实测本仓库的 .vue 与
// src/*.js 都是 LF，但每轮仍按文件实测，不写死。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  // ── 判据本身（src/tabLock.js）────────────────────────────────────
  {
    target: LOCK,
    name: "follow 恒为 false（= 修复前的行为：跳后台标签页但面板不跟过去）",
    from: "  const follow = targetTabId !== activeTabId;",
    to: "  const follow = false;",
  },
  {
    target: LOCK,
    name: "follow 恒为 true（连活动标签页也乱切）",
    from: "  const follow = targetTabId !== activeTabId;",
    to: "  const follow = true;",
  },
  {
    target: LOCK,
    name: "follow 反了（该跟的不跟，不该跟的跟）",
    from: "  const follow = targetTabId !== activeTabId;",
    to: "  const follow = targetTabId === activeTabId;",
  },
  {
    target: LOCK,
    name: "删掉 follow 字段（调用方拿到 undefined → 永不跟随）",
    from: "  const follow = targetTabId !== activeTabId;",
    to: "  const follow = undefined;",
  },
  {
    target: LOCK,
    name: "same 分支不再跟随（已在锁定位置的后台标签页切不过去）",
    from: "    return { kind: LOCK_JUMP_SAME, path: lockedPath, follow };",
    to: "    return { kind: LOCK_JUMP_SAME, path: lockedPath, follow: false };",
  },

  // ── 调用点（src/components/FilePanel.vue）────────────────────────
  {
    target: PANEL,
    name: "调用点：跳回后不切活动标签页（把 follow 判定丢掉 = 原 bug）",
    from: "  setPath(tab, plan.path);\n  if (plan.follow) switchTab(id);",
    to: "  setPath(tab, plan.path);",
  },
  {
    target: PANEL,
    name: "调用点：跟随时切错标签页（跳到第一个 tab 而不是被右击的那个）",
    // ⚠️ 原先这里是「永远切活动标签页」（`if (plan.follow) switchTab(id)` →
    // `switchTab(id)`），实测 0 FAIL —— 但那是**等价变异**：目标就是活动页时
    // `switchTab(id)` 与 `if (plan.follow) switchTab(id)` 行为完全相同
    // （赋同值不触发 Vue 的 ref 更新）。方法论：0 FAIL 先判「等价变异」还是
    // 「测试盲区」，别硬凑断言去制造 FAIL → 换成下面这个真盲点。
    from: "  setPath(tab, plan.path);\n  if (plan.follow) switchTab(id);",
    to: "  setPath(tab, plan.path);\n  if (plan.follow) switchTab(tabs.value[0].id);",
  },
  {
    target: PANEL,
    name: "调用点：same 分支忘了跟随（后台标签页已在锁定位置时切不过去）",
    from: "    if (plan.follow) switchTab(id);\n    return { ok: false, reason: \"same\" };",
    to: "    return { ok: false, reason: \"same\" };",
  },
  {
    target: PANEL,
    name: "调用点：不调生产判据，自己看 lockedPath（判据分叉）",
    from: "  const plan = planLockedJump({\n    tab,\n    targetTabId: id,\n    activeTabId: activeTabId.value,\n  });",
    to: "  const plan = {\n    kind: tab && tab.lockedPath ? (tab.lockedPath === tab.path ? \"same\" : \"ok\") : \"unlocked\",\n    path: tab ? tab.lockedPath : \"\",\n    follow: false,\n  };",
  },
  {
    target: PANEL,
    name: "调用点：跳回时把目标目录搞错（跳到当前目录而不是锁定位置）",
    from: "  setPath(tab, plan.path);",
    to: "  setPath(tab, tab.path);",
  },

  // ── switchTab 的守卫（跳回锁定位置会调它）────────────────────────
  {
    target: PANEL,
    name: "调用点：switchTab 不校验 id（坏 id 会让面板像卡死）",
    from: "  if (!tabs.value.some((t) => t.id === id)) return false;",
    to: "  // 守卫被删掉了",
  },
  {
    target: PANEL,
    name: "调用点：switchTab 不清 pendingSelectName（待选名会落到别的 tab 的同名行）",
    from: "  if (activeTabId.value !== id) pendingSelectName.value = null;",
    to: "  // 不清了",
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = originals[m.target];
  const from = m.target === PANEL ? nlFor(m.target, m.from) : m.from;
  const to = m.target === PANEL ? nlFor(m.target, m.to) : m.to;

  const parts = before.split(from);
  console.log(`\n▶ ${m.name}`);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
    missed += 1;
    continue;
  }
  const mutated = parts.join(to);
  if (mutated === before) {
    console.log("  FAIL 变异产生了同样的内容 —— 变异无效");
    missed += 1;
    continue;
  }

  fs.writeFileSync(m.target, mutated, "utf8");
  let failed = false;
  let tail = "";
  try {
    const out = execFileSync(process.execPath, [SUITE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    tail = (out.match(/^通过 \d+ \/ \d+/m) || [""])[0];
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = (out.match(/^通过 \d+ \/ \d+/m) || [""])[0] || "threw";
    const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
    if (firstFail) tail += " | " + firstFail.trim();
  } finally {
    fs.writeFileSync(m.target, before, "utf8");
  }

  if (failed) {
    caught += 1;
    console.log(`  ok    caught: ${m.name}  (${tail})`);
  } else {
    missed += 1;
    console.log(`  FAIL  NOT CAUGHT: ${m.name}  (${tail})`);
  }
}

// 源文件必须逐字节还原。
console.log("");
let dirty = false;
for (const [file, src] of Object.entries(originals)) {
  const now = fs.readFileSync(file, "utf8");
  const same = now === src;
  console.log(`  source restored: ${path.basename(file)} = ${same}`);
  if (!same) {
    fs.writeFileSync(file, src, "utf8");
    dirty = true;
    console.log("    rewrote original");
  }
}
if (dirty) process.exit(1);

console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0) process.exit(1);
