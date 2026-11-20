// 变异测试：确认 image-rotate-check.mjs 的断言真能抓到退化实现。
// 直接 `node scripts/image-rotate-mutation.mjs` 跑。
//
// 每个变异都必须让套件 FAIL；漏掉一个即视为断言没有分辨力。
// 还原只用内存原文写回（绝不 git checkout —— checkout 会把本轮未提交的
// 改动一起回滚，见 METHODOLOGY.md）。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = path.join(ROOT, "scripts", "image-rotate-check.mjs");
const ROTATE = path.join(ROOT, "src", "imageRotate.js");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");
const SHORTCUTS = path.join(ROOT, "src", "shortcuts.js");

const originals = {
  [ROTATE]: fs.readFileSync(ROTATE, "utf8"),
  [PREVIEW]: fs.readFileSync(PREVIEW, "utf8"),
  [SHORTCUTS]: fs.readFileSync(SHORTCUTS, "utf8"),
};

const MUTANTS = [
  {
    target: ROTATE,
    name: "① 角度不归一（转满一圈变成 360°，CSS 里等于 0 但标签会显示错）",
    from: "  const snapped = Math.round(n / ROTATE_STEP) * ROTATE_STEP;\n  return ((snapped % 360) + 360) % 360;",
    to: "  return n;",
  },
  {
    target: ROTATE,
    name: "② 步进方向反了（右转变左转）",
    from: "  return normalizeRotation(c + (d > 0 ? ROTATE_STEP : -ROTATE_STEP));",
    to: "  return normalizeRotation(c - (d > 0 ? ROTATE_STEP : -ROTATE_STEP));",
  },
  {
    target: ROTATE,
    name: "③ 90° 不换宽高（横图转完还是横的 → 溢出面板）",
    from: "  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };",
    to: "  return { w, h };",
  },
  {
    target: ROTATE,
    name: "④ 180° 也换宽高（上下颠倒被当成了转 90°）",
    from: "  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };",
    to: "  return r === 90 || r === 180 || r === 270 ? { w: h, h: w } : { w, h };",
  },
  {
    target: ROTATE,
    name: "⑤ 旋转点的方向反了（顺时针变逆时针）",
    from: "    case 90:\n      return { x: -y, y: x };",
    to: "    case 90:\n      return { x: y, y: -x };",
  },
  {
    target: ROTATE,
    name: "⑥ 角度标签不把 270° 写成 -90°",
    from: "  return `${r === 270 ? -90 : r}°`;",
    to: "  return `${r}°`;",
  },
  {
    target: ROTATE,
    name: "⑦ NaN 不守卫（NaN 顺着样式流到 DOM → 图片不显示）",
    from: "  if (!Number.isFinite(n)) return 0;",
    to: "",
  },
  {
    target: PREVIEW,
    name: "⑧ 画面本体的 transform 不写角度（按钮点了但画面不转）",
    from: "    transform: `translate(-50%, -50%) rotate(${rotation.value}deg)`,",
    to: "    transform: `translate(-50%, -50%)`,",
  },
  {
    target: PREVIEW,
    name: "⑨ 画面本体按旋转后的占位给尺寸（画面被拉伸变形）",
    from: "    width: `${g.pw}px`,\n    height: `${g.ph}px`,",
    to: "    width: `${g.w}px`,\n    height: `${g.h}px`,",
  },
  {
    target: PREVIEW,
    name: "⑩ 几何里不换算占位（旋转后滚动范围/居中偏移按未旋转的算）",
    from: "  const foot = rotatedSize(pw, ph, rotation.value);",
    to: "  const foot = { w: pw, h: ph };",
  },
  {
    target: PREVIEW,
    name: "⑪ 适应窗口按未旋转的尺寸算（横图转 90° 后溢出面板）",
    from: "  computeFitScale(rotatedNatural.value.w, rotatedNatural.value.h, viewSize.value.w, viewSize.value.h)",
    to: "  computeFitScale(naturalSize.value.w, naturalSize.value.h, viewSize.value.w, viewSize.value.h)",
  },
  {
    target: PREVIEW,
    name: "⑫ 旋转不走生产 rotateStep（自己 +90 硬编码，270° 的语义丢了）",
    from: "  rotation.value = rotateStep(rotation.value, dir);",
    to: "  rotation.value = (rotation.value + 90) % 360;",
  },
  {
    target: PREVIEW,
    name: "⑬ 左转传 +1（左右转反了）",
    from: "  rotateBy(-1);",
    to: "  rotateBy(1);",
  },
  {
    target: PREVIEW,
    name: "⑭ 换文件时不重置旋转（上一张图的角度留给下一张）",
    from: "  resetRotation();",
    to: "  /* 不重置 */",
  },
  {
    target: PREVIEW,
    name: "⑮ 旋转时不结束拖动（手势与状态变更并行 → 画面乱跳）",
    from: "  rotation.value = rotateStep(rotation.value, dir);\n  // 画面占位变了，旧的滚动位置不再对应同一块内容 → 从头看起。\n  endImageDrag();",
    to: "  rotation.value = rotateStep(rotation.value, dir);\n  // 画面占位变了，旧的滚动位置不再对应同一块内容 → 从头看起。",
  },
  {
    target: PREVIEW,
    name: "⑯ 旋转按钮对所有预览类型都显示（文本预览里也能点）",
    from: 'v-if="previewType === \'image\' && naturalSize.w > 0"',
    to: 'v-if="naturalSize.w > 0"',
  },
  {
    target: PREVIEW,
    name: "⑰ 组件不再认领 image.rotateRight（快捷键配了但没接线）",
    from: '  if (matches("image.rotateRight", e)) {',
    to: '  if (matches("image.rotateRightXX", e)) {',
  },
  {
    target: PREVIEW,
    name: "⑱ 旋转顺手写了盘（需求说不用保存，这里必须抓）",
    from: "  rotation.value = rotateStep(rotation.value, dir);",
    to: "  rotation.value = rotateStep(rotation.value, dir);\n  invoke(\"save_image\", { rotated: rotation.value });",
  },
  {
    target: SHORTCUTS,
    name: "⑲ 快捷键没登记进 COMMANDS（组件认领了一个不存在的命令）",
    from: '  { id: "image.rotateLeft", scope: "image"',
    to: '  { id: "image.rotateLeftXX", scope: "image"',
  },
  {
    target: SHORTCUTS,
    name: "⑳ 快捷键写成物理键名 Ctrl+Arrowleft（永远匹配不上，且不报错）",
    from: 'defaults: ["Ctrl+ArrowLeft"] },',
    to: 'defaults: ["Ctrl+Arrowleft"] },',
  },
  {
    target: SHORTCUTS,
    name: "㉑ 快捷键改成裸方向键（抢走文件列表的上下移动）",
    from: 'defaults: ["Ctrl+ArrowLeft"] },',
    to: 'defaults: ["ArrowLeft"] },',
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
