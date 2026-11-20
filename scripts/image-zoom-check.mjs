// 图片缩放的判据：纯函数表 + 静态接线断言 + 变异臂。
// 直接 `node scripts/image-zoom-check.mjs` 跑。
// 变异臂：`node scripts/image-zoom-mutation.mjs`（每个变异都应 FAIL）。
//
// 为什么要单独一个模块：缩放比例与锚点补偿是纯算术，放进 .vue 就只能
// 靠「看起来对不对」验证。这里的每一行都是可测的判据：
//   ① 比例计算（适应窗口 / 步进 / 滚轮 / 钳制）
//   ② 锚点补偿（缩放后光标下的那一点内容不许跑掉）
//   ③ 静态接线（组件真的用了这个模块，且封顶在原始大小）
//
// 判据的锚点是**生产代码本身**（import src/imageZoom.js），不是副本 ——
// 抄一份进来测，测的就不是线上跑的那份了。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitScale,
  clampScale,
  zoomStep,
  wheelScale,
  zoomPercent,
  anchorScroll,
  MAX_SCALE,
  ZOOM_RUNGS,
} from "../src/imageZoom.js";
import { COMMANDS, SCOPES, matches, bindingsOf, computeConflicts } from "../src/shortcuts.js";
import mod from "./stripComments.cjs";

const { stripComments } = mod;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = path.join(ROOT, "src", "components", "FilePreview.vue");
const src = stripComments(fs.readFileSync(PREVIEW, "utf8"));

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}
function section(t) {
  console.log(`\n── ${t}`);
}

// 真实场景的尺寸：用户报的那张微信长图 572×7191。
const LONG = { w: 572, h: 7191 };
// 一个窄面板（双栏各占一半时的预览区大概这么大）。
const PANEL = { w: 360, h: 620 };
// 一张普通照片。
const PHOTO = { w: 4032, h: 3024 };

section("1. fitScale：适应窗口");

{
  const s = fitScale(LONG.w, LONG.h, PANEL.w, PANEL.h);
  // 长图受高度约束：620/7191 ≈ 0.0862，宽度还远富余。
  check("长图按高度适配", Math.abs(s - 620 / 7191) < 1e-12);
  check("长图适配后宽度小于面板（没被拉宽）", LONG.w * s < PANEL.w);
  check("长图适配后高度正好等于面板高", Math.abs(LONG.h * s - PANEL.h) < 1e-9);

  const p = fitScale(PHOTO.w, PHOTO.h, PANEL.w, PANEL.h);
  check("普通照片按宽度适配", Math.abs(p - PANEL.w / PHOTO.w) < 1e-12);

  check("小图不放大（超过 1 就钳到 1）", fitScale(100, 100, PANEL.w, PANEL.h) === 1);
  check("尺寸缺失时返回 1（不返回 0/NaN）", fitScale(0, 0, PANEL.w, PANEL.h) === 1);
  check("可用区缺失时返回 1", fitScale(LONG.w, LONG.h, 0, 0) === 1);
  check("NaN 输入不炸", Number.isFinite(fitScale(NaN, NaN, 10, 10)));
}

section("2. clampScale：钳制");

{
  check("超出上界被钳到 max", clampScale(5, 0.1, 1) === 1);
  check("低于下界被钳到 min", clampScale(0.01, 0.1, 1) === 0.1);
  check("区间内原样返回", clampScale(0.5, 0.1, 1) === 0.5);
  check("NaN 落到 min（不是 NaN）", clampScale(NaN, 0.1, 1) === 0.1);
  check("Infinity 被钳到 max", clampScale(Infinity, 0.1, 1) === 1);
  check("-Infinity 被钳到 min", clampScale(-Infinity, 0.1, 1) === 0.1);
  // min > max 的畸形区间：必须收敛到区间内，不能返回区间外的数。
  const weird = clampScale(0.5, 2, 1);
  check("min>max 时返回合法值", weird >= 1 && weird <= 2);
}

section("2b. MAX_SCALE：缩放上限就是原始大小");

{
  // 静态断言（"组件导入了 MAX_SCALE"）抓不住**值**被改大 ——
  // 把 MAX_SCALE 改成 2，组件照样导入、照样用它，只是上限变成了 200%。
  // 「最多原始大小」是需求，所以这里必须钉住值本身。
  check("MAX_SCALE === 1（1 = 100% = 原始像素大小）", MAX_SCALE === 1);
  check("滚轮放大到顶也只到 100%", wheelScale(1, -10000, 0, MAX_SCALE) === 1);
  check("按钮放大到顶也只到 100%", zoomStep(0.99, 1, 0.1) === 1);
}

section("3. zoomStep：按钮档位（相对原始像素的固定档）");

{
  const fit = fitScale(LONG.w, LONG.h, PANEL.w, PANEL.h);
  // 长图在窄面板里「适应窗口」只有 8.6%，从那里按倍率爬到 100% 要十几次；
  // 固定档位（25/50/75/100%）四步就到。
  check("放大一档 = 下一档 25%", zoomStep(fit, 1, fit) === 0.25);
  check("再放大 = 50%", zoomStep(0.25, 1, fit) === 0.5);
  check("再放大 = 75%", zoomStep(0.5, 1, fit) === 0.75);
  check("再放大 = 100%（原始大小）", zoomStep(0.75, 1, fit) === 1);
  check("到顶后不再往上", zoomStep(1, 1, fit) === 1);

  check("缩小一档 = 上一档 50%", zoomStep(0.75, -1, fit) === 0.5);
  check("从 25% 再缩 → 回到适应窗口", zoomStep(0.25, -1, fit) === fit);
  check("档位严格递增", ZOOM_RUNGS.every((r, i) => i === 0 || r > ZOOM_RUNGS[i - 1]));
  check("最高档就是原始大小", ZOOM_RUNGS[ZOOM_RUNGS.length - 1] === MAX_SCALE);

  // 从长图的适应比例一路放大，必须能到 100%，且步数很少。
  let s = fit;
  let steps = 0;
  while (s < MAX_SCALE - 1e-9 && steps < 20) {
    s = zoomStep(s, 1, fit);
    steps++;
  }
  check("长图能放大到 100%", s >= MAX_SCALE - 1e-9);
  check("到 100% 只需个位数步", steps > 0 && steps <= 6);
}

section("4. wheelScale：Ctrl+滚轮连续缩放");

{
  const fit = fitScale(LONG.w, LONG.h, PANEL.w, PANEL.h);
  check("向上滚 = 放大", wheelScale(0.5, -100, 0.05, 1) > 0.5);
  check("向下滚 = 缩小", wheelScale(0.5, 100, 0.05, 1) < 0.5);
  check("一格滚轮约放大 10%", Math.abs(wheelScale(0.5, -100, 0.05, 1) - 0.55) < 1e-12);
  check("放大不会超过 100%（原始大小是上限）", wheelScale(1, -1000, 0, 1) === 1);
  check("缩小不会低于适应窗口", wheelScale(fit, 1000, fit, 1) === fit);
  check("deltaY=0 不改变比例", wheelScale(fit, 0, fit, 1) === fit);
  check("deltaY 非法不改变比例", wheelScale(fit, NaN, fit, 1) === fit);
}

section("5. zoomPercent：百分比显示");

{
  check("100% 显示为 100%", zoomPercent(1) === "100%");
  check("8.6% 显示为 9%", zoomPercent(0.0862) === "9%");
  check("非法值给占位符而不是 NaN%", zoomPercent(NaN) === "—");
}

section("6. anchorScroll：缩放后光标下的内容不许跑掉");

{
  // 场景：图片左边缘在视口 x=100，宽 200；光标在 x=150（图片正中偏左）。
  const before = { left: 100, top: 200, width: 200, height: 100 };
  const cursor = { x: 150, y: 250 };
  const scroll = { left: 0, top: 0 };

  // 放大到 2 倍：图片左边缘仍在 100（CSS 里没动位置），宽变 400。
  const after = { left: 100, top: 200, width: 400, height: 200 };
  const next = anchorScroll({ before, after, cursor, scroll });

  // 光标压在图片的 25% 处（(150-100)/200）。放大后这一点在图片里的
  // 位置是 100 + 0.25*400 = 200，而光标在 150 —— 图片得整体左移 50px，
  // 也就是滚动量 +50（内容左移 = 滚动量变大）。
  check("横向滚动量补偿正确", Math.abs(next.left - 50) < 1e-9);
  check("纵向滚动量补偿正确", Math.abs(next.top - 50) < 1e-9);

  // 对照臂：完全不补偿（老实现 = 直接用旧滚动量）会让内容跑掉。
  const naive = scroll;
  check("对照臂：不补偿就会跑掉（所以这段代码不是摆设）",
    Math.abs(naive.left - next.left) > 1);

  // 缩小一半：图片宽 100，光标仍在 x=150（在图片右侧之外）。
  const after2 = { left: 100, top: 200, width: 100, height: 50 };
  const next2 = anchorScroll({ before, after: after2, cursor, scroll });
  check("缩小时也补偿", Number.isFinite(next2.left) && Number.isFinite(next2.top));

  // 尺寸为 0（图片还没加载）时不得崩。
  const zero = anchorScroll({
    before: { left: 0, top: 0, width: 0, height: 0 },
    after: { left: 0, top: 0, width: 0, height: 0 },
    cursor,
    scroll,
  });
  check("尺寸为 0 时不产生 NaN", Number.isFinite(zero.left) && Number.isFinite(zero.top));
  check("尺寸为 0 时保持原滚动量", zero.left === scroll.left && zero.top === scroll.top);
}

section("7. 静态接线：组件真的用了这个模块");

{
  check("FilePreview.vue 从 imageZoom.js 导入", /from\s*["']\.\.\/imageZoom\.js["']/.test(src));
  check("导入了 fitScale", /import\s*\{[^}]*fitScale\s+as\s+computeFitScale[^}]*\}/.test(src));
  check("导入了 anchorScroll", /import\s*\{[^}]*anchorScroll[^}]*\}/.test(src));
  check("导入了 MAX_SCALE（封顶在原始大小）", /import\s*\{[^}]*MAX_SCALE[^}]*\}/.test(src));

  check("缩放上限用的是 MAX_SCALE，不是写死的 1",
    /MAX_SCALE/.test(src) && !/=\s*1\.0\s*;\s*\/\/\s*最大/.test(src));
  check("放大到 100% 用 MAX_SCALE", /applyZoom\(MAX_SCALE/.test(src));

  // 放大档必须解除 max-height:100%，否则长图被压回容器高度，缩放等于没做；
  // 适应窗口档则要保留 max-* 兜底（测量晚一帧也不至于溢出）。
  check("放大档解除 max-width/max-height",
    /maxWidth:\s*fit\s*\?\s*["']100%["']\s*:\s*["']none["']/.test(src) &&
    /maxHeight:\s*fit\s*\?\s*["']100%["']\s*:\s*["']none["']/.test(src));
  check("适应窗口档保留 max-* 兜底（测量晚一帧也不溢出）",
    /maxWidth:\s*fit\s*\?/.test(src) && /maxHeight:\s*fit\s*\?/.test(src));

  // 居中必须用**显式像素 margin**，不能用 flex 的 margin:auto ——
  // 那套在内容溢出容器时会让溢出的那一侧滚不到（长图顶部够不着）。
  //
  // ⚠️ 几何计算只有**一处**（imageGeometry）：imageStyle 与 contentSize
  // 都从它派生。同一语义两份实现必然分叉 —— 曾经 contentSize 把这段抄了
  // 一遍，导致下面「居中偏移算错」的变异命中 2 处、注入不进去。
  check("居中用显式像素 margin", /marginLeft:\s*`\$\{g\.mx\}px`/.test(src));
  check("margin 是算出来的居中偏移", /const mx = Math\.max\(0, Math\.floor\(\(avail\.w - w\) \/ 2\)\)/.test(src));
  check("几何计算只有一处（imageGeometry 是唯一来源）",
    (src.match(/const mx = Math\.max\(0/g) || []).length === 1);
  check("contentSize 从 imageGeometry 派生（不自己再算一遍）",
    /const contentSize = computed\([\s\S]{0,200}?imageGeometry\.value/.test(src));

  // 缩放后必须能上下左右滚动 —— 滚动容器自己得是 overflow:auto，
  // 且不能是 flex 容器（flex 会裁掉溢出的起始侧）。
  check("滚动容器 overflow:auto（能上下滚）", /\.image-scroll\s*\{[^}]*overflow:\s*auto/s.test(src));
  check("滚动容器允许横向滚动（没写 overflow-x:hidden）",
    !/\.image-scroll\s*\{[^}]*overflow-x\s*:\s*hidden/s.test(src));
  check("滚动容器不是 flex 容器（否则溢出侧滚不到）",
    !/\.image-scroll\s*\{[^}]*display:\s*flex/s.test(src));
  check("滚动容器 min-width/min-height:0（否则撑破面板）",
    /\.image-scroll\s*\{[^}]*min-width:\s*0/s.test(src) &&
    /\.image-scroll\s*\{[^}]*min-height:\s*0/s.test(src));

  // 换文件要重置缩放。
  check("换文件时重置缩放", /resetZoom\(\);/.test(src));
  check("resetZoom 把档位放回 fit", /function resetZoom\(\)\s*\{[^}]*zoomMode\.value\s*=\s*["']fit["']/s.test(src));

  // Ctrl+滚轮缩放；普通滚轮留给浏览器自己滚动。
  check("Ctrl+滚轮缩放", /ctrlKey/.test(src) && /metaKey/.test(src));
  check("普通滚轮不被劫持", /if\s*\(!e\.ctrlKey\s*&&\s*!e\.metaKey\)\s*return;/.test(src));
  check("Shift+滚轮做横向滚动", /shiftKey/.test(src) && /scrollLeft\s*\+=/.test(src));
}

section("7b. 兜底那一帧必须与最终几何画出同一幅画面（否则会看到跳动）");

{
  // 几何要等两样东西：天然像素（只有 <img> 的 load 事件才知道）与可视区
  // 尺寸。在那之前图片走 CSS 兜底 —— 兜底必须和最终几何**画出同一幅画面**。
  //
  // ⚠️ 兜底**不能**用 object-fit:contain：contain 会**放大**小图并把它铺满
  // 盒子（Chromium 157 实测：10×10 的图在 200×200 盒子里被画成 200×200，
  // 角落像素是图的红而不是底色）。用户看到的就是「先占满面板、再缩回
  // 1:1」—— 那正是本次修的现象。上一版把兜底从 max-* 换成 contain 就是
  // 栽在这个前提上（注释里写着「contain does not upscale」，是错的）。
  //
  // 兜底要用 max-*：只封顶、不放大。小图保持 1:1（= 最终 fit 档的尺寸），
  // 大图按比例缩到刚好装下（也是最终 fit 档的尺寸）—— 两种都同画面。
  const styleSrc = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [null, ""])[1];
  // 取出某条 CSS 规则（选择器精确匹配）的声明体。
  // ⚠️ 不能直接正则扫全文：模板里的 Vue 绑定（:class="{ ... }"）也有花括号。
  function cssRule(css, selector) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sels = m[1].trim().split(/\s*,\s*/);
      if (sels.includes(selector)) return m[2];
    }
    return null;
  }
  const fb = cssRule(styleSrc, ".image-frame.fallback .preview-image");
  check("兜底规则存在（.image-frame.fallback .preview-image）", fb !== null);
  const fbBody = fb || "";
  check("兜底用 max-width/max-height（只封顶，不放大）",
    /max-width:\s*100%/.test(fbBody) && /max-height:\s*100%/.test(fbBody),
    [`兜底规则：${fbBody}`]);
  check("兜底盒尺寸交给图片自身（width:auto + height:auto，不是 100%）",
    /^\s*width:\s*auto/m.test(fbBody) && /^\s*height:\s*auto/m.test(fbBody) &&
    !/^\s*width:\s*100%/m.test(fbBody) && !/^\s*height:\s*100%/m.test(fbBody),
    [`兜底规则：${fbBody}`]);
  check("兜底不能用 object-fit:contain（会把小图放大铺满 → 先占满面板再缩小）",
    !/object-fit:\s*contain/.test(fbBody),
    [`兜底规则：${fbBody}`]);

  // 兜底态必须真的接在「几何算不出来」这个状态上 —— 规则再对，接线断了
  // 也等于没有（这正是上一次事故的形状：ref 绑不上，一切静默失效）。
  check("兜底态由几何算不出来驱动（geometryPending 看 imageGeometry）",
    /const geometryPending = computed\([\s\S]{0,120}?imageGeometry\.value/.test(src));
  check("画框接上了兜底态的 class",
    /class="image-frame"[^>]*:class="\{\s*fallback:\s*geometryPending\s*\}"/s.test(src));

  // 已知几何那一档，画面本体**不能**有 max-*：转 90° 时画面本体的盒子比
  // 画框大（盒子始终是未旋转的宽高），被 max-* 掐住就会被压扁变形。
  const picRule = cssRule(styleSrc, ".preview-image");
  check("已知几何那一档的画面本体没有 max-*（转 90° 会被压扁）",
    picRule !== null && !/max-width/.test(picRule) && !/max-height/.test(picRule),
    [`画面本体规则：${picRule}`]);
  check("画面本体带 object-fit:contain（盒与图比例万一不一致也不变形）",
    picRule !== null && /object-fit:\s*contain/.test(picRule),
    [`画面本体规则：${picRule}`]);

  // ⚠️ 反过来也不能把图片**藏起来**等几何就绪：那样虽然不跳，但用户要多等
  // 一到两帧才看到图（切换图片明显变慢）。兜底画对了就不用藏。
  check("图片不因几何未就绪而被藏起来（藏起来会让切换图片慢一帧）",
    !/pending:\s*!imageReady/.test(src) &&
    !/\.preview-image\.pending/.test(src) &&
    !/\.preview-image\s*\{[^}]*visibility:\s*hidden/s.test(src));
}

section("8. 快捷键：注册在表里，且键名真的能匹配上");

{
  // ⚠️ 键名必须与 eventKeyName 的产出**完全一致**才算数：
  // CODE_KEYS 把 Equal 映成 "="、Minus 映成 "-"、数字键落到 e.key（"0"/"1"）。
  // 写成 "Ctrl+Equal" 这种物理键名会永远匹配不上，而且**不会报错**
  // —— 快捷键静默失效，最难查的一类 bug。
  const cmdIn = COMMANDS.find((c) => c.id === "image.zoomIn");
  const cmdOut = COMMANDS.find((c) => c.id === "image.zoomOut");
  const cmdFit = COMMANDS.find((c) => c.id === "image.zoomFit");
  const cmdActual = COMMANDS.find((c) => c.id === "image.zoomActual");
  check("image.zoomIn 已注册", !!cmdIn);
  check("image.zoomOut 已注册", !!cmdOut);
  check("image.zoomFit 已注册", !!cmdFit);
  check("image.zoomActual 已注册", !!cmdActual);
  check("四个命令都归 image 作用域",
    cmdIn?.scope === "image" && cmdOut?.scope === "image" &&
    cmdFit?.scope === "image" && cmdActual?.scope === "image");

  // SCOPES 里必须有 image —— 快捷键设置对话框按 SCOPES 分组渲染，
  // 少登记这一条，用户就看不到也改不了这组快捷键。
  check("SCOPES 里有 image 作用域", SCOPES.some((s) => s.key === "image"));

  // 真实键盘事件的形状：e.code 是物理键，e.key 是字符。
  const ev = (o) => ({
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    key: "", code: "", ...o,
  });
  check("Ctrl+= 命中 image.zoomIn",
    matches("image.zoomIn", ev({ code: "Equal", key: "=", ctrlKey: true })));
  check("Ctrl+- 命中 image.zoomOut",
    matches("image.zoomOut", ev({ code: "Minus", key: "-", ctrlKey: true })));
  check("Ctrl+0 命中 image.zoomFit",
    matches("image.zoomFit", ev({ code: "Digit0", key: "0", ctrlKey: true })));
  check("Ctrl+1 命中 image.zoomActual",
    matches("image.zoomActual", ev({ code: "Digit1", key: "1", ctrlKey: true })));
  check("裸 = 不命中（修饰键必须精确匹配）",
    !matches("image.zoomIn", ev({ code: "Equal", key: "=" })));

  // 与其它作用域不冲突（同作用域内重复才是错误，跨作用域只是提示）。
  const conflicts = computeConflicts(bindingsOf);
  let conflictErrors = 0;
  for (const r of conflicts.values()) conflictErrors += r.errors.length;
  check("新快捷键不与任何命令冲突", conflictErrors === 0);

  // 组件真的认领了这些命令（而不是只登记在表里）。
  check("FilePreview.vue 从 shortcuts.js 导入 matches/markHandled",
    /import\s*\{[^}]*matches[^}]*markHandled[^}]*\}\s*from\s*["']\.\.\/shortcuts\.js["']/.test(src));
  check("FilePreview.vue 认领 image.zoomIn", /matches\(\s*["']image\.zoomIn["']/.test(src));
  check("FilePreview.vue 认领 image.zoomOut", /matches\(\s*["']image\.zoomOut["']/.test(src));
  check("FilePreview.vue 认领 image.zoomFit", /matches\(\s*["']image\.zoomFit["']/.test(src));
  check("FilePreview.vue 认领 image.zoomActual", /matches\(\s*["']image\.zoomActual["']/.test(src));
  check("认领后调用 markHandled（全局 handler 不再重复处理）",
    /markHandled\(e\)/.test(src));
  check("只在图片预览时认领（文本/PDF 预览按 Ctrl+= 无反应）",
    /if\s*\(previewType\.value\s*!==\s*["']image["']\)\s*return;/.test(src));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("全部通过");
