// 变异测试：确认 tab-drag-check.mjs 的断言真能抓到「拖动排序没生效」的退化实现。
//
// 这个功能的失效是**静默**的：拖了一下，标签条纹丝不动 —— 没有报错、没有提示，
// 连内部状态都没变（因为压根没改）。所以「测试全绿」和「功能没做」可以同时成立。
// 这里每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
//
// 还原只用内存原文写回（绝不 git checkout —— 那样会把本轮刚做好的功能一起回滚）。
//
// Run: node scripts/tab-drag-mutation.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "tab-drag-check.mjs");
const DRAG = path.join(ROOT, "src", "tabDrag.js");
const TABBAR = path.join(ROOT, "src", "components", "TabBar.vue");
const PANEL = path.join(ROOT, "src", "components", "FilePanel.vue");

const originals = {
  [DRAG]: fs.readFileSync(DRAG, "utf8"),
  [TABBAR]: fs.readFileSync(TABBAR, "utf8"),
  [PANEL]: fs.readFileSync(PANEL, "utf8"),
};

// ⚠️ 锚点的换行符必须按目标文件归一化（方法论记着这条：锚点 count==0 →
// 变异没注入 → 套件全绿 → 被误读成「断言瞎」）。本仓库的文件换行并不统一
// （TabBar.vue 是 CRLF，FilePanel.vue 与 src/*.js 是 LF），所以每轮按文件实测。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  // ── 判据本身（src/tabDrag.js）────────────────────────────────────
  {
    target: DRAG,
    name: "落点判定：中线归左半边（<= mid）",
    from: "    if (pointerX < mid) return i;",
    to: "    if (pointerX <= mid) return i;",
  },
  {
    target: DRAG,
    name: "落点判定：忘了把被拖的那个从候选里排除",
    from: "  const others = list.filter((r) => r && r.id !== dragId);",
    to: "  const others = list;",
  },
  {
    target: DRAG,
    name: "落点判定：永远插到最前（指针位置被忽略）",
    from: "  return others.length;",
    to: "  return 0;",
  },
  {
    target: DRAG,
    name: "重排：忘了从 rest 里移除被拖的那个（结果多一个标签页）",
    from: "  const rest = list.filter((t) => t && t.id !== dragId);",
    to: "  const rest = list.slice();",
  },
  {
    target: DRAG,
    name: "重排：下标上界差一（插不到最末尾）",
    from: "Math.min(Math.trunc(n), rest.length)",
    to: "Math.min(Math.trunc(n), rest.length - 1)",
  },
  {
    target: DRAG,
    name: "重排：复制标签页而不是搬动它（路径/锁定锚点全丢）",
    from: "  rest.splice(idx, 0, list[from]);",
    to: "  rest.splice(idx, 0, { id: list[from].id, path: \"\" });",
  },

  // ── 交互（src/components/TabBar.vue）────────────────────────────
  {
    target: TABBAR,
    name: "交互：永远不进入拖动状态（阈值判断直接 return）",
    from: "    if (Math.abs(e.clientX - drag.startX) < TAB_DRAG_START_THRESHOLD) return;",
    to: "    return;",
  },
  {
    target: TABBAR,
    name: "交互：落点用的指针位置写死成 0（永远落在最前）",
    from: "    pointerX: e.clientX,",
    to: "    pointerX: 0,",
  },
  {
    target: TABBAR,
    name: "交互：松手时永远插到最前（落点下标被丢掉）",
    from: '  emit("reorder-tab", { tabId: d.id, toIndex });',
    to: '  emit("reorder-tab", { tabId: d.id, toIndex: 0 });',
  },
  {
    target: TABBAR,
    name: "交互：拖完之后的 click 不再抑制（顺带把标签页切了）",
    from: "  if (suppressClick) {\n    suppressClick = false;\n    return;\n  }",
    to: "  // 抑制标记被删掉了",
  },
  {
    target: TABBAR,
    name: "交互：插入指示线算错了标签页（指示线落错位置）",
    from: "  const others = props.tabs.filter((t) => t.id !== draggingId.value);",
    to: "  const others = props.tabs;",
  },

  // ── 落地点（src/components/FilePanel.vue）────────────────────────
  {
    target: PANEL,
    name: "落地点：落点下标偏移一位（插错地方）",
    from: "  const next = reorderTabs(before, tabId, toIndex);",
    to: "  const next = reorderTabs(before, tabId, toIndex + 1);",
  },
  {
    target: PANEL,
    name: "落地点：什么都不重排（reorderTab 直接返回）",
    from: "  if (sameTabOrder(before, next)) return false;",
    to: "  if (true) return false;",
  },
  {
    target: PANEL,
    name: "落地点：凭空多复制一个标签页",
    from: "  tabs.value.splice(0, tabs.value.length, ...next);",
    to: "  tabs.value.splice(0, tabs.value.length, ...next, next[next.length - 1]);",
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
