// 图片缩放的纯计算（无 DOM 依赖，可被 node 直接 import 做单测）。
//
// 为什么单独一个模块：这里全是算术（缩放比例、档位、锚点补偿），不碰 DOM。
// 组件里只负责「量尺寸」和「写样式」，公式全在这一个文件里 ——
// 同一语义的多个实现会分叉（METHODOLOGY.md），所以不做一份副本。
// 配套断言见 scripts/image-zoom-check.mjs。

/**
 * 缩放上限 = 原始大小（100%）。
 * 再往上就是插值放大，看不到任何新信息，只有糊 —— 需求就是「最多原始大小」。
 */
export const MAX_SCALE = 1;

/**
 * 放大的档位（相对原始像素）。
 *
 * 为什么是固定档位而不是连续倍率：长图（572×7191）在窄面板里「适应窗口」
 * 只有 8% 左右，从那里一路按比例爬到 100% 要按十几次；固定档位则
 * 「适应 → 25% → 50% → 75% → 100%」四步就到，且每一档都能预期。
 * 需要更细的粒度时用 Ctrl+滚轮（连续缩放）。
 */
export const ZOOM_RUNGS = [0.25, 0.5, 0.75, 1];

/**
 * 「适应窗口」时的比例：图片完整放进可用区域，且**不放大小图**
 * （与旧的 max-width/max-height:100% 行为一致 —— 小图原本也不放大）。
 *
 * 尺寸缺失时返回 1（按原始大小渲染），而不是 0 或 NaN。
 */
export function fitScale(natW, natH, availW, availH) {
  if (!natW || !natH || !availW || !availH) return 1;
  const s = Math.min(availW / natW, availH / natH);
  return s > 1 ? 1 : s;
}

/**
 * 把比例钳进 [min, max]。
 *
 * ⚠️ NaN 必须显式挡掉：`Math.min(max, NaN)` 是 NaN，钳制钳不住它
 * （METHODOLOGY.md 记着这个坑：真会流进来的脏值挡不住）。
 * ⚠️ min > max 的畸形区间也要能收敛到一个合法值，不能返回区间外的数。
 * ⚠️ 只有 NaN 落到 min；±Infinity 是「比任何界都大/小」，应当落到对应的一端。
 */
export function clampScale(scale, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (Number.isNaN(scale)) return lo;
  return Math.max(lo, Math.min(hi, scale));
}

/**
 * 走一档：dir > 0 放大，dir < 0 缩小。
 *
 * 放大：落到严格大于当前比例的下一档；已经到顶就留在顶（原始大小）。
 * 缩小：落到严格小于当前比例的最近一档；再往下没有档位了，就回到
 * 「适应窗口」（fit）—— 比适应窗口还小没有意义。
 */
export function zoomStep(scale, dir, fit) {
  if (dir > 0) {
    for (const r of ZOOM_RUNGS) if (r > scale + 1e-9) return r;
    return MAX_SCALE;
  }
  for (let i = ZOOM_RUNGS.length - 1; i >= 0; i--) {
    if (ZOOM_RUNGS[i] < scale - 1e-9) return ZOOM_RUNGS[i];
  }
  return fit;
}

/**
 * Ctrl+滚轮连续缩放：deltaY 为负（向上滚）= 放大，deltaY 为正 = 缩小。
 * deltaY 为 0 或非法 → 比例不变。
 */
export function wheelScale(scale, deltaY, min, max) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampScale(scale, min, max);
  const factor = Math.pow(1.1, -deltaY / 100);
  return clampScale(scale * factor, min, max);
}

/** 显示用的百分比（相对原始尺寸），非法值给占位符而不是 NaN%。 */
export function zoomPercent(scale) {
  if (!Number.isFinite(scale)) return "—";
  return `${Math.round(scale * 100)}%`;
}

/**
 * 缩放后把滚动位置挪回去，让锚点（鼠标位置 / 视口中心）下的那一点内容
 * 仍然停在锚点上 —— 否则长图一放大，锚点附近的内容会从视野里跳走。
 *
 * before / after：缩放前 / 缩放后图片元素的**视口**矩形
 *                （getBoundingClientRect 的 left/top/width/height）。
 *                after 必须在 DOM 按新尺寸重排之后测量。
 * cursor：锚点的视口坐标（鼠标位置或视口中心）。
 * scroll：**测量 after 那一刻**滚动容器的滚动量 —— 缩放改变了内容尺寸，
 *         浏览器可能已把滚动量夹到新范围内；after 与 scroll 必须取自
 *         同一时刻，否则算出来的偏移是错的。
 *
 * 推导（横向，纵向同理）：
 *   ① f = (cursor.x - before.left) / before.width
 *      —— 光标压在图片的哪个相对位置上（也就是哪个源像素）。
 *   ② 缩放后这个像素在内容坐标里的位置 = (after.left + scroll) + f * after.width
 *      （after.left 是视口坐标，加上 scroll 才是内容坐标）。
 *   ③ 要它仍停在光标处（视口 cursor.x），新的滚动量 =
 *      (after.left + scroll) + f * after.width - cursor.x。
 */
export function anchorScroll({ before, after, cursor, scroll }) {
  const out = { left: scroll.left, top: scroll.top };
  if (before.width > 0 && after.width > 0) {
    const f = (cursor.x - before.left) / before.width;
    out.left = scroll.left + after.left + f * after.width - cursor.x;
  }
  if (before.height > 0 && after.height > 0) {
    const f = (cursor.y - before.top) / before.height;
    out.top = scroll.top + after.top + f * after.height - cursor.y;
  }
  return out;
}
