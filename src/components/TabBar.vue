<template>
  <div class="tab-bar" ref="barEl">
    <!-- `locked` is a state marker only: the lock glyph carries the whole
         signal, so a locked tab gets no special background or underline. -->
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{
        active: tab.id === activeTabId,
        locked: !!tab.lockedPath,
        dragging: draggingId === tab.id,
        'drop-before': dropMarker.id === tab.id && dropMarker.side === 'before',
        'drop-after': dropMarker.id === tab.id && dropMarker.side === 'after',
      }"
      :data-tab-id="tab.id"
      :title="tabTitle(tab)"
      @pointerdown="onPointerDown($event, tab.id)"
      @click="onTabClick($event, tab.id)"
      @dragstart.prevent
      @contextmenu.prevent="$emit('tab-menu', { tabId: tab.id, x: $event.clientX, y: $event.clientY })"
      @auxclick="onAuxClick($event, tab.id)"
    >
      <span class="tab-icon">{{ tab.search ? "🔍" : "📁" }}</span>
      <span v-if="tab.lockedPath" class="tab-lock" title="已锁定">🔒</span>
      <span class="tab-name">{{ tabLabel(tab) }}</span>
      <button
        v-if="tabs.length > 1"
        class="tab-close"
        @click.stop="$emit('close-tab', tab.id)"
        title="关闭标签页 (Ctrl+W)"
      >
        ×
      </button>
    </div>
    <button class="tab-add" @click="$emit('add-tab')" title="新建标签页 (Ctrl+T)">
      +
    </button>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from "vue";
import { planDropIndex, TAB_DRAG_START_THRESHOLD } from "../tabDrag.js";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: [Number, String], default: 0 },
});

const emit = defineEmits(["switch-tab", "close-tab", "add-tab", "tab-menu", "reorder-tab"]);

// ── Drag to reorder ──────────────────────────────────────────────────
//
// 拖动排序走 **Pointer Events**（pointerdown / pointermove / pointerup），
// 不用 HTML5 的 dragover/drop：应用内的文件拖放早已改走 `tauri://drag-*` +
// 原生 startNativeDrag，那条 HTML5 通道不再使用（FRONTEND.md）。
//
// 「插到哪儿」的判定在 src/tabDrag.js —— 组件与测试共用同一份实现，
// 复制进测试等于测自己的副本。

const barEl = ref(null);
// 正在被拖动的标签页 id（拖动进行中）—— 模板要跟着它变，所以是 ref。
const draggingId = ref(null);
// 插入位置指示：插到第几个（去掉被拖的那个之后）。
const dropIndex = ref(-1);

// 拖动过程中的临时状态放在**普通变量**里，不进响应式系统：
// 被拖动的 DOM 元素一旦被 reactive() 包成 Proxy，再调 getBoundingClientRect()
// 在部分引擎里会抛 Illegal invocation（this 变成了 Proxy 而不是元素）。
let drag = null;
// 拖动结束后浏览器还会补一个 click —— 那是拖动的余波，不是「切换标签页」。
// 这个标记在下一次 pointerdown 时作废（新一轮手势不该被上一轮连累）。
let suppressClick = false;

// 插入位置指示落在哪个标签页的哪一侧。
const dropMarker = computed(() => {
  if (draggingId.value === null || dropIndex.value < 0) return { id: null, side: "" };
  const others = props.tabs.filter((t) => t.id !== draggingId.value);
  if (!others.length) return { id: null, side: "" };
  if (dropIndex.value < others.length) {
    return { id: others[dropIndex.value].id, side: "before" };
  }
  return { id: others[others.length - 1].id, side: "after" };
});

// 各标签页当前的横向范围（视口坐标）。
// DOM 顺序 === tabs 顺序（v-for 就是按 tabs 渲染的），所以按下标配对即可，
// 不必往 DOM 上塞 id 属性再反查。
function tabRects() {
  const bar = barEl.value;
  if (!bar) return [];
  const els = bar.querySelectorAll(".tab");
  const out = [];
  for (let i = 0; i < els.length && i < props.tabs.length; i++) {
    const r = els[i].getBoundingClientRect();
    out.push({ id: props.tabs[i].id, left: r.left, right: r.right });
  }
  return out;
}

function onPointerDown(e, tabId) {
  // 新手势开始 → 上一轮遗留的「吞掉 click」标记作废。
  suppressClick = false;
  // 只有主键拖动：中键是关闭，右键是菜单。
  if (e.button !== 0) return;
  // 关闭按钮有自己的 click 处理，别把它当成拖动起点。
  if (e.target && typeof e.target.closest === "function" && e.target.closest(".tab-close")) return;
  // 一次只拖一个。
  if (drag) return;

  drag = {
    id: tabId,
    el: e.currentTarget,
    pointerId: e.pointerId == null ? 1 : e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
  };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.active) {
    // 横向移动超过阈值才算「在拖」：否则一次普通的点击会被吃掉。
    if (Math.abs(e.clientX - drag.startX) < TAB_DRAG_START_THRESHOLD) return;
    drag.active = true;
    draggingId.value = drag.id;
    // 抓住指针：拖出标签栏再松手也能收到 pointerup。
    try {
      if (drag.el && typeof drag.el.setPointerCapture === "function") {
        drag.el.setPointerCapture(drag.pointerId);
      }
    } catch {
      /* 抓不住也能拖：window 上的监听器照样收得到事件 */
    }
  }
  const idx = planDropIndex({
    rects: tabRects(),
    dragId: drag.id,
    pointerX: e.clientX,
  });
  if (idx !== dropIndex.value) dropIndex.value = idx;
}

function onPointerUp() {
  const d = drag;
  if (!d) return;
  const toIndex = dropIndex.value;
  const wasDragging = d.active;
  endDrag();
  // 没超过阈值 → 这是普通点击，交给 click 处理（切换标签页）。
  if (!wasDragging) return;
  suppressClick = true;
  emit("reorder-tab", { tabId: d.id, toIndex });
}

function onPointerCancel() {
  if (!drag) return;
  endDrag();
}

function endDrag() {
  const d = drag;
  drag = null;
  if (d && d.el && typeof d.el.releasePointerCapture === "function") {
    try {
      d.el.releasePointerCapture(d.pointerId);
    } catch {
      /* 释放失败无所谓：状态已经清干净了 */
    }
  }
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerCancel);
  draggingId.value = null;
  dropIndex.value = -1;
}

onBeforeUnmount(endDrag);

function onTabClick(e, tabId) {
  // 拖动结束后浏览器还会补一个 click —— 那是拖动的余波，不是「切换标签页」。
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  emit("switch-tab", tabId);
}

function tabLabel(tab) {
  // A search-results tab has no directory to name — label it after the query
  // instead, falling back to a generic marker while the scan is still empty.
  if (tab.search) {
    const scope = tab.search.content
      ? `${tab.search.pattern || "*"}+内容`
      : tab.search.pattern || "";
    return scope ? `🔍 ${scope}` : "搜索结果";
  }
  const path = tab.path || "";
  // Handle both / and \ separators
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "/";
  const last = parts[parts.length - 1];
  // For Windows drive roots like "C:" show "C:\"
  if (/^[a-zA-Z]:$/.test(last)) {
    return last + "\\";
  }
  return last;
}

// Hover tooltip: current dir, plus the lock anchor when locked so the user can
// see at a glance where Ctrl+Y will take them back.
function tabTitle(tab) {
  // Search tab: spell out the scope, the root and (while scanning) the fact
  // that more rows are still arriving.
  if (tab.search) {
    const s = tab.search;
    const lines = [
      `搜索：${s.pattern || "*"}${s.content ? ` 内容包含「${s.content}」` : ""}`,
      `根目录：${s.root}`,
      `${s.hits.length} 个结果${s.live ? "（搜索仍在进行…）" : ""}`,
    ];
    return lines.join("\n");
  }
  const path = tab.path || "";
  return tab.lockedPath ? `${path}\n🔒 已锁定：${tab.lockedPath}（Ctrl+Y 回到此处）` : path;
}

function onAuxClick(e, tabId) {
  // Middle click to close tab
  if (e.button === 1) {
    e.preventDefault();
    emit("close-tab", tabId);
  }
}
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 30px;
}

.tab-bar::-webkit-scrollbar {
  height: 2px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
  border-right: 1px solid var(--border);
  /* Every tab reserves the same 2px bottom border, so switching the active
     tab (which paints that border) never shifts the label by a pixel. */
  border-bottom: 2px solid transparent;
  background: var(--tab-bg);
  font-size: 12px;
  transition: background 0.15s;
  flex-shrink: 0;
  max-width: 200px;
}

.tab:hover {
  background: var(--tab-hover);
}

/* 拖动中的标签页：半透明 + grabbing 光标，让用户看得到「它正在被搬走」。 */
.tab.dragging {
  opacity: 0.45;
  cursor: grabbing;
}

/* 插入位置指示线：插到某个标签页前面 → 它左边的竖线；插到后面 → 右边的竖线。
   用 box-shadow（inset）而不是 border：border 会把标签页撑宽 2px，
   标签栏整体会跟着抖一下 —— 而标签栏的宽度一致性正是 tab-style 判据之一。 */
.tab.drop-before {
  box-shadow: inset 2px 0 0 var(--accent);
}

.tab.drop-after {
  box-shadow: inset -2px 0 0 var(--accent);
}

/* Current tab: the one and only "you are here" signal.
   Background carries the accent tint, the 2px underline doubles it, and the
   bold label makes it readable even where the tint is subtle (latte theme). */
.tab.active {
  background: var(--tab-active);
  border-bottom: 2px solid var(--accent);
}

.tab.active .tab-name {
  font-weight: 600;
}

/* Locked tab: no styling at all.
   "Locked" and "current" are orthogonal states, and the lock glyph already
   says "locked" — so the tab keeps the normal background and gets no
   underline. Painting anything here reads as "selected": the old tint was
   within dE 9 of the active tab, and a dashed underline added a second line
   that broke the tab strip's rhythm. The glyph is the whole signal. */
.tab-lock {
  font-size: 10px;
  flex-shrink: 0;
  filter: saturate(1.2);
}

.tab-icon {
  font-size: 13px;
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  padding: 0 2px;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  border-radius: 3px;
  margin-left: 2px;
}

.tab-close:hover {
  background: var(--danger);
  color: white;
}

.tab-add {
  padding: 4px 10px;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
}

.tab-add:hover {
  color: var(--accent);
  background: var(--hover);
}
</style>
