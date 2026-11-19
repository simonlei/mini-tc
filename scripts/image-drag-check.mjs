// 图片拖动平移的判据：纯函数表 + 静态接线断言 + 变异臂。
// 直接 `node scripts/image-drag-check.mjs` 跑。
// 变异臂：`node scripts/image-drag-mutation.mjs`（每个变异都应 FAIL）。
//
// ── 这个功能是什么 ────────────────────────────────────────────────────
// 图片放大到 1:1 之后，一屏572×7191 的长图在 360×620 的面板里横向溢出
// 212px、纵向溢出 6571px。滚动条能用，但长图上「按住图拖一下」才是看图
// 软件的标准手势 —— 触控板上更是同一套肌肉记忆。
//
// ── 三层断言 ───────────────────────────────────────────────────────
//   ① 纯逻辑：import 生产 src/imageDrag.js，跑真值表（阈值/位移/可拖判定）
//   ② 静态接线：组件真的用了这个模块，事件真的挂上了，拖动时会清掉原生拖拽
//   ③ 变异臂：每个变异都应 FAIL —— 确认断言有分辨力，不是恒真
//
// 判据的锚点是**生产代码本身**（import src/imageDrag.js），不是副本。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dragStarted,
  dragScroll,
  canDrag,
  IMAGE_DRAG_START_THRESHOLD,
} from "../src/imageDrag.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");
const src = stripComments(fs.readFileSync(PREVIEW, "utf8"));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    if (detail) for (const d of detail) console.log(`         ${d}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

// 切出某个函数的**函数体**（从声明处到配平结束的花括号）。
//
// ⚠️ 起点必须先跳过参数列表再找 `{` —— 默认参数里的花括号会让配平错位。
// 与 scripts/composition-focus-check.mjs 里同名的辅助函数一致。
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return "";
  const braceAt = src.indexOf("{", at + decl.length - 1);
  if (braceAt < 0) return "";
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceAt, i + 1);
    }
  }
  return "";
}

// 真实场景尺寸。
const LONG = { w: 572, h: 7191 };
const PANEL = { w: 360, h: 620 };
const PAD = 12;
const AVAIL = { w: PANEL.w - PAD * 2, h: PANEL.h - PAD * 2 };

section("1. dragStarted：阈值判定");

{
  check("阈值是正数", IMAGE_DRAG_START_THRESHOLD > 0);
  check("没移动 = 没开始拖", dragStarted(0, 0) === false);
  check("移动 1px = 没开始拖", dragStarted(1, 0) === false);
  check("移动 3px = 没开始拖（阈值 4）", dragStarted(3, 0) === false);
  check("移动 4px = 开始拖", dragStarted(4, 0) === true);
  check("移动 10px = 开始拖", dragStarted(10, 0) === true);

  // 斜着拖：两个轴都动一点，也算拖（欧氏距离）。
  check("斜拖 3+3（距离 4.24）= 开始拖", dragStarted(3, 3) === true);
  check("斜拖 2+2（距离 2.83）= 没开始拖", dragStarted(2, 2) === false);

  // 逐轴比较的坑：横向差 3px、纵向差 50px。
  check("横向 3px / 纵向 50px = 开始拖（纵向的意图够明显）", dragStarted(3, 50) === true);

  // 负方向（往回拖）同样要判定。
  check("往回拖 10px = 开始拖", dragStarted(-10, 0) === true);

  // 非法输入不得当成「在拖」（否则一次 NaN 事件就误判成拖拽）。
  check("NaN = 没开始拖", dragStarted(NaN, 0) === false);
  check("undefined = 没开始拖", dragStarted(undefined, undefined) === false);
  check("Infinity = 没开始拖", dragStarted(Infinity, 0) === false);

  // 自定义阈值。
  check("自定义阈值 10：移动 5px 不算", dragStarted(5, 0, 10) === false);
  check("自定义阈值 10：移动 12px 算", dragStarted(12, 0, 10) === true);
}

section("2. dragScroll：拖动后的滚动量");

{
  // 语义：图片跟着指针走。指针往右移 10px，图片也往右移 10px，
  // 也就是内容往左移 → 滚动量**减**去位移。
  const next = dragScroll({
    startX: 100, startY: 200, curX: 110, curY: 200,
    startLeft: 50, startTop: 300,
  });
  check("指针右移 → 滚动量左减", next.left === 40, [`实际：${next.left}`]);
  check("指针没上下动 → 纵向滚动量不变", next.top === 300, [`实际：${next.top}`]);

  const down = dragScroll({
    startX: 100, startY: 200, curX: 100, curY: 250,
    startLeft: 50, startTop: 300,
  });
  check("指针下移 → 滚动量上减", down.top === 250, [`实际：${down.top}`]);
  check("指针没左右动 → 横向滚动量不变", down.left === 50, [`实际：${down.left}`]);

  // 斜着拖：两个轴同时变。
  const diag = dragScroll({
    startX: 0, startY: 0, curX: 30, curY: 40,
    startLeft: 0, startTop: 0,
  });
  check("斜拖两个轴都算", diag.left === -30 && diag.top === -40, [`实际：${JSON.stringify(diag)}`]);

  // 反向拖（往回拉）。
  const back = dragScroll({
    startX: 100, startY: 200, curX: 90, curY: 190,
    startLeft: 50, startTop: 300,
  });
  check("往回拖 → 滚动量反向加", back.left === 60 && back.top === 310, [`实际：${JSON.stringify(back)}`]);

  // 没动 = 滚动量不变。
  const still = dragScroll({
    startX: 100, startY: 200, curX: 100, curY: 200,
    startLeft: 50, startTop: 300,
  });
  check("没动 = 滚动量不变", still.left === 50 && still.top === 300);

  // ⚠️ 返回值**不夹制**：夹制交给浏览器（scrollLeft 天然在 [0,max] 内）。
  // 自己再夹一遍就要维护第二份「最大值怎么算」的判断。
  const over = dragScroll({
    startX: 0, startY: 0, curX: 99999, curY: 0,
    startLeft: 0, startTop: 0,
  });
  check("超出范围时返回负值（不自己夹，交给浏览器）", over.left === -99999, [`实际：${over.left}`]);

  // 非法输入不产生 NaN。
  const junk = dragScroll({ startX: NaN, startY: 0, curX: 10, curY: 0, startLeft: 5, startTop: 5 });
  check("非法输入不产生 NaN", Number.isFinite(junk.left) && Number.isFinite(junk.top), [`实际：${JSON.stringify(junk)}`]);
  const empty = dragScroll();
  check("完全不传参数不崩", Number.isFinite(empty.left) && Number.isFinite(empty.top));
}

section("3. canDrag：内容溢出才拖得动");

{
  // 适应窗口：572×7191 缩到 47×596，正好放进 336×596 的可视区。
  check("适应窗口（整图可见）= 拖不动", canDrag({ contentW: 335, contentH: 596, viewW: AVAIL.w, viewH: AVAIL.h }) === false);

  // 放大到 1:1：572×7191 远大于可视区。
  check("1:1（长图）= 拖得动", canDrag({ contentW: LONG.w, contentH: LONG.h, viewW: AVAIL.w, viewH: AVAIL.h }) === true);

  // 只横向溢出。
  check("只横向溢出 = 拖得动", canDrag({ contentW: 800, contentH: 100, viewW: 360, viewH: 620 }) === true);
  // 只纵向溢出。
  check("只纵向溢出 = 拖得动", canDrag({ contentW: 100, contentH: 800, viewW: 360, viewH: 620 }) === true);

  // 正好等于（没溢出）。
  check("正好等于可视区 = 拖不动", canDrag({ contentW: 360, contentH: 620, viewW: 360, viewH: 620 }) === false);

  // 可视区尺寸未知（还没测量）时不能判定为可拖。
  check("可视区宽为 0 = 拖不动", canDrag({ contentW: 800, contentH: 800, viewW: 0, viewH: 620 }) === false);
  check("可视区高为 0 = 拖不动", canDrag({ contentW: 800, contentH: 800, viewW: 360, viewH: 0 }) === false);
  check("完全不传参数 = 拖不动", canDrag() === false);
}

section("4. 静态接线：组件真的接上了拖动");

{
  check("FilePreview.vue 从 imageDrag.js 导入", /from\s*["']\.\.\/imageDrag\.js["']/.test(src));
  check("导入了 dragStarted", /import\s*\{[^}]*dragStarted[^}]*\}/.test(src));
  check("导入了 dragScroll", /import\s*\{[^}]*dragScroll[^}]*\}/.test(src));
  check("导入了 canDrag", /import\s*\{[^}]*canDrag[^}]*\}/.test(src));

  // 模板上真的挂了 pointerdown。
  check("滚动容器挂了 @pointerdown", /class="image-scroll"[\s\S]{0,300}@pointerdown="onImagePointerDown"/.test(src));
  check("组件实现了 onImagePointerDown", /function onImagePointerDown\s*\(/.test(src));
  check("组件实现了 onImagePointerMove", /function onImagePointerMove\s*\(/.test(src));
  check("组件实现了 onImagePointerUp", /function onImagePointerUp\s*\(/.test(src));

  // 只认主键。
  check("只响应主键（e.button !== 0 直接返回）", /if\s*\(e\.button\s*!==\s*0\)\s*return;/.test(src));
  // 拖不动时不接管。
  check("拖不动时不接管手势", /if\s*\(!canDragImage\.value\)\s*return;/.test(src));
  // 阈值判定用生产判据，不自己写一套。
  check("阈值判定调用生产 dragStarted", /dragStarted\(\s*dx\s*,\s*dy/.test(src));
  // ⚠️ 必须断言「生产函数的**返回值**被用上」，而不是「文件里出现过这个
  // 函数名」—— 后者会被 `if (false) dragScroll({...})` 这种写法满足，
  // 断言就成了恒真（变异⑬ 正是这么漏的）。
  const moveBody = bodyOf(src, "function onImagePointerMove(");
  check("位移换算调用生产 dragScroll", /const next = dragScroll\(\s*\{/.test(moveBody));
  check("生产 dragScroll 的返回值真的被用（写进了 scrollLeft/scrollTop）",
    /drag\.el\.scrollLeft = next\.left/.test(moveBody) &&
    /drag\.el\.scrollTop = next\.top/.test(moveBody));
  check("可拖判定调用生产 canDrag", /canDrag\(\s*\{/.test(src));

  // 拖动状态：手势进行中要有指示（光标）。
  check("拖动状态用 ref（模板要跟着变）", /const dragging = ref\(false\)/.test(src));
  check("模板按 dragging 换 class", /:class="\{\s*draggable:\s*canDragImage,\s*dragging\s*\}"/.test(src));
  check("可拖时给 grab 光标", /\.image-scroll\.draggable\s*\{[^}]*cursor:\s*grab/s.test(src));
  check("拖动中给 grabbing 光标", /\.image-scroll\.draggable\.dragging\s*\{[^}]*cursor:\s*grabbing/s.test(src));

  // 禁掉原生图片拖拽：原生 drag 一旦启动，pointermove 就不归我们了。
  check("禁掉了图片的原生拖拽（-webkit-user-drag:none）",
    /\.image-scroll\s+(?:img|canvas)[\s\S]{0,120}-webkit-user-drag:\s*none/.test(src));

  // 手势与状态变更不并行：缩放/换文件/卸载都要结束拖动。
  //
  // ⚠️ 这几条断言必须**限定在函数体内**，不能直接正则扫全文：
  //   · 用 `[^}]*` 跨函数体会被函数体里的花括号截断
  //     （`imgNatural.value = { w: 0, h: 0 }`）—— 明明写了也断言不到；
  //   · 用 `[\s\S]*?` 惰性匹配又会**跨出函数体** —— 文件后面任意位置的
  //     endImageDrag() 都能满足它，断言就成了恒真（变异⑯⑰正是这么漏的）。
  // 正确做法是配平花括号切出函数体，再在体内找。
  check("缩放前结束拖动（applyZoom 里调 endImageDrag）",
    bodyOf(src, "async function applyZoom(").includes("endImageDrag();"));
  check("换文件时结束拖动（resetZoom 里调 endImageDrag）",
    bodyOf(src, "function resetZoom(").includes("endImageDrag();"));
  check("适应窗口时结束拖动（zoomFit 里调 endImageDrag）",
    bodyOf(src, "function zoomFit(").includes("endImageDrag();"));
  check("组件卸载时结束拖动（onBeforeUnmount 里调 endImageDrag）",
    bodyOf(src, "onBeforeUnmount(").includes("endImageDrag();"));

  // 监听器必须成对增删（漏删 = 泄漏，整个组件作用域被 window 吊住）。
  check("pointermove 监听被移除", /removeEventListener\(\s*["']pointermove["']/.test(src));
  check("pointerup 监听被移除", /removeEventListener\(\s*["']pointerup["']/.test(src));
  check("pointercancel 监听被移除", /removeEventListener\(\s*["']pointercancel["']/.test(src));
  check("拖动结束时会释放指针捕获", /releasePointerCapture/.test(src));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("全部通过");
