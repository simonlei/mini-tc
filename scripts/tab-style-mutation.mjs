// 变异测试：确认 tab-style-check.mjs 的断言真能抓到「当前页与锁定页分不清」的退化实现。
//
// 这个 bug 的失效是**纯视觉**的：没有报错、没有异常，测试全绿和 bug 还在可以同时成立。
// 所以判据必须落到**用户能不能分辨**（ΔE / 对比度）上，而不是「CSS 里有没有某条规则」。
// 这里每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的修复一起回滚）。
//
// Run: node scripts/tab-style-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "tab-style-check.mjs");
const TABBAR = path.join(ROOT, "src", "components", "TabBar.vue");
const STYLE = path.join(ROOT, "src", "style.css");

const originals = {
  [TABBAR]: fs.readFileSync(TABBAR, "utf8"),
  [STYLE]: fs.readFileSync(STYLE, "utf8"),
};

// ⚠️ 锚点的换行符必须按目标文件归一化（方法论记着这条：锚点 count==0 →
// 变异没注入 → 套件全绿 → 被误读成「断言瞎」）。实测本仓库 .vue 与 .css 都是 CRLF。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  // ── 根因①：锁定态又染上底色（= 修复前的写法）────────────────────
  {
    target: TABBAR,
    name: "锁定态重新染底色（旧写法：color-mix 70%+12%，α=0.82）",
    from: `.tab-lock {
  font-size: 10px;`,
    to: `.tab.locked {
  background: color-mix(in srgb, var(--tab-active) 70%, var(--accent) 12%);
}

.tab-lock {
  font-size: 10px;`,
  },
  {
    target: TABBAR,
    name: "锁定态染底色，但浓度很低（ΔE 仍然不够 —— 光看「有没有染」不够）",
    from: `.tab-lock {
  font-size: 10px;`,
    to: `.tab.locked {
  background: color-mix(in srgb, var(--tab-active) 96%, var(--accent) 2%);
}

.tab-lock {
  font-size: 10px;`,
  },
  {
    target: TABBAR,
    name: "锁定态加回虚线下边框（用户明确要求：只留锁标志）",
    from: `.tab-lock {
  font-size: 10px;`,
    to: `.tab.locked:not(.active) {
  border-bottom: 2px dashed var(--text-dim);
}

.tab-lock {
  font-size: 10px;`,
  },

  // ── 锁定信号本身被改坏 ───────────────────────────────────────────
  {
    target: TABBAR,
    name: "锁图标不再是 🔒（锁定状态就完全没了信号）",
    from: `<span v-if="tab.lockedPath" class="tab-lock" title="已锁定">🔒</span>`,
    to: `<span v-if="tab.lockedPath" class="tab-lock" title="已锁定">★</span>`,
  },
  {
    target: TABBAR,
    name: "锁图标被 active 状态藏起来（当前页看不出锁着）",
    from: `<span v-if="tab.lockedPath" class="tab-lock" title="已锁定">🔒</span>`,
    to: `<span v-if="tab.lockedPath && tab.id !== activeTabId" class="tab-lock" title="已锁定">🔒</span>`,
  },
  {
    // 自引用陷阱：断言原本读原始模板文本，注释里写一句就能骗过它。
    target: TABBAR,
    name: "把锁图标藏起来、却在注释里写上断言文本（自引用骗过断言）",
    from: `<span v-if="tab.lockedPath" class="tab-lock" title="已锁定">🔒</span>`,
    to: `<!-- <span v-if="tab.lockedPath" class="tab-lock" title="已锁定">🔒</span> -->
      <span v-if="tab.lockedPath && tab.id !== activeTabId" class="tab-lock" title="已锁定">🔒</span>`,
  },

  // ── 当前页的高亮被削弱 ────────────────────────────────────────
  {
    target: STYLE,
    name: "当前页底色退回中性灰（--tab-active 不再跟随强调色）",
    from: "  --tab-active: color-mix(in srgb, var(--accent) 30%, var(--tab-bg));",
    to: "  --tab-active: #2a2a30;",
  },
  {
    target: STYLE,
    name: "当前页底色的强调色浓度降到 3%（ΔE 太小，等于没高亮）",
    from: "  --tab-active: color-mix(in srgb, var(--accent) 30%, var(--tab-bg));",
    to: "  --tab-active: color-mix(in srgb, var(--accent) 3%, var(--tab-bg));",
  },
  {
    target: TABBAR,
    name: "当前页不再用强调色实线底边（两个状态少了区分通道）",
    from: `  background: var(--tab-active);
  border-bottom: 2px solid var(--accent);
}`,
    to: `  background: var(--tab-active);
  border-bottom: 2px solid transparent;
}`,
  },
  {
    target: TABBAR,
    name: "当前页标题不再加粗（浅色主题下少一重信号）",
    from: `.tab.active .tab-name {
  font-weight: 600;
}`,
    to: `.tab.active .tab-name {
  font-weight: 400;
}`,
  },

  // ── 布局：标签没预留底边宽度（切换当前页时文字抖 1px）─────────
  {
    target: TABBAR,
    name: "标签不再预留统一宽度的透明底边（切换时文字位置会跳）",
    from: `  border-bottom: 2px solid transparent;
  background: var(--tab-bg);`,
    to: `  background: var(--tab-bg);`,
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = originals[m.target];
  const from = nlFor(m.target, m.from);
  const to = nlFor(m.target, m.to);

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
