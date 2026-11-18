// 变异测试：确认 image-zoom-check.mjs 的断言真能抓到退化实现。
// 直接 `node scripts/image-zoom-mutation.mjs` 跑。
//
// 每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
// 还原只用内存原文写回（绝不 git checkout —— checkout 会把本轮未提交的
// 改动一起回滚，见 METHODOLOGY.md）。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "image-zoom-check.mjs");
const ZOOM = path.join(ROOT, "src", "imageZoom.js");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");
const SHORTCUTS = path.join(ROOT, "src", "shortcuts.js");

const originals = {
  [ZOOM]: fs.readFileSync(ZOOM, "utf8"),
  [PREVIEW]: fs.readFileSync(PREVIEW, "utf8"),
  [SHORTCUTS]: fs.readFileSync(SHORTCUTS, "utf8"),
};

const MUTANTS = [
  {
    target: ZOOM,
    name: "① fitScale 不封顶 1（小图被放大，超过原始大小）",
    from: "  const s = Math.min(availW / natW, availH / natH);\n  return s > 1 ? 1 : s;",
    to: "  return Math.min(availW / natW, availH / natH);",
  },
  {
    target: ZOOM,
    name: "② clampScale 漏掉 NaN 守卫（NaN 直接穿透）",
    from: "  if (Number.isNaN(scale)) return lo;",
    to: "",
  },
  {
    target: ZOOM,
    name: "③ clampScale 忽略 min（缩到适应窗口以下）",
    from: "  return Math.max(lo, Math.min(hi, scale));",
    to: "  return Math.min(hi, scale);",
  },
  {
    target: ZOOM,
    name: "④ zoomStep 方向反了（＋变成缩小）",
    from: "  if (dir > 0) {\n    for (const r of ZOOM_RUNGS) if (r > scale + 1e-9) return r;\n    return MAX_SCALE;\n  }",
    to: "  if (dir > 0) {\n    for (const r of ZOOM_RUNGS) if (r < scale - 1e-9) return r;\n    return MAX_SCALE;\n  }",
  },
  {
    target: ZOOM,
    name: "④b 缩小到底不回适应窗口（缩到比整图可见还小）",
    from: "  return fit;\n}",
    to: "  return 0.01;\n}",
  },
  {
    target: ZOOM,
    name: "⑤ wheelScale 的符号反了（向上滚变成缩小）",
    from: "  const factor = Math.pow(1.1, -deltaY / 100);",
    to: "  const factor = Math.pow(1.1, deltaY / 100);",
  },
  {
    target: ZOOM,
    name: "⑥ MAX_SCALE 放大到 200%（超过原始大小 = 插值糊）",
    from: "export const MAX_SCALE = 1;",
    to: "export const MAX_SCALE = 2;",
  },
  {
    target: ZOOM,
    name: "⑦ anchorScroll 不做补偿（缩放后内容跑掉）",
    from: "    out.left = scroll.left + after.left + f * after.width - cursor.x;",
    to: "    out.left = scroll.left;",
  },
  {
    target: ZOOM,
    name: "⑧ anchorScroll 补偿方向反了",
    from: "    out.left = scroll.left + after.left + f * after.width - cursor.x;",
    to: "    out.left = scroll.left - (after.left + f * after.width - cursor.x);",
  },
  {
    target: PREVIEW,
    name: "⑨ 适应窗口档不留 max-* 兜底（测量晚一帧就溢出）",
    from: "    maxWidth: fit ? \"100%\" : \"none\",",
    to: "    maxWidth: \"none\",",
  },
  {
    target: PREVIEW,
    name: "⑩ 放大档不解除 max-height:100%（长图被压回容器高度，缩放无效）",
    from: "    maxHeight: fit ? \"100%\" : \"none\",",
    to: "    maxHeight: \"100%\",",
  },
  {
    target: PREVIEW,
    name: "⑩b 居中改回 flex 的 margin:auto（溢出的那一侧滚不到）",
    from: "    marginLeft: `${mx}px`,\n    marginRight: `${mx}px`,",
    to: "    marginLeft: \"auto\",\n    marginRight: \"auto\",",
  },
  {
    target: PREVIEW,
    name: "⑩c 居中偏移算错（图片不居中）",
    from: "  const mx = Math.max(0, Math.floor((avail.w - w) / 2));",
    to: "  const mx = 0;",
  },
  {
    target: PREVIEW,
    name: "⑪ 滚动容器 overflow:auto 被改掉（放大后不能上下滚）",
    from: "  overflow: auto;\n  padding: 12px;",
    to: "  overflow: hidden;\n  padding: 12px;",
  },
  {
    target: PREVIEW,
    name: "⑪b 滚动容器改成 flex（溢出侧滚不到）",
    from: "  overflow: auto;\n  padding: 12px;",
    to: "  overflow: auto;\n  display: flex;\n  padding: 12px;",
  },
  {
    target: PREVIEW,
    name: "⑫ 换文件时不重置缩放（上一张图的比例留给下一张）",
    from: "  resetZoom();",
    to: "  /* 不重置 */",
  },
  {
    target: PREVIEW,
    name: "⑬ 普通滚轮也被劫持（图片放大后没法用滚轮上下翻）",
    from: "  if (!e.ctrlKey && !e.metaKey) return;",
    to: "  if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); return; }",
  },
  {
    target: SHORTCUTS,
    name: "⑭ 快捷键写成物理键名 Ctrl+Equal（永远匹配不上，且不报错）",
    from: 'defaults: ["Ctrl+="] },',
    to: 'defaults: ["Ctrl+Equal"] },',
  },
  {
    target: SHORTCUTS,
    name: "⑮ 快捷键没登记进 COMMANDS（组件认领了一个不存在的命令）",
    from: '  { id: "image.zoomIn", scope: "image"',
    to: '  { id: "image.zoomInXX", scope: "image"',
  },
  {
    target: SHORTCUTS,
    name: "⑯ SCOPES 里漏了 image（快捷键设置里看不到这组）",
    from: '  { key: "image", label: "图片预览", hint: "图片预览打开时生效" },\n',
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑰ 组件不再认领 image.zoomIn（快捷键配了但没接线）",
    from: '  if (matches("image.zoomIn", e)) {',
    to: '  if (matches("image.zoomInXX", e)) {',
  },
  {
    target: PREVIEW,
    name: "⑱ 文本预览也认领缩放键（按 Ctrl+= 会误伤非图片预览）",
    from: '  if (previewType.value !== "image") return;',
    to: "  // 不检查预览类型",
  },
];

let caught = 0;
let missed = 0;

for (const m of MUTANTS) {
  const before = originals[m.target];
  const parts = before.split(m.from);
  console.log(`\n▶ ${m.name}`);
  console.log(`  anchor found: ${parts.length - 1}`);
  if (parts.length !== 2) {
    console.log("  ⚠️ 锚点不是恰好 1 处，变异没注入（结果不可信）");
    missed++;
    continue;
  }
  const mutated = parts.join(m.to);
  if (mutated === before) {
    console.log("  ⚠️ 变异后内容没变");
    missed++;
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
    tail = out.trim().split("\n").slice(-1)[0] || "";
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ""}`;
    tail = out.trim().split("\n").filter((l) => /通过|失败/.test(l)).slice(-1)[0] || "threw";
  } finally {
    fs.writeFileSync(m.target, before, "utf8");
  }

  if (failed) {
    caught++;
    console.log(`  ok    caught  (${tail})`);
  } else {
    missed++;
    console.log(`  FAIL  NOT CAUGHT  (${tail})`);
  }
}

let restored = true;
for (const [file, original] of Object.entries(originals)) {
  if (fs.readFileSync(file, "utf8") !== original) {
    fs.writeFileSync(file, original, "utf8");
    restored = false;
  }
}
console.log(`\n  sources restored: ${restored}`);
console.log(`\n${caught} caught / ${missed} missed`);
if (missed > 0 || !restored) process.exit(1);
