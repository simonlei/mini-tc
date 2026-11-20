// 图片旋转的判据：纯函数表 + 静态接线断言。
// 直接 `node scripts/image-rotate-check.mjs` 跑。
// 变异臂：`node scripts/image-rotate-mutation.mjs`（每个变异都应 FAIL）。
//
// ── 这个功能是什么 ────────────────────────────────────────────────────
// 图片预览里左转 / 右转 90°。**只影响显示**：不写文件、不改 EXIF、不落盘，
// 关掉预览就复原。用户要的是「能转」，所以判据盯的是「真的转了、且没落盘」。
//
// ── 三层断言 ───────────────────────────────────────────────────────
//   ① 纯逻辑：import 生产 src/imageRotate.js，跑真值表（角度归一/步进/
//      占位互换/点旋转/角度标签）
//   ② 静态接线：组件真的用了这个模块、真的把 transform 写到画面上、
//      真的按**旋转后**的占位算「适应窗口」与居中偏移、真的不碰磁盘
//   ③ 变异臂：每个变异都应 FAIL —— 确认断言有分辨力，不是恒真
//
// 判据的锚点是**生产代码本身**（import src/imageRotate.js），不是副本。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROTATE_STEP,
  ROTATIONS,
  normalizeRotation,
  rotateStep,
  rotatedSize,
  rotatePoint,
  angleLabel,
} from "../src/imageRotate.js";
import { COMMANDS, SCOPES, matches, bindingsOf, computeConflicts } from "../src/shortcuts.js";
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
// 与 scripts/image-drag-check.mjs 同名辅助函数一致。
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
const PHOTO = { w: 4032, h: 3024 };
const LONG = { w: 572, h: 7191 };

section("1. normalizeRotation：角度归一");

{
  check("0° 归一后还是 0", normalizeRotation(0) === 0);
  check("90° 归一后还是 90", normalizeRotation(90) === 90);
  check("180° 归一后还是 180", normalizeRotation(180) === 180);
  check("270° 归一后还是 270", normalizeRotation(270) === 270);
  check("360° 归一回 0（转满一圈等于没转）", normalizeRotation(360) === 0);
  check("-90° 归一成 270（CSS 里 -90 === 270）", normalizeRotation(-90) === 270);
  check("-270° 归一成 90", normalizeRotation(-270) === 90);
  check("45° 吸附到 90（只允许 90 的整数倍）", normalizeRotation(45) === 90);
  check("-45° 吸附到 0", normalizeRotation(-45) === 0);
  check("NaN → 0（NaN 会顺着样式流到 DOM，图片直接不显示）", normalizeRotation(NaN) === 0);
  check("Infinity → 0", normalizeRotation(Infinity) === 0);
  check("undefined → 0", normalizeRotation(undefined) === 0);
  check("归一后永远落在合法集合里",
    ROTATIONS.every((r) => normalizeRotation(r) === r));
}

section("2. rotateStep：走一步（右转 +90 / 左转 −90）");

{
  check("右转一步 = 90°", rotateStep(0, 1) === 90);
  check("再右转一步 = 180°", rotateStep(90, 1) === 180);
  check("转满四步回到 0°", rotateStep(270, 1) === 0);
  check("左转一步 = 270°（存成 270 而不是 -90）", rotateStep(0, -1) === 270);
  check("左转两步 = 180°", rotateStep(270, -1) === 180);
  check("方向为 0 → 角度不变", rotateStep(90, 0) === 90);
  check("方向非法 → 角度不变", rotateStep(90, NaN) === 90);
  check("当前角度非法 → 先归一再走", rotateStep(NaN, 1) === 90);
  check("步长就是 90°", ROTATE_STEP === 90);
  // 对照臂：左右转反了的话这两个值会互换。
  check("对照臂：左右转确实不同（断言有分辨力）",
    rotateStep(0, 1) !== rotateStep(0, -1));
}

section("3. rotatedSize：旋转后的画面占位（90°/270° 宽高互换）");

{
  const r90 = rotatedSize(PHOTO.w, PHOTO.h, 90);
  check("90° → 宽高互换", r90.w === PHOTO.h && r90.h === PHOTO.w);
  const r270 = rotatedSize(PHOTO.w, PHOTO.h, 270);
  check("270° → 宽高互换", r270.w === PHOTO.h && r270.h === PHOTO.w);
  const r180 = rotatedSize(PHOTO.w, PHOTO.h, 180);
  check("180° → 宽高不变（只是上下颠倒）", r180.w === PHOTO.w && r180.h === PHOTO.h);
  const r0 = rotatedSize(PHOTO.w, PHOTO.h, 0);
  check("0° → 宽高不变", r0.w === PHOTO.w && r0.h === PHOTO.h);
  check("长图转 90° 后变成横的", rotatedSize(LONG.w, LONG.h, 90).w === LONG.h);
  check("尺寸缺失时原样返回（不产生新 NaN，也不吞掉已有的）",
    Number.isNaN(rotatedSize(NaN, 10, 90).w) && rotatedSize(NaN, 10, 90).h === 10);
  check("角度非法时按 0 处理", rotatedSize(100, 50, NaN).w === 100);
  check("两次旋转回到原尺寸（180°）",
    rotatedSize(rotatedSize(PHOTO.w, PHOTO.h, 90).w, rotatedSize(PHOTO.w, PHOTO.h, 90).h, 90).w === PHOTO.w);
}

section("4. rotatePoint：按 CSS 的 rotate() 旋转一个点");

{
  // CSS 的 rotate(正角度) 是**顺时针**（屏幕坐标 y 向下）。
  const p = rotatePoint(1, 0, 90);
  check("rotate(90°) 把 +x 轴指向 +y（屏幕上就是顺时针）", p.x === 0 && p.y === 1);
  const q = rotatePoint(0, 1, 90);
  check("rotate(90°) 把 +y 轴指向 -x", q.x === -1 && q.y === 0);
  const half = rotatePoint(1, 0, 180);
  check("rotate(180°) 把 +x 指向 -x", half.x === -1 && half.y === 0);
  const ccw = rotatePoint(1, 0, 270);
  check("rotate(270°) 把 +x 指向 -y", ccw.x === 0 && ccw.y === -1);
  check("0° 不动", rotatePoint(3, 4, 0).x === 3 && rotatePoint(3, 4, 0).y === 4);
  check("长度守恒（旋转不改变距离）",
    Math.abs(Math.hypot(...Object.values(rotatePoint(3, 4, 90))) - 5) < 1e-12);
}

section("5. angleLabel：给人看的角度标签");

{
  check("0° → \"0°\"", angleLabel(0) === "0°");
  check("90° → \"90°\"", angleLabel(90) === "90°");
  check("180° → \"180°\"", angleLabel(180) === "180°");
  check("270° → \"-90°\"（逆时针 90° 更符合直觉）", angleLabel(270) === "-90°");
  check("非法角度 → \"0°\"", angleLabel(NaN) === "0°");
}

section("6. 静态接线：组件真的用了这个模块");

{
  check("FilePreview.vue 从 imageRotate.js 导入",
    /from\s*["']\.\.\/imageRotate\.js["']/.test(src));
  check("导入了 rotateStep", /import\s*\{[^}]*rotateStep[^}]*\}/.test(src));
  check("导入了 rotatedSize", /import\s*\{[^}]*rotatedSize[^}]*\}/.test(src));
  check("导入了 angleLabel", /import\s*\{[^}]*angleLabel[^}]*\}/.test(src));

  // 旋转状态：0 / 90 / 180 / 270 的整数档。
  check("组件有 rotation 状态", /const\s+rotation\s*=\s*ref\(0\)/.test(src));
  check("旋转档位只走 90° 的整数倍",
    /rotateStep\(/.test(src) && /ROTATE_STEP|90/.test(src));

  // 画面本体的 transform 必须真的带上角度 —— 不写就没转。
  const pictureBody = bodyOf(src, "const pictureStyle = computed(() => {");
  check("画面本体写了 transform: rotate(...)",
    /transform:\s*`[^`]*rotate\(\$\{rotation\.value\}deg\)[^`]*`/.test(pictureBody),
    [pictureBody.slice(0, 400)]);
  check("画面本体的尺寸用的是**未旋转**的 pw/ph",
    /\$\{g\.pw\}px/.test(pictureBody) && /\$\{g\.ph\}px/.test(pictureBody));
  check("画面本体的 transform 里带着居中平移",
    /translate\(-50%,\s*-50%\)/.test(pictureBody));

  // 画框的尺寸 = 旋转后的占位（滚动范围、居中偏移都按它算）。
  const frameBody = bodyOf(src, "const frameStyle = computed(() => {");
  check("画框用的是旋转后的占位 w/h", /\$\{g\.w\}px/.test(frameBody) && /\$\{g\.h\}px/.test(frameBody));
  check("画框保留居中偏移 margin",
    /marginLeft:\s*`\$\{g\.mx\}px`/.test(frameBody));

  // 几何只有一处：占位换算走生产的 rotatedSize。
  const geoBody = bodyOf(src, "function geometryFor(scale) {");
  check("几何计算里用了生产 rotatedSize 换算占位",
    /rotatedSize\(pw,\s*ph,\s*rotation\.value\)/.test(geoBody));
  check("居中偏移按旋转后的占位算（用 w/h 而不是 pw/ph）",
    /Math\.floor\(\(avail\.w\s*-\s*w\)\s*\/\s*2\)/.test(geoBody));
  check("画面本体的 pw/ph 与占位的 w/h 分开返回（三个尺寸各司其职）",
    /return\s*\{\s*w,\s*h,\s*mx,\s*my,\s*pw,\s*ph\s*\}/.test(geoBody));

  // 「适应窗口」必须按旋转后的占位算，否则横图会溢出面板。
  check("适应窗口按旋转后的自然尺寸算",
    /computeFitScale\(\s*rotatedNatural\.value\.w,\s*rotatedNatural\.value\.h/.test(src));
  check("有 rotatedNatural（旋转后的自然占位）",
    /const\s+rotatedNatural\s*=\s*computed\(/.test(src));

  // 旋转动作：走一步 + 结束拖动 + 滚动归零。
  const byBody = bodyOf(src, "function rotateBy(dir) {");
  check("旋转调用生产 rotateStep", /rotateStep\(rotation\.value,\s*dir\)/.test(byBody));
  check("旋转时结束拖动（手势与状态变更不并行）", /endImageDrag\(\)/.test(byBody));
  check("旋转后滚动归零（占位变了，旧位置不再对应同一块内容）",
    /scrollLeft\s*=\s*0/.test(byBody) && /scrollTop\s*=\s*0/.test(byBody));
  check("实现了 rotateLeft", /function rotateLeft\s*\(/.test(src));
  check("实现了 rotateRight", /function rotateRight\s*\(/.test(src));
  check("左转传的是 -1（逆时针）", /rotateBy\(-1\)/.test(src));
  check("右转传的是 +1（顺时针）", /rotateBy\(1\)/.test(src));

  // 换文件复位：与缩放一致。
  check("换文件时重置旋转", /resetRotation\(\);/.test(src));
  check("resetRotation 把角度放回 0",
    /function resetRotation\(\)\s*\{[^}]*rotation\.value\s*=\s*0/s.test(src));

  // 模板上真的有按钮。
  check("模板有左转按钮", /@click="rotateLeft"/.test(src));
  check("模板有右转按钮", /@click="rotateRight"/.test(src));
  check("模板只在图片预览时显示旋转按钮",
    /class="rot-group"[^>]*v-if="previewType === 'image'/.test(src));
  check("模板显示当前角度", /angleLabel\(rotation\)/.test(src));
}

section("7. 只影响显示：不写文件、不改 EXIF、不落盘");

{
  // 旋转相关的四个函数里**不允许**出现任何磁盘 / 后端调用。
  const bodies = [
    bodyOf(src, "function rotateBy(dir) {"),
    bodyOf(src, "function rotateLeft() {"),
    bodyOf(src, "function rotateRight() {"),
    bodyOf(src, "function resetRotation() {"),
  ].join("\n");
  check("旋转函数里没有 invoke（不碰后端）", !/\binvoke\(/.test(bodies));
  check("旋转函数里没有写文件调用", !/\bwrite\b|\bsave\b|writeFile|saveFile/i.test(bodies));
  check("旋转函数里没有 EXIF / 元数据处理", !/exif/i.test(bodies));

  // 更强的一条：整个组件里都不该有「保存图片」这种入口 ——
  // 旋转是显示层的事，加了保存入口就意味着需求跑偏了。
  check("组件里没有「保存旋转后的图」这类入口",
    !/保存旋转|保存图片|saveRotated|exportRotated/i.test(src));
}

section("8. 快捷键：注册在表里，且键名真的能匹配上");

{
  const cmdL = COMMANDS.find((c) => c.id === "image.rotateLeft");
  const cmdR = COMMANDS.find((c) => c.id === "image.rotateRight");
  check("image.rotateLeft 已注册", !!cmdL);
  check("image.rotateRight 已注册", !!cmdR);
  check("两个命令都归 image 作用域",
    cmdL?.scope === "image" && cmdR?.scope === "image");
  check("SCOPES 里有 image 作用域（设置对话框里能看到这组）",
    SCOPES.some((s) => s.key === "image"));
  check("默认键是 Ctrl+← / Ctrl+→",
    cmdL?.defaults?.[0] === "Ctrl+ArrowLeft" && cmdR?.defaults?.[0] === "Ctrl+ArrowRight");

  // 真实键盘事件的形状：方向键的规范名来自 e.code。
  const ev = (o) => ({
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    key: "", code: "", ...o,
  });
  check("Ctrl+← 命中 image.rotateLeft",
    matches("image.rotateLeft", ev({ code: "ArrowLeft", key: "ArrowLeft", ctrlKey: true })));
  check("Ctrl+→ 命中 image.rotateRight",
    matches("image.rotateRight", ev({ code: "ArrowRight", key: "ArrowRight", ctrlKey: true })));
  check("裸方向键不命中（裸方向键是文件列表的上下移动，不能抢）",
    !matches("image.rotateLeft", ev({ code: "ArrowLeft", key: "ArrowLeft" })));
  check("裸方向键也不命中右转",
    !matches("image.rotateRight", ev({ code: "ArrowRight", key: "ArrowRight" })));

  // 组件真的认领了这两条命令。
  check("组件认领 image.rotateLeft", /matches\(\s*["']image\.rotateLeft["']/.test(src));
  check("组件认领 image.rotateRight", /matches\(\s*["']image\.rotateRight["']/.test(src));
  check("认领后调用 markHandled（全局 handler 不再重复处理）", /markHandled\(e\)/.test(src));

  // 与其它命令不冲突。
  const conflicts = computeConflicts(bindingsOf);
  let conflictErrors = 0;
  for (const r of conflicts.values()) conflictErrors += r.errors.length;
  check("新快捷键不与任何命令冲突", conflictErrors === 0);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("全部通过");
