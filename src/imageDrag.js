// 图片拖动平移的判定（纯逻辑，组件与测试共用同一份）。
//
// ── 为什么需要这个功能 ────────────────────────────────────────────────
// 图片放大到 1:1 之后，一张 572×7191 的长图在 360×620 的面板里横向溢出
// 212px、纵向溢出 6571px。滚动条能用，但长图上「按住图片拖一下」才是
// 看图软件（Windows 照片查看器 / 看图王 / Photoshop）的标准手势 ——
// 尤其在触控板上，两指滚动和拖动是同一套肌肉记忆。
//
// ── 这里回答什么 ──────────────────────────────────────────────────────
// 「这次指针移动算不算在拖」「拖完之后滚动量该是多少」。两者都是纯算术，
// 放在 plain node 可加载的模块里（而不是留在 .vue 里），组件与测试才能
// 共用同一份实现 —— 复制进测试等于测自己的副本。
//
// ⚠️ 为什么用 Pointer Events 而不是 mouse/touch 事件：
// 项目里的文件拖放与标签页排序都已经走 Pointer Events（见 src/tabDrag.js
// 的说明），这里跟着同一套走，不引入第三种手势通道。

/** 指针移动多少像素才算「在拖」而不是「在点」。 */
export const IMAGE_DRAG_START_THRESHOLD = 4;

/**
 * 判断这次指针移动是否已经越过「开始拖动」的阈值。
 *
 * ⚠️ 用**欧氏距离**而不是逐轴比较：斜着拖（两个轴都动一点）也算拖，
 * 逐轴比较的话斜拖会被判成没拖，手感很黏。逐轴比较还有一个更糟的
 * 后果：横向刚好差 3px、纵向差 50px 时，按逐轴会判「在拖」，可用户
 * 主观上是「竖着拖了一下」，横向那 3px 的抖动不该被当成意图。
 *
 * @param {number} dx  指针横坐标位移（当前 - 起点）
 * @param {number} dy  指针纵坐标位移（当前 - 起点）
 * @param {number} [threshold] 阈值，默认 IMAGE_DRAG_START_THRESHOLD
 * @returns {boolean}
 */
export function dragStarted(dx, dy, threshold = IMAGE_DRAG_START_THRESHOLD) {
  const x = Number(dx);
  const y = Number(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const t = Number.isFinite(threshold) ? threshold : IMAGE_DRAG_START_THRESHOLD;
  return Math.hypot(x, y) >= t;
}

/**
 * 拖动后新的滚动量。
 *
 * 语义：**图片跟着指针走**（抓图拖动的那只手）。指针往右移 10px，
 * 图片也往右移 10px —— 也就是视口里看到的内容往左移了 10px，
 * 所以滚动量要**减**去位移。
 *
 * ⚠️ 这里返回的是**未夹制**的值：交给浏览器去夹。浏览器的
 * scrollLeft/scrollTop 天然被夹在 [0, maxScroll] 内，自己再夹一遍
 * 只会引入第二份「最大值怎么算」的判断（而那个判断依赖布局，
 * 纯逻辑模块里算不出来）。组件那边直接赋值即可。
 *
 * @param {object} args
 * @param {number} args.startX   按下时的指针横坐标
 * @param {number} args.startY   按下时的指针纵坐标
 * @param {number} args.curX     当前指针横坐标
 * @param {number} args.curY     当前指针纵坐标
 * @param {number} args.startLeft 按下时的 scrollLeft
 * @param {number} args.startTop  按下时的 scrollTop
 * @returns {{left: number, top: number}} 新的滚动量
 */
export function dragScroll({ startX, startY, curX, curY, startLeft, startTop } = {}) {
  const sx = Number(startX) || 0;
  const sy = Number(startY) || 0;
  const cx = Number(curX) || 0;
  const cy = Number(curY) || 0;
  const sl = Number(startLeft) || 0;
  const st = Number(startTop) || 0;
  return {
    left: sl - (cx - sx),
    top: st - (cy - sy),
  };
}

/**
 * 当前尺寸下是否**可以**拖动（也就是内容溢出了可视区）。
 *
 * 没溢出时拖不动 —— 此时图片整张都在视野里，拖了也没地方去。
 * 顺带也用它来决定光标：可拖时给 grab，不可拖时保持默认。
 *
 * @param {object} args
 * @param {number} args.contentW  内容总宽（图片宽 + 左右外边距）
 * @param {number} args.contentH  内容总高
 * @param {number} args.viewW     可视区宽
 * @param {number} args.viewH     可视区高
 * @returns {boolean}
 */
export function canDrag({ contentW = 0, contentH = 0, viewW = 0, viewH = 0 } = {}) {
  const cw = Number(contentW) || 0;
  const ch = Number(contentH) || 0;
  const vw = Number(viewW) || 0;
  const vh = Number(viewH) || 0;
  if (vw <= 0 || vh <= 0) return false;
  return cw > vw || ch > vh;
}
