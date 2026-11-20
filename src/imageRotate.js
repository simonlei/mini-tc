// 图片旋转的纯计算（无 DOM 依赖，可被 node 直接 import 做单测）。
//
// 为什么单独一个模块：旋转牵涉三件事 ——
//   ① 「现在转到哪个角度」；
//   ② 「转完之后画面占多大」（90°/270° 时宽高互换）；
//   ③ 「屏幕上的一个点，反旋转回画面坐标后落在哪」——缩放的光标锚点
//      补偿（imageZoom.js 的 anchorScroll）要在**旋转后**的坐标系里算，
//      否则光标下的内容会跑掉。
// 这三件事必须只有一份实现：组件里的缩放几何（imageGeometry）要用
// **旋转后**的占位算「适应窗口」与居中偏移；一旦这里和组件各算一份，
// 同一语义的实现就会分叉（METHODOLOGY.md）。
//
// 角度约定：CSS 的 rotate(正角度) 是**顺时针**。所以「右转」= +90°，
// 「左转」= -90°（逆时针，规范化之后存成 270）。
//
// 配套断言见 scripts/image-rotate-check.mjs。

/** 一次转多少度。 */
export const ROTATE_STEP = 90;

/** 合法的旋转角度（CSS 角度，顺时针为正）。 */
export const ROTATIONS = [0, 90, 180, 270];

/**
 * 把任意角度规整到最近的合法值（0 / 90 / 180 / 270）。
 *
 * 非法输入（NaN / Infinity / 非数字）→ 0（不转），而不是 NaN：
 * NaN 会顺着样式一路流到 DOM 上，图片直接不显示。
 */
export function normalizeRotation(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  const snapped = Math.round(n / ROTATE_STEP) * ROTATE_STEP;
  return ((snapped % 360) + 360) % 360;
}

/**
 * 走一步：dir > 0 顺时针（右转），dir < 0 逆时针（左转）。
 *
 * dir 为 0 / 非法 → 角度不变。
 */
export function rotateStep(current, dir) {
  const c = normalizeRotation(current);
  const d = Number(dir);
  if (!Number.isFinite(d) || d === 0) return c;
  return normalizeRotation(c + (d > 0 ? ROTATE_STEP : -ROTATE_STEP));
}

/**
 * 旋转后的**画面占位**尺寸（宽高按视觉方向算）：
 *   90° / 270° → 宽高互换；
 *   0° / 180° → 不变（180° 只是上下颠倒）。
 *
 * 尺寸缺失 / 非法 → 原样返回，不产生 NaN。
 */
export function rotatedSize(w, h, deg) {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return { w, h };
  const r = normalizeRotation(deg);
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

/**
 * 把一个向量按 CSS 的 rotate(deg) 旋转（顺时针为正，屏幕坐标 y 向下）。
 *
 * 与 CSS 的旋转矩阵一致：rotate(90deg) 把 +x 轴指向 +y（屏幕上就是顺时针）。
 */
export function rotatePoint(x, y, deg) {
  switch (normalizeRotation(deg)) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}

/**
 * 给人看的角度标签：270° 其实是「逆时针 90°」，写成 -90° 更符合直觉。
 */
export function angleLabel(deg) {
  const r = normalizeRotation(deg);
  return `${r === 270 ? -90 : r}°`;
}
