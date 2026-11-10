// 变异测试：确认 panel-focus-style-check.mjs 的断言真能抓到
// 「看不出焦点在左栏还是右栏」的退化实现。
//
// 这个 bug 的失效是**纯视觉**的：没有报错、没有异常，测试全绿和 bug 还在
// 可以同时成立。所以判据必须落到**用户能不能分辨**（ΔE / 对比度）上，
// 而不是「CSS 里有没有某条规则」。这里每个变异都必须让套件 FAIL；
// 漏掉一个即视为断言没有分辨力。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的修复一起回滚）。
//
// Run: node scripts/panel-focus-style-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "panel-focus-style-check.mjs");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");
const PATHBAR = path.join(ROOT, "src", "components", "PathBar.vue");
const STYLE = path.join(ROOT, "src", "style.css");

const originals = {
  [PANEL]: fs.readFileSync(PANEL, "utf8"),
  [PATHBAR]: fs.readFileSync(PATHBAR, "utf8"),
  [STYLE]: fs.readFileSync(STYLE, "utf8"),
};

// ⚠️ 锚点的换行符必须按目标文件归一化（方法论记着这条：锚点 count==0 →
// 变异没注入 → 套件全绿 → 被误读成「断言瞎」）。实测本仓库 .vue 是 LF、
// .css 是 CRLF。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  // ── 通道①：描边没了 ─────────────────────────────────────────────
  {
    target: PANEL,
    name: "焦点栏不再描边（退回只剩 1px 边框 —— 旧实现就是这样的）",
    from: `  outline: 1px solid var(--accent);
  outline-offset: -1px;`,
    to: `  outline-offset: -1px;`,
  },
  {
    target: PANEL,
    name: "描边画到边框外侧（offset: 0 → 会被 wrapper 的 overflow:hidden 裁掉）",
    from: `  outline-offset: -1px;`,
    to: `  outline-offset: 0;`,
  },

  // ── 通道②：底色不染了 ───────────────────────────────────────────
  {
    target: PANEL,
    name: "焦点栏底色退回 --panel-bg（等于没染色）",
    from: `  border-color: var(--accent);
  background: var(--panel-active-bg);`,
    to: `  border-color: var(--accent);
  background: var(--panel-bg);`,
  },
  {
    target: STYLE,
    name: "graphite 的焦点栏底色染色浓度降到 1%（ΔE 太小，等于没染）",
    from: `  --panel-active-bg: color-mix(in srgb, var(--accent) 12%, var(--panel-bg));
  --panel-active-header-bg: color-mix(in srgb, var(--accent) 22%, var(--header-bg));`,
    to: `  --panel-active-bg: color-mix(in srgb, var(--accent) 1%, var(--panel-bg));
  --panel-active-header-bg: color-mix(in srgb, var(--accent) 22%, var(--header-bg));`,
  },
  {
    target: STYLE,
    name: "latte 的焦点栏底色完全不染色（浅色主题最容易糊）",
    from: `  --panel-active-bg: color-mix(in srgb, var(--accent) 14%, var(--panel-bg));
  --panel-active-header-bg: color-mix(in srgb, var(--accent) 30%, var(--header-bg));`,
    to: `  --panel-active-bg: var(--panel-bg);
  --panel-active-header-bg: color-mix(in srgb, var(--accent) 30%, var(--header-bg));`,
  },

  // ── 通道③：路径栏不亮了 ─────────────────────────────────────────
  {
    target: PANEL,
    name: "焦点栏的路径栏规则被删掉（少一条通道）",
    from: `/* 焦点栏的路径栏：染成强调色底 + 实线强调色下边。 */
.file-panel.active :deep(.path-bar) {
  background: var(--panel-active-header-bg);
  border-bottom-color: var(--accent);
}
`,
    to: ``,
  },
  {
    target: PANEL,
    name: "焦点栏的面包屑不染色（路径栏只剩按钮之间的缝发亮，等于没信号）",
    from: `/* 面包屑自己带底色（--bg），所以得单独染 —— 否则整条路径栏只有按钮
   之间的几条缝发亮，等于没信号。搜索结果页那个占位框同理。 */
.file-panel.active :deep(.breadcrumb),
.file-panel.active :deep(.virtual-display) {
  background: var(--panel-active-header-bg);
  border-color: var(--accent);
}
`,
    to: ``,
  },
  {
    target: STYLE,
    name: "latte 的路径栏染色退回原底色",
    from: `  --panel-active-header-bg: color-mix(in srgb, var(--accent) 30%, var(--header-bg));`,
    to: `  --panel-active-header-bg: var(--header-bg);`,
  },

  // ── 边框通道被改坏 ───────────────────────────────────────────────
  {
    target: PANEL,
    name: "焦点栏边框不用强调色（退回普通边框色）",
    from: `  border-color: var(--accent);
  background: var(--panel-active-bg);`,
    to: `  border-color: var(--border);
  background: var(--panel-active-bg);`,
  },
  {
    target: STYLE,
    name: "非焦点栏边框也用强调色（两栏看着都像焦点）",
    from: `  --panel-active-header-bg: color-mix(in srgb, var(--accent) 26%, var(--header-bg));
  --panel-idle-border: color-mix(in srgb, var(--border) 55%, var(--bg));
  --header-bg: #0d1117;`,
    to: `  --panel-active-header-bg: color-mix(in srgb, var(--accent) 26%, var(--header-bg));
  --panel-idle-border: var(--accent);
  --header-bg: #0d1117;`,
  },

  // ── scoped 编译陷阱：漏写 :deep() ──────────────────────────────
  // 这是本轮最隐蔽的一类退化：源码里选择器看着对，但 Vue scoped 编译后
  // 末段带上了 FilePanel 的 scope id，而 .path-bar / .breadcrumb 住在
  // 子组件 PathBar.vue 里、身上带的是 PathBar 的 scope id —— 永不命中。
  // 上面第 3 节的源码级断言察觉不到（它们读的是源码里的 :deep(...)）。
  {
    target: PANEL,
    name: "焦点栏路径栏规则漏写 :deep()（scoped 编译后打不中子组件）",
    from: `.file-panel.active :deep(.path-bar) {`,
    to: `.file-panel.active .path-bar {`,
  },
  {
    target: PANEL,
    name: "焦点栏面包屑规则漏写 :deep()（scoped 编译后打不中子组件）",
    from: `.file-panel.active :deep(.breadcrumb),`,
    to: `.file-panel.active .breadcrumb,`,
  },

  // ── 跨文件契约：:deep() 的落点被改名 ───────────────────────────
  // PathBar 重构时把根节点的 class 改了，FilePanel 的 :deep(.path-bar)
  // 立刻落空 —— 编译得过、不报错、源码级断言全绿，但焦点栏路径栏不再染色。
  // 这条只有「读 PathBar 模板核对类名」的断言能抓到。
  {
    target: PATHBAR,
    name: "PathBar 根节点的 class 被改名（FilePanel 的 :deep(.path-bar) 落空）",
    from: `  <div class="path-bar">`,
    to: `  <div class="path-bar-v2">`,
  },
  {
    target: PATHBAR,
    name: "PathBar 的面包屑 class 被改名（FilePanel 的 :deep(.breadcrumb) 落空）",
    from: `        class="breadcrumb"`,
    to: `        class="breadcrumb-v2"`,
  },

  // ── 特异性 / !important 把焦点染色抢回去 ───────────────────────
  // 父组件规则是 `.file-panel.active[data-v-x] .path-bar`（spec 400），
  // 子组件自身是 `.path-bar[data-v-y]`（spec 200）。子组件一旦把底色
  // 加上 !important —— 或者用更具体的选择器 —— 焦点栏的染色就被盖掉。
  {
    target: PATHBAR,
    name: "PathBar 给路径栏底色加 !important（无视特异性抢回焦点染色）",
    from: `.path-bar {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 4px;
  background: var(--header-bg);`,
    to: `.path-bar {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 4px;
  background: var(--header-bg) !important;`,
  },
  {
    target: PATHBAR,
    name: "PathBar 给面包屑底色加 !important（无视特异性抢回焦点染色）",
    from: `  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-family: "Consolas", "Cascadia Code", monospace;`,
    to: `  background: var(--bg) !important;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-family: "Consolas", "Cascadia Code", monospace;`,
  },
  {
    target: PATHBAR,
    name: "PathBar 用更具体的选择器压过父组件（焦点栏路径栏染色被盖掉）",
    from: `.path-bar {`,
    to: `.path-bar.path-bar.path-bar {`,
  },

  // ── 焦点栏专属：丢了 .active 锚点 ──────────────────────────────
  // 少了 .active，这条规则就同时命中两栏 —— 焦点信号直接失效，
  // 而且源码级断言（只看「有没有这条规则、声明对不对」）察觉不到。
  {
    target: PANEL,
    name: "焦点栏路径栏规则丢了 .active（两栏路径栏都染色 = 没有焦点信号）",
    from: `.file-panel.active :deep(.path-bar) {`,
    to: `.file-panel :deep(.path-bar) {`,
  },
  {
    target: PANEL,
    name: "焦点栏面包屑规则丢了 .active（两栏面包屑都染色 = 没有焦点信号）",
    from: `.file-panel.active :deep(.breadcrumb),`,
    to: `.file-panel :deep(.breadcrumb),`,
  },
  {
    target: PANEL,
    name: "非焦点栏整体压暗（另一栏的字会看不清 —— 不能拿可读性换）",
    from: `.file-panel:not(.active) {
  border-color: var(--panel-idle-border);
  background: var(--panel-bg);
}`,
    to: `.file-panel:not(.active) {
  border-color: var(--panel-idle-border);
  background: var(--panel-bg);
  opacity: 0.45;
}`,
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
    if (firstFail) tail += ` | ${firstFail.trim()}`;
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
