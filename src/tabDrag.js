// 标签页拖拽排序的判定（纯逻辑，组件与测试共用同一份）。
//
// ── 为什么需要这个功能 ────────────────────────────────────────────────
// 标签页的顺序以前只能靠「关掉后面每一个、再按新顺序重开」来改变 —— 顺序是
// 一个**只能靠破坏来修改**的东西。用户把手边正在用的目录挪到最前面时，
// 唯一的办法就是把其它标签页一个个关掉重开，历史、锁定锚点、排序方式全丢。
//
// ── 这里回答什么 ──────────────────────────────────────────────────────
// 「松手的时候，这个标签页该插到哪儿」：
//   指针在某个标签页的**左半边** → 插到它前面；
//   指针在**右半边**（含中线）   → 插到它后面。
// 下标的语义统一是「**去掉被拖的那个之后**的列表里的下标」，所以
// 「往前挪」和「往后挪」是同一个公式，不需要两套逻辑。
//
// 放在 plain node 可加载的模块里（而不是留在 .vue 里），组件与测试才能共用
// 同一份实现 —— 复制进测试等于测自己的副本。
//
// ⚠️ 为什么用 Pointer Events 而不是 HTML5 拖放（dragover / drop）：
// 应用内的文件拖放早已改走 `tauri://drag-*` + 原生 startNativeDrag，HTML5
// 的 dragover/drop 通道不再使用（见 .workbuddy/memory/FRONTEND.md）。
// 标签排序同理走 pointerdown / pointermove / pointerup，不依赖那条弃用的路。

/** 指针横向移动多少像素才算「在拖」而不是「在点」。 */
export const TAB_DRAG_START_THRESHOLD = 4;

/**
 * 算出被拖动的标签页应该插入到哪个位置。
 *
 * @param {object} args
 * @param {Array<{id: number|string, left: number, right: number}>} args.rects
 *   各标签页在视口里的横向范围，按**显示顺序**排列。被拖的那一个传不传都行
 *   （传了会被过滤掉）。
 * @param {number|string} args.dragId   被拖动的标签页 id
 * @param {number} args.pointerX        指针的视口横坐标
 * @returns {number} 插入下标 —— 语义是「去掉被拖的那个之后」的列表里的下标，
 *   取值范围 [0, 其它标签页个数]。
 */
export function planDropIndex({ rects = [], dragId = null, pointerX = 0 } = {}) {
  const list = Array.isArray(rects) ? rects : [];
  // 被拖的那个不能参与判定 —— 它自己会离开原来的位置，把它算进去等于
  // 「拖动的标签页自己决定自己插到哪」。
  const others = list.filter((r) => r && r.id !== dragId);
  if (!others.length) return 0;
  for (let i = 0; i < others.length; i++) {
    const mid = (others[i].left + others[i].right) / 2;
    // 严格小于：中线归右半边（插到它后面），跟「右半边 → 插到后面」一致。
    if (pointerX < mid) return i;
  }
  // 指针在最后一个标签页的右半边 → 插到最末尾。
  return others.length;
}

/**
 * 把某个标签页移到指定位置。
 *
 * @param {Array<{id: number|string}>} tabs  当前顺序
 * @param {number|string} dragId          被拖动的标签页 id
 * @param {number} toIndex                 插入下标（语义同 planDropIndex 的返回值）
 * @returns {Array} 新的顺序（元素还是同一批对象，只是换了位置）
 */
export function reorderTabs(tabs, dragId, toIndex) {
  const list = Array.isArray(tabs) ? tabs : [];
  const from = list.findIndex((t) => t && t.id === dragId);
  // 找不到这个标签页（顺序已经变了 / id 传错）→ 原样返回，不做任何改动。
  if (from === -1) return list.slice();
  const rest = list.filter((t) => t && t.id !== dragId);
  const n = Number(toIndex);
  // 下标越界要夹住：拖到最左/最右时算出来的下标可能等于数组长度，
  // 交给 splice 会被当成「插到末尾之外」而错位。
  const idx = Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), rest.length)) : 0;
  rest.splice(idx, 0, list[from]);
  return rest;
}

/**
 * 两个顺序是否一致（按标签页 id 逐个比）。
 * 用来判断「这次拖动其实什么都没变」—— 那就不该写盘、不该让界面闪一下。
 */
export function sameTabOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.id !== y.id) return false;
  }
  return true;
}
