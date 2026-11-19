// 变异测试：确认 image-drag-check.mjs 的断言真能抓到退化实现。
// 直接 `node scripts/image-drag-mutation.mjs` 跑。
//
// 每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
// 还原只用内存原文写回（绝不 git checkout —— checkout 会把本轮未提交的
// 改动一起回滚，见 METHODOLOGY.md）。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "image-drag-check.mjs");
const DRAG = path.join(ROOT, "src", "imageDrag.js");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");

const originals = {
  [DRAG]: fs.readFileSync(DRAG, "utf8"),
  [PREVIEW]: fs.readFileSync(PREVIEW, "utf8"),
};

// ⚠️ 方法论：.vue 与 .js 的换行符可能不同，锚点要按目标文件归一化，
// 否则 count == 0 → 变异没注入 → 套件全绿被误读成「断言瞎」。
const nlFor = (file, s) =>
  fs.readFileSync(file, "utf8").includes("\r\n") ? s.replace(/\n/g, "\r\n") : s;

const MUTANTS = [
  {
    target: DRAG,
    name: "① 阈值判定反了（动一下就算在拖）",
    from: "  return Math.hypot(x, y) >= t;",
    to: "  return Math.hypot(x, y) > 0;",
  },
  {
    target: DRAG,
    name: "② 阈值判定恒为 false（永远不开始拖）",
    from: "  return Math.hypot(x, y) >= t;",
    to: "  return false;",
  },
  {
    target: DRAG,
    name: "③ 位移换算符号反了（图片往反方向走）",
    from: "    left: sl - (cx - sx),\n    top: st - (cy - sy),",
    to: "    left: sl + (cx - sx),\n    top: st + (cy - sy);",
  },
  {
    target: DRAG,
    name: "④ 位移换算用起点减当前（方向反）",
    from: "    left: sl - (cx - sx),\n    top: st - (cy - sy),",
    to: "    left: sl - (sx - cx),\n    top: st - (sy - cy),",
  },
  {
    target: DRAG,
    name: "⑤ 位移换算忽略纵向（只能左右拖）",
    from: "    top: st - (cy - sy),",
    to: "    top: st,",
  },
  {
    target: DRAG,
    name: "⑥ 位移换算忽略横向（只能上下拖）",
    from: "    left: sl - (cx - sx),",
    to: "    left: sl,",
  },
  {
    target: DRAG,
    name: "⑦ canDrag 反了（没溢出时判定为可拖）",
    from: "  return cw > vw || ch > vh;",
    to: "  return cw <= vw && ch <= vh;",
  },
  {
    target: DRAG,
    name: "⑧ canDrag 只看横向（长图纵向溢出也判成不可拖）",
    from: "  return cw > vw || ch > vh;",
    to: "  return cw > vw;",
  },
  {
    target: DRAG,
    name: "⑨ canDrag 在可视区尺寸未知时判定为可拖",
    from: "  if (vw <= 0 || vh <= 0) return false;",
    to: "",
  },
  {
    target: DRAG,
    name: "⑩ dragStarted 逐轴比较（斜拖判成没拖）",
    from: "  return Math.hypot(x, y) >= t;",
    to: "  return Math.abs(x) >= t || Math.abs(y) >= t;",
  },
  {
    target: PREVIEW,
    name: "⑪ 模板摘掉 @pointerdown（手势根本没接上）",
    from: nlFor(PREVIEW, '        @pointerdown="onImagePointerDown"\n'),
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑫ 组件改成自己写阈值（不再调用生产 dragStarted）",
    from: nlFor(PREVIEW, "    if (!dragStarted(dx, dy, IMAGE_DRAG_START_THRESHOLD)) return;"),
    to: nlFor(PREVIEW, "    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;"),
  },
  {
    target: PREVIEW,
    name: "⑬ 组件改成自己算位移（不再调用生产 dragScroll）",
    from: nlFor(PREVIEW, "  const next = dragScroll({"),
    to: nlFor(PREVIEW, "  const next = { left: drag.startLeft + (e.clientX - drag.startX), top: drag.startTop + (e.clientY - drag.startY) };\n  if (false) dragScroll({"),
  },
  {
    target: PREVIEW,
    name: "⑭ 非主键也接管手势（右键菜单被吃掉）",
    from: nlFor(PREVIEW, "  if (e.button !== 0) return;"),
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑮ 拖不动时也接管手势（适应窗口下点击被吞）",
    from: nlFor(PREVIEW, "  if (!canDragImage.value) return;"),
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑯ 缩放前不结束拖动（手势与缩放打架）",
    from: nlFor(PREVIEW, "  endImageDrag();\n  const before = media.getBoundingClientRect();"),
    to: nlFor(PREVIEW, "  const before = media.getBoundingClientRect();"),
  },
  {
    target: PREVIEW,
    name: "⑰ 卸载时不结束拖动（window 监听器泄漏）",
    from: nlFor(PREVIEW, "  // Same for the drag listeners: a drag in flight at unmount would keep\n  // listeners on window pointing at a dead component.\n  endImageDrag();\n"),
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑱ 不移除 pointermove 监听（泄漏）",
    from: nlFor(PREVIEW, '  window.removeEventListener("pointermove", onImagePointerMove);\n'),
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑲ 不禁原生图片拖拽（原生 drag 会抢走 pointermove）",
    from: nlFor(PREVIEW, "  -webkit-user-drag: none;\n"),
    to: "",
  },
];

let caught = 0;
let missed = 0;

for (const mu of MUTANTS) {
  const original = fs.readFileSync(mu.target, "utf8");
  const count = original.split(mu.from).length - 1;
  console.log(`\n▶ ${mu.name}`);
  console.log(`  anchor found: ${count}`);
  if (count !== 1) {
    console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
    missed++;
    continue;
  }

  fs.writeFileSync(mu.target, original.split(mu.from).join(mu.to), "utf8");
  let failedNow = 0;
  let out = "";
  try {
    execFileSync(process.execPath, [SUITE], { encoding: "utf8" });
  } catch (e) {
    failedNow = 1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  fs.writeFileSync(mu.target, original, "utf8");

  if (failedNow) {
    caught++;
    const firstFail = out.split("\n").find((l) => l.includes("FAIL")) || "";
    console.log(`  ok   caught  (失败 1 项：)${firstFail ? " | " + firstFail.trim() : ""}`);
  } else {
    missed++;
    console.log("  FAIL 变异未被断言抓到 —— 该断言是恒真的");
  }
}

// 还原（防御性：万一上面某步抛异常）
fs.writeFileSync(DRAG, originals[DRAG], "utf8");
fs.writeFileSync(PREVIEW, originals[PREVIEW], "utf8");

console.log(`\n${caught} caught / ${missed} missed`);
if (missed) process.exit(1);
