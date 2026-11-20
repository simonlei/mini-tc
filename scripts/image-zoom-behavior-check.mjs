// 图片缩放的**行为级**判据：在 jsdom 里对着真 DOM 跑一遍组件里真实的
// 缩放代码，验证「量尺寸 → 居中 → 缩放 → 滚轮」整条链真的通。
//
// 直接 `node scripts/image-zoom-behavior-check.mjs` 跑。
//
// ── 为什么静态断言不够 ────────────────────────────────────────────────
// image-zoom-check.mjs 断言的是「代码里写了什么」（静态接线）。但本次事故
// 恰恰是**静态全绿、功能全废**：模板写 `ref="imageScrollRef"`、脚本声明
// `imgScrollRef` —— 名字对不上，Vue 静默地把 ref 留成 null。于是：
//   · measureView() 量不到容器 → viewSize 永远是 {0,0}；
//   · 尺寸算不出来 → 图片没有显式宽高、没有居中 margin → 贴左上角；
//   · fitScale 退化成 1 → 「1:1」按钮永远已激活，点击无反应；
//   · 滚轮里 `if (!el) return` → Ctrl+滚轮毫无反应。
// 三个用户可见症状，一个根因，全程没有一行报错。
//
// 所以这里补一层**行为**断言：把组件里那段缩放代码**原样抽出来**（不是
// 抄一份），塞进 jsdom 的真 DOM 里跑，用真事件驱动，看结果对不对。
// 静态断言防「写错」，行为断言防「接不上」。
//
// ── 方法论 ────────────────────────────────────────────────────────────
// ① 抽的是**生产源码本身**（从 FilePreview.vue 里按锚点截取），不是测试里
//    重写的一份。改了实现不改调用点时，静态断言可能仍绿，这一层才会 FAIL。
// ② 滚动容器的尺寸在 jsdom 里是 0（jsdom 不做布局），所以 clientWidth/
//    clientHeight 用 defineProperty 打桩 —— 桩的值就是「面板有多大」。
// ③ 缩放要落在 DOM 上才算数：imageStyle 的宽高必须真的写进元素。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  fitScale,
  clampScale,
  zoomStep,
  wheelScale,
  zoomPercent,
  anchorScroll,
  MAX_SCALE,
} from "../src/imageZoom.js";
import { rotateStep, rotatedSize } from "../src/imageRotate.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");

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

const previewSrc = fs.readFileSync(PREVIEW, "utf8");
const previewStripped = stripComments(previewSrc);

// ── 抽取生产源码 ──────────────────────────────────────────────────────
// 从「图片缩放」这段注释之后开始，到 onPreviewKey 结束 —— 这段自成一体，
// 依赖的外部东西只有：ref/computed/nextTick（Vue）、imageZoom.js 的算术、
// 以及下面这些由测试注入的桩：frameState / imgScrollRef / imageRef /
// previewType / matches / markHandled / isImeKeydown / isTypingTarget。
function sliceBetween(src, fromAnchor, toAnchor) {
  const a = src.indexOf(fromAnchor);
  if (a < 0) return null;
  const b = src.indexOf(toAnchor, a);
  if (b < 0) return null;
  return src.slice(a, b);
}

// 缩放段的起点：第一个 ref 声明（imageScrollRef）。
// 缩放段的抽取边界。
//
// ⚠️ 源码里「缩放段」被拖动段**劈成了两半**（顺序是：
//    imageScrollRef(418) → 拖动段(516) → measureView(624) → 缩放段续(662+)）。
//    因为拖动段要读 imageGeometry，imageGeometry 又依赖缩放段的 activeScale。
//
// 所以这里抽**两段**再拼起来，跳过中间的拖动段：
//   · 前半：从 imageScrollRef 到 let drag = null;
//   · 后半：从 function measureView() 到 let drag 之后的下一个独立块
//
// ⚠️ 边界必须是**代码**而不是注释：这份源码过了 stripComments，注释内容
// 已被替换成空格，中文锚点在剥注释后的文本里根本不存在。
//
// 拖动那条线由 scripts/image-drag-behavior-check.mjs 单独覆盖。
const zoomHead = sliceBetween(
  previewStripped,
  "const imageScrollRef = ref(null);",
  "let drag = null;"
);
const zoomTail = sliceBetween(
  previewStripped,
  "function measureView() {",
  "\nfunction onPreviewKey(e) {"
);
const zoomBlock = zoomHead && zoomTail ? zoomHead + zoomTail : null;
check("从 FilePreview.vue 抽到了缩放代码段", zoomBlock !== null && zoomBlock.length > 0);
// ── jsdom 环境 ────────────────────────────────────────────────────────

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="preview-body image-body">
    <div class="image-scroll">
      <img class="preview-image" />
    </div>
  </div>
</body></html>`);
const { document } = dom.window;

const SCROLL = document.querySelector(".image-scroll");
const IMG = document.querySelector(".preview-image");

// 面板尺寸（用户报的场景：预览区大概 360×620，扣掉 12px 内边距）。
const PANEL = { w: 360, h: 620 };
const PAD = 12;

// jsdom 不做布局，clientWidth/clientHeight 恒为 0 —— 打桩。
Object.defineProperty(SCROLL, "clientWidth", { get: () => PANEL.w, configurable: true });
Object.defineProperty(SCROLL, "clientHeight", { get: () => PANEL.h, configurable: true });
SCROLL.scrollLeft = 0;
SCROLL.scrollTop = 0;
// getComputedStyle 在 jsdom 里能读到 stylesheet，但这里没有样式表，
// 直接把内边距打桩成 12px（与组件 CSS 一致）。
const origGetComputedStyle = dom.window.getComputedStyle;
dom.window.getComputedStyle = (el, pseudo) => {
  const cs = origGetComputedStyle.call(dom.window, el, pseudo);
  if (el === SCROLL) {
    return new Proxy(cs, {
      get(t, p) {
        if (p === "paddingLeft" || p === "paddingRight") return `${PAD}px`;
        if (p === "paddingTop" || p === "paddingBottom") return `${PAD}px`;
        const v = t[p];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }
  return cs;
};

// 自然像素：用户报的那张微信长图 572×7191。
const NAT = { w: 572, h: 7191 };
// 元素实际渲染尺寸的打桩：缩放后要能算出「图片在视口里多大」。
// ⚠️ getBoundingClientRect 必须是**函数**（源码里是 media.getBoundingClientRect()），
// 所以这里用 value 而不是 get —— 用 get 会把 rect 对象本身当成函数，报
// "media.getBoundingClientRect is not a function"。
//
// ⚠️ 尺寸直接取自 imageStyle（唯一真源），而不是 IMG.style：applyZoom 里
// 「改之前的矩形」和「改之后的矩形」各测一次，两次必须反映不同的比例 —
// 从 IMG.style 读的话测试里没人去写它，两次都是 0，锚点补偿就被架空了。
function currentStyle() {
  try {
    const pic = api && api.pictureStyle ? api.pictureStyle.value : {};
    const frame = api && api.frameStyle ? api.frameStyle.value : {};
    return {
      width: pic.width,
      height: pic.height,
      marginLeft: frame.marginLeft,
      marginTop: frame.marginTop,
    };
  } catch {
    return {};
  }
}
Object.defineProperty(IMG, "getBoundingClientRect", {
  configurable: true,
  value: function getBoundingClientRect() {
    const st = currentStyle();
    const w = Number.parseFloat(st.width) || 0;
    const h = Number.parseFloat(st.height) || 0;
    return {
      left: Number.parseFloat(st.marginLeft) || 0,
      top: Number.parseFloat(st.marginTop) || 0,
      width: w,
      height: h,
      right: w,
      bottom: h,
      x: 0,
      y: 0,
    };
  },
});
SCROLL.getBoundingClientRect = () => ({
  left: 0,
  top: 0,
  width: PANEL.w,
  height: PANEL.h,
  right: PANEL.w,
  bottom: PANEL.h,
  x: 0,
  y: 0,
});

// ── 装配生产代码 ──────────────────────────────────────────────────────
// 把抽出来的缩放段包成一个工厂：注入 Vue 的响应式原语与外部桩。
// ⚠️ 变量名必须和缩放段里用到的**完全一致** —— 这正是本次事故的地方，
// 所以这里也顺手钉一条断言：注入的名字和源码里引用的名字要对得上。
//
// ⚠️ 注意：imageScrollRef / imageRef 由**源码段自己声明**（它就在抽出来的
// 那一段里），这里不能重复注入，否则 Identifier already declared。
// 我们只在装配完之后把 ref 接到真 DOM 上 —— 那正是模板 ref= 的作用。
const FACTORY = `
  const { ref, computed, nextTick } = Vue;
  const { fitScale: computeFitScale, zoomStep, wheelScale, zoomPercent, anchorScroll, MAX_SCALE } = Zoom;
  const { rotateStep, rotatedSize } = Rotate;
  const frameState = { value: { count: 0, width: 0, height: 0, index: 0, playing: false } };
  const previewType = { value: "image" };
  const matches = () => false;
  const markHandled = () => {};
  const isImeKeydown = () => false;
  const isTypingTarget = () => false;
  // 拖动段的函数被缩放段调用（resetZoom / applyZoom / zoomFit 都会
  // endImageDrag()）。拖动那条线由 image-drag-behavior-check.mjs 覆盖，
  // 这里给个空实现即可 —— 缩放的行为与拖动无关。
  const endImageDrag = () => {};
`;

const factory = new Function(
  "Vue",
  "Zoom",
  "Rotate",
  "getComputedStyle",
  FACTORY +
    zoomBlock +
    `
  return {
    imageScrollRef, imageRef, imgNatural, zoomMode, zoomScale, viewSize,
    naturalSize, rotatedNatural, rotation, fitScale, activeScale,
    frameStyle, pictureStyle, isFit, isActual,
    canZoomIn, canZoomOut, zoomLevelText, geometryPending,
    measureView, applyZoom, zoomIn, zoomOut, zoomFit, zoomActual, onImageWheel,
    resetZoom, resetRotation, rotateBy, rotateLeft, rotateRight,
  };
`
);

const Vue = {
  ref: (v) => ({ value: v }),
  computed: (fn) => {
    // 简单的 getter 包装：Vue 的 computed 是惰性求值的，这里每次读都重算，
    // 对测试来说更接近「状态变了立刻反映」。
    const c = { __get: fn };
    return new Proxy(c, {
      get(t, p) {
        if (p === "value") return fn();
        return t[p];
      },
    });
  },
  nextTick: (fn) => Promise.resolve().then(fn),
};

let api;
try {
  api = factory(Vue, { fitScale, zoomStep, wheelScale, zoomPercent, anchorScroll, MAX_SCALE }, { rotateStep, rotatedSize }, dom.window.getComputedStyle);
} catch (e) {
  check("缩放代码段能装配起来（依赖注入的名字都对得上）", false, [String(e && e.message)]);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`通过 ${passed} / ${passed + failures.length}`);
  process.exit(1);
}
check("缩放代码段能装配起来（依赖注入的名字都对得上）", true);

// 接线：把 ref 接到真 DOM 上（这一步就是模板里 ref= 的作用）。
api.imageScrollRef.value = SCROLL;
api.imageRef.value = IMG;

// 模拟 <img> 的 load 事件：填入 naturalWidth/Height。
// ⚠️ resetZoom() 会把 imgNatural 清空（换文件时先复位，等新的 load 事件再填），
// 所以每次 resetZoom 之后都要重新模拟一次 load —— 否则测的是「图片还没加载」
// 的中间态，不是真实场景。
function simulateImageLoad() {
  api.imgNatural.value = { w: NAT.w, h: NAT.h };
  api.measureView();
}
simulateImageLoad();

section("1. 容器测量：量得到，尺寸不是 {0,0}");

{
  api.measureView();
  const vs = api.viewSize.value;
  check(
    `viewSize 量到了真实尺寸（${vs.w}×${vs.h}）`,
    vs.w === PANEL.w - PAD * 2 && vs.h === PANEL.h - PAD * 2,
    [`实际：${JSON.stringify(vs)}`]
  );
  check(
    "viewSize 不是 {0,0}（这正是本次事故时它永远的值）",
    vs.w > 0 && vs.h > 0,
    [`实际：${JSON.stringify(vs)}`]
  );
  const fs = api.fitScale.value;
  check(
    "fitScale 是真实的长图适配比例（约 8.6%，不是退化的 1）",
    Math.abs(fs - (PANEL.h - PAD * 2) / NAT.h) < 1e-9,
    [`实际：${fs}`]
  );
  check("fitScale 没有退化成 1（退化成 1 会让「1:1」按钮永远已激活）", Math.abs(fs - 1) > 1e-9);
}

section("2. 适应窗口：图片居中，且整图可见");

{
  // 画面本体（<img> 的盒子）与画框（滚动容器量的占位）分两层：
  //   · pictureStyle —— 画面本体的尺寸（未旋转比例）；
  //   · frameStyle   —— 画框的占位与居中偏移（旋转后宽高会互换）。
  // 旋转 0° 时两者尺寸相同。
  const pic = api.pictureStyle.value;
  const st = api.frameStyle.value;
  const expectW = Math.floor(NAT.w * api.fitScale.value);
  const expectH = Math.floor(NAT.h * api.fitScale.value);
  check(`显示宽度按 fit 比例算（${expectW}px）`, pic.width === `${expectW}px`, [`实际：${pic.width}`]);
  check(`显示高度按 fit 比例算（${expectH}px）`, pic.height === `${expectH}px`, [`实际：${pic.height}`]);
  check(
    "适应窗口档保留 max-* 兜底",
    st.maxWidth === "100%" && st.maxHeight === "100%",
    [`实际：${st.maxWidth} / ${st.maxHeight}`]
  );

  // 居中：左右 margin 相等，且 图片宽 + 左右 margin ≈ 可用宽。
  // ⚠️ 容差 1px：可用宽与图片宽差值为奇数时无法均分（margin 是整数），
  //   47 + 144*2 = 335 vs 336 —— 中心差 0.5px，像素级居中已足够。
  const avail = PANEL.w - PAD * 2;
  const mx = Number.parseFloat(st.marginLeft);
  const mr = Number.parseFloat(st.marginRight);
  check("左右居中 margin 相等", mx === mr, [`左 ${mx} / 右 ${mr}`]);
  check(
    "图片居中（宽 + 左右 margin ≈ 可用宽，容差 1px）",
    Math.abs(expectW + mx + mr - avail) <= 1,
    [`${expectW} + ${mx} + ${mr} vs ${avail}`]
  );
  check("左右 margin 大于 0（贴左边就是没居中）", mx > 0, [`实际：${mx}`]);

  // 上下：长图按高度适配 → 高度填满可视区 → 上下 margin 为 0（贴顶是对的）。
  const availH = PANEL.h - PAD * 2;
  const my = Number.parseFloat(st.marginTop);
  check(
    "上下 margin 正确（长图高度填满可视区 → 0）",
    Math.abs(expectH + my + Number.parseFloat(st.marginBottom) - availH) < 1e-9,
    [`${expectH} + ${my} vs ${availH}`]
  );
}

section("3. 缩放：档位、封顶、1:1");

{
  // 适应窗口 → 放大一档
  api.zoomIn();
  check("放大一档后进入 manual 模式", api.zoomMode.value === "manual");
  check("放大一档 = 25%", Math.abs(api.activeScale.value - 0.25) < 1e-9, [`实际：${api.activeScale.value}`]);
  check("放大后 isActual 为 false（还没到 1:1）", api.isActual.value === false);
  check("放大后 canZoomIn 为 true", api.canZoomIn.value === true);
  check(
    "放大档解除了 max-* 约束（否则长图被压回容器高度，缩放等于没做）",
    api.frameStyle.value.maxHeight === "none" && api.frameStyle.value.maxWidth === "none"
  );

  // 继续放大到顶
  api.zoomIn();
  check("再放大 = 50%", Math.abs(api.activeScale.value - 0.5) < 1e-9);
  api.zoomIn();
  check("再放大 = 75%", Math.abs(api.activeScale.value - 0.75) < 1e-9);
  api.zoomIn();
  check("再放大 = 100%（原始大小）", Math.abs(api.activeScale.value - 1) < 1e-9);
  check("到 100% 后 isActual 为 true", api.isActual.value === true);
  check("到 100% 后 canZoomIn 为 false（封顶，不再往上）", api.canZoomIn.value === false);

  // 再点放大不该越界
  api.zoomIn();
  check("超过 100% 也还是 100%（封顶生效）", Math.abs(api.activeScale.value - 1) < 1e-9);

  // 1:1 的显示尺寸 = 原始像素
  const pic = api.pictureStyle.value;
  const st = api.frameStyle.value;
  check(`1:1 显示尺寸就是原始像素（${NAT.w}×${NAT.h}）`,
    pic.width === `${NAT.w}px` && pic.height === `${NAT.h}px`,
    [`实际：${pic.width} × ${pic.height}`]);
  check("1:1 时 margin 归零（贴左上角，四边都够得着）",
    Number.parseFloat(st.marginLeft) === 0 && Number.parseFloat(st.marginTop) === 0);
}

section("4. 1:1 按钮：从 fit 档点过去真的有反应（本次事故的直接症状）");

{
  api.resetZoom();
  simulateImageLoad(); // 真实流程里 resetZoom 之后由 <img> 的 load 事件补回 natural 尺寸
  check("resetZoom 后回到 fit 模式", api.zoomMode.value === "fit");
  check("resetZoom 后 fit 比例正确", Math.abs(api.fitScale.value - (PANEL.h - PAD * 2) / NAT.h) < 1e-9);
  check("resetZoom 后 isActual 为 false（「1:1」按钮不是已激活态）", api.isActual.value === false);

  api.zoomActual();
  check("点 1:1 后进入 manual 模式", api.zoomMode.value === "manual", [`实际：${api.zoomMode.value}`]);
  check("点 1:1 后比例 = 1", Math.abs(api.activeScale.value - 1) < 1e-9, [`实际：${api.activeScale.value}`]);
  check("点 1:1 后 isActual 为 true", api.isActual.value === true);
  check("点 1:1 后显示尺寸 = 原始像素",
    api.pictureStyle.value.width === `${NAT.w}px` && api.pictureStyle.value.height === `${NAT.h}px`);
}

section("5. 滚轮：Ctrl+滚轮缩放，普通滚轮不劫持，Shift+滚轮横向滚动");

{
  api.resetZoom();
  simulateImageLoad(); // 真实流程里 resetZoom 之后由 <img> 的 load 事件补回 natural 尺寸

  // 普通滚轮（不按 Ctrl）—— 必须放行给浏览器自己滚。
  let prevented = false;
  api.onImageWheel({
    ctrlKey: false, metaKey: false, shiftKey: false,
    deltaY: -100, clientX: 100, clientY: 300,
    preventDefault: () => { prevented = true; },
  });
  check("普通滚轮不缩放", Math.abs(api.activeScale.value - api.fitScale.value) < 1e-9);
  check("普通滚轮不被 preventDefault（留给原生滚动）", prevented === false);

  // Ctrl+滚轮向上 —— 放大。
  const before = api.activeScale.value;
  api.onImageWheel({
    ctrlKey: true, metaKey: false, shiftKey: false,
    deltaY: -100, clientX: 100, clientY: 300,
    preventDefault: () => { prevented = true; },
  });
  check("Ctrl+滚轮向上 = 放大", api.activeScale.value > before, [`${before} → ${api.activeScale.value}`]);
  check("Ctrl+滚轮后进入 manual 模式", api.zoomMode.value === "manual");
  check("Ctrl+滚轮 preventDefault 了（否则整页跟着缩放）", prevented === true);

  // Ctrl+滚轮向下 —— 缩小，但不低于 fit。
  const afterIn = api.activeScale.value;
  api.onImageWheel({
    ctrlKey: true, metaKey: false, shiftKey: false,
    deltaY: 100, clientX: 100, clientY: 300,
    preventDefault: () => {},
  });
  check("Ctrl+滚轮向下 = 缩小", api.activeScale.value < afterIn);
  check(
    "Ctrl+滚轮缩不到 fit 以下",
    api.activeScale.value >= api.fitScale.value - 1e-9,
    [`实际：${api.activeScale.value} vs fit ${api.fitScale.value}`]
  );

  // 滚到 100% 就不再涨。
  api.zoomActual();
  api.onImageWheel({
    ctrlKey: true, metaKey: false, shiftKey: false,
    deltaY: -10000, clientX: 100, clientY: 300,
    preventDefault: () => {},
  });
  check("Ctrl+滚轮滚到顶也停在 100%（封顶）", Math.abs(api.activeScale.value - 1) < 1e-9);

  // Shift+滚轮 = 左右滚动。
  api.resetZoom();
  simulateImageLoad(); // 真实流程里 resetZoom 之后由 <img> 的 load 事件补回 natural 尺寸
  SCROLL.scrollLeft = 0;
  api.onImageWheel({
    ctrlKey: false, metaKey: false, shiftKey: true,
    deltaY: 80, clientX: 100, clientY: 300,
    preventDefault: () => {},
  });
  check("Shift+滚轮 = 横向滚动", SCROLL.scrollLeft === 80, [`实际：${SCROLL.scrollLeft}`]);
}

section("6. 缩小：缩到底回到适应窗口");

{
  api.resetZoom();
  simulateImageLoad(); // 真实流程里 resetZoom 之后由 <img> 的 load 事件补回 natural 尺寸
  api.zoomIn();
  api.zoomIn();
  check("放大两次后是 manual", api.zoomMode.value === "manual");
  check("放大两次 = 50%（fit 8.6% → 25% → 50%）", Math.abs(api.activeScale.value - 0.5) < 1e-9,
    [`实际：${api.activeScale.value}`]);
  api.zoomOut();
  check("缩小一档 = 25%", Math.abs(api.activeScale.value - 0.25) < 1e-9, [`实际：${api.activeScale.value}`]);
  api.zoomOut();
  check("再缩小 = 回到 fit 模式（fit 以下没有更小的档）", api.zoomMode.value === "fit", [`实际：${api.zoomMode.value}`]);
  check("回到 fit 后比例等于 fitScale", Math.abs(api.activeScale.value - api.fitScale.value) < 1e-9);
  check("回到 fit 后 isFit 为 true", api.isFit.value === true);
}

section("7. 兜底那一帧与最终帧必须是同一幅画面（否则会看到跳动）");

{
  // 兜底机制写在 CSS 里。这里**不复制一份语义**，而是从组件源码读出
  // 「兜底会不会把小图放大」，再拿它跟最终几何比 —— 改了 CSS 判据跟着变，
  // 不会出现「测试里的副本还停在旧语义」的分叉。
  //
  // ⚠️ 关键事实（Chromium 157 实测）：`object-fit: contain` 会**放大**小图
  // 并铺满盒子 —— 10×10 的图在 200×200 盒子里被画成 200×200。上一版兜底
  // 用的就是 contain，于是比面板小的图会「先占满面板、再缩回 1:1」。
  // 兜底必须只封顶不放大（max-*）。
  const styleSrc = (previewStripped.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [null, ""])[1];
  function cssRule(css, selector) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sels = m[1].trim().split(/\s*,\s*/);
      if (sels.includes(selector)) return m[2];
    }
    return null;
  }
  const fbBody = cssRule(styleSrc, ".image-frame.fallback .preview-image");
  check("组件里有兜底规则（.image-frame.fallback .preview-image）", fbBody !== null);
  const fb = fbBody || "";
  // 会不会放大：contain 铺满盒子会；max-* 只封顶不会。
  const fallbackUpscales = /object-fit:\s*contain/.test(fb);

  const availW = PANEL.w - PAD * 2;
  const availH = PANEL.h - PAD * 2;

  // 兜底那一帧的显示尺寸：可视区里按「铺满（会放大）」还是「只封顶」算。
  function fallbackSize(natW, natH) {
    const raw = Math.min(availW / natW, availH / natH);
    const s = fallbackUpscales ? raw : Math.min(raw, 1);
    return { w: natW * s, h: natH * s };
  }

  // 两个场景都要跑：**比面板大**的（长图）与**比面板小**的（小图）。
  // 只测长图的话，「兜底放大」这一支永远走不到 —— 小图才是出问题的那个。
  const SCENARIOS = [
    { name: "长图 572×7191（比面板大）", nat: { w: 572, h: 7191 } },
    { name: "小图 120×90（比面板小）", nat: { w: 120, h: 90 } },
  ];

  for (const sc of SCENARIOS) {
    api.resetZoom();
    api.imgNatural.value = { w: sc.nat.w, h: sc.nat.h };
    api.measureView();
    const st = api.frameStyle.value;
    const pic = api.pictureStyle.value;
    const finalW = Number.parseFloat(pic.width);
    const finalH = Number.parseFloat(pic.height);
    const fbSize = fallbackSize(sc.nat.w, sc.nat.h);

    check(`${sc.name}：兜底的显示尺寸 == fit 档的内联尺寸（±1px）`,
      Math.abs(fbSize.w - finalW) <= 1 && Math.abs(fbSize.h - finalH) <= 1,
      [`兜底 ${fbSize.w.toFixed(1)}×${fbSize.h.toFixed(1)} vs fit ${finalW}×${finalH}`]);
    check(`${sc.name}：兜底的左边缘 == fit 档的居中 margin（±1px）`,
      Math.abs((availW - fbSize.w) / 2 - Number.parseFloat(st.marginLeft)) <= 1,
      [`兜底 ${((availW - fbSize.w) / 2).toFixed(1)} vs fit ${st.marginLeft}`]);
    check(`${sc.name}：兜底的上边缘 == fit 档的居中 margin（±1px）`,
      Math.abs((availH - fbSize.h) / 2 - Number.parseFloat(st.marginTop)) <= 1,
      [`兜底 ${((availH - fbSize.h) / 2).toFixed(1)} vs fit ${st.marginTop}`]);
    check(`${sc.name}：兜底不放大（显示尺寸不超过原始像素）`,
      fbSize.w <= sc.nat.w + 1 && fbSize.h <= sc.nat.h + 1,
      [`兜底 ${fbSize.w.toFixed(1)}×${fbSize.h.toFixed(1)} vs 原始 ${sc.nat.w}×${sc.nat.h}`]);
  }

  // 兜底态的开关：几何算不出来时为 true（CSS 兜底接管），算出后为 false。
  api.resetZoom();
  check("几何未就绪时 geometryPending 为 true（走 CSS 兜底）", api.geometryPending.value === true);
  api.imgNatural.value = { w: NAT.w, h: NAT.h };
  api.measureView();
  check("几何就绪后 geometryPending 为 false（用内联尺寸）", api.geometryPending.value === false);
}

section("8. 对照臂：本次事故的形状（ref 绑不上）会让上面全废");

{
  // 这一节验证「上面那些断言真的在测功能，而不是恒真」。
  // 复现事故：ref 绑不上（名字对不上）→ measureView 量不到 → viewSize 恒 {0,0}。
  const broken = factory(Vue, { fitScale, zoomStep, wheelScale, zoomPercent, anchorScroll, MAX_SCALE }, { rotateStep, rotatedSize }, dom.window.getComputedStyle);
  broken.imageScrollRef.value = null; // ← 事故现场：ref 没绑上
  broken.imgNatural.value = { w: NAT.w, h: NAT.h };
  broken.measureView();
  check("对照臂：ref 为 null 时 viewSize 恒为 {0,0}", broken.viewSize.value.w === 0 && broken.viewSize.value.h === 0);
  check("对照臂：ref 为 null 时 fitScale 退化成 1", Math.abs(broken.fitScale.value - 1) < 1e-9);
  check("对照臂：ref 为 null 时 isActual 恒 true（「1:1」永远已激活 → 点击无反应）",
    broken.isActual.value === true);
  check("对照臂：ref 为 null 时画框与画面本体都没有尺寸（图片不居中）",
    Object.keys(broken.frameStyle.value).length === 0 &&
    Object.keys(broken.pictureStyle.value).length === 0);
  check("对照臂：ref 为 null 时 Ctrl+滚轮毫无反应", (() => {
    const b = broken.activeScale.value;
    broken.onImageWheel({
      ctrlKey: true, metaKey: false, shiftKey: false,
      deltaY: -100, clientX: 10, clientY: 10,
      preventDefault: () => {},
    });
    return Math.abs(broken.activeScale.value - b) < 1e-9;
  })());
}

// ══════════════ report ══════════════

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
