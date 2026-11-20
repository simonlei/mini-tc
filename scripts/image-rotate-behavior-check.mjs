// 图片旋转的**行为级**判据：在 jsdom 里对着真 DOM 跑一遍组件里真实的
// 旋转代码，验证「转一下 → 画面真的转了 → 几何跟着换 → 缩放仍然对得上」。
//
// 直接 `node scripts/image-rotate-behavior-check.mjs` 跑。
//
// ── 为什么静态断言不够 ────────────────────────────────────────────────
// image-rotate-check.mjs 断言的是「代码里写了什么」。但旋转最容易出的错
// 是「接上了却不生效」：
//   · transform 写成了 rotate(-90deg)（左右转反）；
//   · 几何按未旋转的尺寸算（转 90° 后长图横着溢出面板）；
//   · 画面本体用了旋转后的占位（画面被拉伸变形）。
// 这三种在静态断言里都可能全绿，运行时才暴露。
//
// ── 方法论 ────────────────────────────────────────────────────────────
// ① 抽的是**生产源码本身**（从 FilePreview.vue 里按锚点截取），不是测试里
//    重写的一份。
// ② 旋转后的画面是 transform 出来的 —— jsdom 不做 transform 渲染，但
//    transform 的**字符串**会原样落到 style 上，所以可以直接断言它。
// ③ 几何的换算是纯算术，用生产函数（imageRotate.js）算，不另抄一份。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { rotateStep, rotatedSize, angleLabel } from "../src/imageRotate.js";
import { fitScale } from "../src/imageZoom.js";
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

const previewSrc = stripComments(fs.readFileSync(PREVIEW, "utf8"));

// ── 抽取生产源码 ──────────────────────────────────────────────────────
function sliceBetween(src, fromAnchor, toAnchor) {
  const a = src.indexOf(fromAnchor);
  if (a < 0) return null;
  const b = src.indexOf(toAnchor, a);
  if (b < 0) return null;
  return src.slice(a, b);
}

// 几何段（naturalSize → rotatedNatural → fitScale → activeScale →
// geometryFor → imageGeometry → frameStyle → pictureStyle）。
//
// ⚠️ 起点必须够早：fitScale 在 geometryFor **之前**定义，切晚了它就丢了，
// 后面 frameStyle 里的「适应窗口」兜底会跟着失效。
const geoBlock = sliceBetween(
  previewSrc,
  "const naturalSize = computed(() =>",
  "\nconst isFit = computed(() =>"
);
check("从 FilePreview.vue 抽到了旋转几何代码段", geoBlock !== null && geoBlock.length > 0);

// 旋转动作段（rotateBy / rotateLeft / rotateRight）。
//
// ⚠️ 终点必须是拖动段的起点 `let drag = null;` —— 再往后会连拖动段一起
// 抽进来（它依赖 canDrag 等注入），就不是「只测旋转」了。
const rotateBlock = sliceBetween(
  previewSrc,
  "function rotateBy(dir) {",
  "\nlet drag = null;"
);
check("抽到了旋转动作代码段", rotateBlock !== null && rotateBlock.length > 0);

// ── jsdom 环境 ────────────────────────────────────────────────────────
const dom = new JSDOM(`<!doctype html><html><body>
  <div class="preview-body image-body">
    <div class="image-scroll">
      <div class="image-frame">
        <img class="preview-image" />
      </div>
    </div>
  </div>
</body></html>`);
const { document } = dom.window;
const SCROLL = document.querySelector(".image-scroll");
const FRAME = document.querySelector(".image-frame");
const IMG = document.querySelector(".preview-image");

// 面板尺寸（用户报的场景：预览区大概 360×620，扣掉 12px 内边距）。
const PANEL = { w: 360, h: 620 };
const PAD = 12;
const AVAIL = { w: PANEL.w - PAD * 2, h: PANEL.h - PAD * 2 };

Object.defineProperty(SCROLL, "clientWidth", { get: () => PANEL.w, configurable: true });
Object.defineProperty(SCROLL, "clientHeight", { get: () => PANEL.h, configurable: true });
SCROLL.scrollLeft = 0;
SCROLL.scrollTop = 0;

// ── 装配生产代码 ──────────────────────────────────────────────────────
// ⚠️ 变量名必须和源码段里用到的**完全一致** —— 这正是缩放那次事故的地方。
// ⚠️ naturalSize / rotatedNatural / fitScale / activeScale 由抽出来的源码段
// 自己声明，这里不能重复注入（Identifier already declared）。
const FACTORY = `
  const { ref, computed } = Vue;
  const { rotateStep, rotatedSize } = Rotate;
  const { fitScale: computeFitScale } = Zoom;
  const frameState = { value: { count: 0, width: 0, height: 0, index: 0, playing: false } };
  const viewSize = { value: { w: VIEW_W, h: VIEW_H } };
  const imgNatural = { value: { w: NAT_W, h: NAT_H } };
  const rotation = { value: 0 };
  const zoomMode = { value: "fit" };
  const zoomScale = { value: 1 };
  const imageScrollRef = { value: SCROLL };
  const endImageDrag = () => {};
`;

const factory = new Function(
  "Vue",
  "Rotate",
  "Zoom",
  "VIEW_W",
  "VIEW_H",
  "NAT_W",
  "NAT_H",
  "SCROLL",
  FACTORY +
    geoBlock +
    rotateBlock +
    `
  return {
    rotation, zoomMode, zoomScale,
    naturalSize, rotatedNatural, fitScale, activeScale,
    imageGeometry, frameStyle, pictureStyle,
    rotateBy, rotateLeft, rotateRight,
  };
`
);

const Vue = {
  ref: (v) => ({ value: v }),
  computed: (fn) =>
    new Proxy({ __get: fn }, {
      get(t, p) {
        if (p === "value") return fn();
        return t[p];
      },
    }),
};

let api;
try {
  api = factory(
    Vue,
    { rotateStep, rotatedSize },
    { fitScale },
    AVAIL.w,
    AVAIL.h,
    572,
    7191,
    SCROLL
  );
} catch (e) {
  check("旋转代码段能装配起来（依赖注入的名字都对得上）", false, [String(e && e.message)]);
  console.log(`\n${"─".repeat(50)}`);
  console.log(`通过 ${passed} / ${passed + failures.length}`);
  process.exit(1);
}
check("旋转代码段能装配起来（依赖注入的名字都对得上）", true);

// 把样式真的写到 DOM 上 —— 旋转要「看得出来」，不能只停在 JS 变量里。
function paint() {
  const frame = api.frameStyle.value;
  const pic = api.pictureStyle.value;
  for (const [k, v] of Object.entries(frame)) FRAME.style.setProperty(k, v);
  for (const [k, v] of Object.entries(pic)) IMG.style.setProperty(k, v);
}

// 一张 572×7191 的竖长图（微信截图）。
const NAT = { w: 572, h: 7191 };
const NAT_RATIO = NAT.w / NAT.h;

section("1. 转一下：角度真的变了，且 transform 真的写到了 DOM 上");

{
  check("初始角度是 0°", api.rotation.value === 0);
  check("初始没有 transform", !IMG.style.transform);

  api.rotateRight();
  check("右转后角度 = 90°", api.rotation.value === 90, [`实际：${api.rotation.value}`]);
  paint();
  check(
    "画面本体的 transform 写上了 rotate(90deg)",
    /rotate\(90deg\)/.test(IMG.style.transform || ""),
    [`实际：${IMG.style.transform}`]
  );

  api.rotateRight();
  check("再右转 = 180°", api.rotation.value === 180);
  paint();
  check("transform 变成 rotate(180deg)", /rotate\(180deg\)/.test(IMG.style.transform || ""));

  api.rotateRight();
  check("再右转 = 270°", api.rotation.value === 270);
  paint();
  check("transform 变成 rotate(270deg)", /rotate\(270deg\)/.test(IMG.style.transform || ""));

  api.rotateRight();
  check("转满四圈回到 0°", api.rotation.value === 0);

  api.rotateLeft();
  check("左转一步 = 270°（逆时针）", api.rotation.value === 270);
  paint();
  check(
    "左转的 transform 是 rotate(270deg)（不是 -90deg，两者等价）",
    /rotate\(270deg\)/.test(IMG.style.transform || ""),
    [`实际：${IMG.style.transform}`]
  );
  api.rotateLeft();
  check("左转两步 = 180°", api.rotation.value === 180);
}

section("2. 画面本体不被拉伸变形（宽高比始终是原始比例）");

{
  // ⚠️ 这里必须用**手动缩放档**（固定 1:1）来比：
  // 「适应窗口」档的比例是按旋转后的占位算的 —— 转 90° 后比例本身就会变，
  // 拿两档不同的比例比宽高比，结论没有意义。
  api.zoomMode.value = "manual";
  api.zoomScale.value = 1;

  api.rotation.value = 0;
  const pic0 = { ...api.pictureStyle.value };
  const geo0 = { ...api.imageGeometry.value };

  api.rotation.value = 90;
  const pic90 = { ...api.pictureStyle.value };
  const geo90 = { ...api.imageGeometry.value };

  check(
    "0° 时画面本体是原始像素（572×7191）",
    pic0.width === `${NAT.w}px` && pic0.height === `${NAT.h}px`,
    [`实际：${pic0.width}×${pic0.height}`]
  );
  check(
    "90° 时画面本体的宽高没变（转的是画面，不是把它拉变形）",
    pic90.width === pic0.width && pic90.height === pic0.height,
    [`实际：${pic90.width}×${pic90.height}`]
  );
  check(
    "画框的占位宽高互换了（90° 时 w/h = ph/pw）",
    geo90.w === geo0.h && geo90.h === geo0.w,
    [`0°: ${geo0.w}×${geo0.h} / 90°: ${geo90.w}×${geo90.h}`]
  );
  check(
    "画面本体的盒子尺寸**不等于**画框占位（否则就是拿占位去画画面 → 变形）",
    !(geo90.w === parseFloat(pic90.width) && geo90.h === parseFloat(pic90.height)),
    [`画框 ${geo90.w}×${geo90.h} / 画面 ${pic90.width}×${pic90.height}`]
  );

  api.zoomMode.value = "fit";
}

section("3. 画框的占位与生产 rotatedSize 一致（几何只有一处实现）");

{
  for (const deg of [0, 90, 180, 270]) {
    api.rotation.value = deg;
    const g = api.imageGeometry.value;
    const pic = api.pictureStyle.value;
    const expect = rotatedSize(parseFloat(pic.width), parseFloat(pic.height), deg);
    check(
      `${deg}° 时画框占位与 rotatedSize 一致`,
      g.w === expect.w && g.h === expect.h,
      [`画框 ${g.w}×${g.h} / rotatedSize ${expect.w}×${expect.h}`]
    );
  }
}

section("4. 居中偏移按旋转后的占位算（转完的图不会偏出面板）");

{
  // ⚠️ 固定比例（手动档 1:1）才谈得上「同一个盒子换了个方向」——
  // 「适应窗口」档的比例本身会随旋转变，两者的尺寸不可直接比。
  api.zoomMode.value = "manual";
  api.zoomScale.value = 1;

  api.rotation.value = 0;
  const g0 = api.imageGeometry.value;

  api.rotation.value = 90;
  const g90 = api.imageGeometry.value;

  // 竖长图转 90°：画框变宽（572 → 7191）、变矮（7191 → 572）。
  check("横置后画框更宽", g90.w > g0.w, [`${g0.w} → ${g90.w}`]);
  check("横置后画框更矮", g90.h < g0.h, [`${g0.h} → ${g90.h}`]);

  // 偏移 = max(0, (可用 − 占位) / 2)：
  //   · 放得下 → 居中（占位 + 2×偏移 ≈ 可用区）；
  //   · 放不下 → 偏移归零（贴左上角，四边都够得着，不会有一侧滚不到）。
  check("左右偏移非负", g90.mx >= 0 && g90.my >= 0);
  // 1:1 时横置的长图：宽 7191 放不下（→ mx=0），高 572 放得下（→ 居中）。
  check(
    "放不下的那一轴偏移归零（贴边，不是一头出界够不着）",
    g90.mx === 0,
    [`画框宽 ${g90.w} vs 可用宽 ${AVAIL.w} / mx=${g90.mx}`]
  );
  check(
    "放得下的那一轴照常居中（高 + 2×偏移 ≈ 可用高，容差 1px）",
    Math.abs(g90.h + g90.my * 2 - AVAIL.h) <= 1,
    [`${g90.h} + ${g90.my}×2 vs ${AVAIL.h}`]
  );

  // 换回「适应窗口」档：这时画框放得下，应该正好居中。
  api.zoomMode.value = "fit";
  api.rotation.value = 90;
  const gf = api.imageGeometry.value;
  check(
    "适应窗口档下画框放得进可视区",
    gf.w <= AVAIL.w && gf.h <= AVAIL.h,
    [`画框 ${gf.w}×${gf.h} vs 可用 ${AVAIL.w}×${AVAIL.h}`]
  );
  check(
    "左右偏移正好把画框摆在可视区中间（宽 + 2×偏移 ≈ 可用宽，容差 1px）",
    Math.abs(gf.w + gf.mx * 2 - AVAIL.w) <= 1,
    [`${gf.w} + ${gf.mx}×2 vs ${AVAIL.w}`]
  );
  check(
    "上下偏移正好把画框摆在可视区中间（高 + 2×偏移 ≈ 可用高，容差 1px）",
    Math.abs(gf.h + gf.my * 2 - AVAIL.h) <= 1,
    [`${gf.h} + ${gf.my}×2 vs ${AVAIL.h}`]
  );
}

section("5. 「适应窗口」按旋转后的占位算（横过来的长图不会溢出面板）");

{
  // 一张 572×7191 的竖长图。
  api.rotation.value = 0;
  const fit0 = api.fitScale.value;

  api.rotation.value = 90;
  const fit90 = api.fitScale.value;

  // 竖着看：受高度约束（7191 很长）。
  const expect0 = fitScale(NAT.w, NAT.h, AVAIL.w, AVAIL.h);
  check("0° 的适应比例 == 按原尺寸算", Math.abs(fit0 - expect0) < 1e-12, [`实际：${fit0}`]);
  check("竖图是按高度适配的（比例很小）", fit0 < 0.2, [`实际：${fit0}`]);

  // 转 90°：占位变成 7191×572 —— 横向变长，改由宽度约束。
  const expect90 = fitScale(NAT.h, NAT.w, AVAIL.w, AVAIL.h);
  check("90° 的适应比例 == 按旋转后的占位算", Math.abs(fit90 - expect90) < 1e-12, [`实际：${fit90}`]);
  check(
    "横置后适应比例变小（横向占位变长，整幅图必须缩得更小才放得下）",
    fit90 < fit0,
    [`${fit0} → ${fit90}`]
  );
  check(
    "横置后由宽度决定（比例 == 可用宽 / 旋转后的宽）",
    Math.abs(fit90 - AVAIL.w / NAT.h) < 1e-12,
    [`实际：${fit90} vs ${AVAIL.w / NAT.h}`]
  );

  // 关键：转 90° 后，画框必须放得进可视区。
  api.rotation.value = 90;
  const g = api.imageGeometry.value;
  check(
    "转 90° 后画框宽度 ≤ 可用宽（没溢出面板）",
    g.w <= AVAIL.w,
    [`画框宽 ${g.w} vs 可用宽 ${AVAIL.w}`]
  );
  check("转 90° 后画框高度 ≤ 可用高", g.h <= AVAIL.h, [`画框高 ${g.h} vs 可用高 ${AVAIL.h}`]);
}

section("6. 缩放档位下旋转不改变画面本体的尺寸（比例是相对原始像素的）");

{
  api.zoomMode.value = "manual";
  api.zoomScale.value = 1;
  api.rotation.value = 0;
  const picFull = { ...api.pictureStyle.value };
  check("1:1 时画面本体是原始像素", picFull.width === `${NAT.w}px` && picFull.height === `${NAT.h}px`);

  api.rotation.value = 90;
  const picRot = { ...api.pictureStyle.value };
  check(
    "转 90° 后画面本体的尺寸不变（旋转不改变清晰度）",
    picRot.width === picFull.width && picRot.height === picFull.height,
    [`实际：${picRot.width}×${picRot.height}`]
  );
  check(
    "但画框的占位换了（滚动范围跟着换）",
    api.imageGeometry.value.w === NAT.h && api.imageGeometry.value.h === NAT.w,
    [`实际：${api.imageGeometry.value.w}×${api.imageGeometry.value.h}`]
  );

  api.zoomMode.value = "fit";
  api.rotation.value = 0;
}

section("7. 旋转后滚动量归零（占位变了，旧的滚动位置不再对应同一块内容）");

{
  api.rotation.value = 0;
  SCROLL.scrollLeft = 120;
  SCROLL.scrollTop = 300;
  api.rotateRight();
  check("旋转后 scrollLeft 归零", SCROLL.scrollLeft === 0, [`实际：${SCROLL.scrollLeft}`]);
  check("旋转后 scrollTop 归零", SCROLL.scrollTop === 0, [`实际：${SCROLL.scrollTop}`]);
}

section("8. 角度标签：270° 显示成 -90°（逆时针更符合直觉）");

{
  api.rotation.value = 270;
  check("270° 的标签是 -90°", angleLabel(api.rotation.value) === "-90°");
  api.rotation.value = 90;
  check("90° 的标签是 90°", angleLabel(api.rotation.value) === "90°");
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
