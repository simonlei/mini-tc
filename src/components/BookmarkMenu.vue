<template>
  <!-- Dropdown is anchored to the star button; the full-screen overlay only
       exists to catch the outside click that dismisses it. -->
  <div class="bm-root" ref="rootRef">
    <!-- `☆` / `★` (U+2606 / U+2605), NOT the ⭐ emoji: an emoji is rendered by
         the colour font as a fixed colour glyph, so the `marked` state below
         (accent colour + accent border) would have no visible effect and every
         directory would look bookmarked. These are plain text glyphs and follow
         `color` / `currentColor` like the rest of the toolbar. -->
    <button
      class="path-btn bm-btn"
      :class="{ marked }"
      :title="marked ? '已加入书签（点击可打开列表）' : '目录书签 (Ctrl+D)'"
@click="onToggle"
    >{{ marked ? "★" : "☆" }}</button>

    <div v-if="open" class="bm-dropdown">
      <!-- Header: the current directory gets an explicit add / remove row so
           the dropdown is usable without memorising Ctrl+D. -->
      <div class="bm-head">
        <span class="bm-head-title">书签</span>
        <span v-if="currentPath" class="bm-current" :title="currentPath">{{ currentPath }}</span>
      </div>

      <div class="bm-list">
        <p v-if="!bookmarks.length" class="bm-empty">
          还没有书签。按 <kbd>Ctrl</kbd>+<kbd>D</kbd> 把当前目录加进来。
        </p>

        <div
          v-for="b in bookmarks"
          :key="b.id"
          class="bm-row"
          :class="{ dead: isDead(b.path), editing: editingId === b.id }"
          :title="deadTitle(b)"
          @click="onPick(b)"
          @contextmenu.prevent="onRowMenu(b, $event)"
        >
          <template v-if="editingId === b.id">
            <input
              ref="editInput"
              v-model="editName"
              class="bm-input"
              spellcheck="false"
              @click.stop
              @keydown.enter.stop="commitRename(b)"
              @keydown.esc.stop="cancelRename"
              @keydown.stop
              @blur="commitRename(b)"
            />
          </template>
          <template v-else>
            <span class="bm-star mark">★</span>
            <span class="bm-name">{{ b.name }}</span>
            <span class="bm-path">{{ leaf(b.path) }}</span>
          </template>
        </div>

        <!-- Recently visited directories, derived from the active tab's own
             history stack (Alt+← / Alt+→) — no separate config file, so it can
             never disagree with what Back/Forward actually walks. -->
        <template v-if="recent.length">
          <div class="bm-sep">最近访问</div>
          <div
            v-for="r in recent"
            :key="'recent-' + r"
            class="bm-row recent"
            :class="{ dead: isDead(r), current: samePath(r, currentPath) }"
            :title="deadTitle({ path: r })"
            @click="onPick({ path: r, name: leaf(r) })"
          >
            <!-- Plain-text glyph, not the 🕘 emoji: emoji ignore `color`, so this row
                 couldn't pick up the dimmed styling that distinguishes history
                 from real bookmarks. -->
            <span class="bm-star hist">◷</span>
            <span class="bm-name">{{ leaf(r) }}</span>
            <span class="bm-path">{{ r }}</span>
          </div>
        </template>
      </div>

      <div class="bm-foot">
        <button
          class="bm-foot-btn"
          :disabled="!currentPath || marked"
          :title="marked ? '当前目录已在书签中' : '把当前目录加入书签'"
          @click="addCurrent"
        >
          {{ marked ? "✓ 已在书签中" : "添加当前目录" }}
        </button>
        <span class="bm-foot-hint">右键书签可重命名 / 删除</span>
      </div>
    </div>

    <!-- Right-click menu on a single bookmark row -->
    <ContextMenu
      :visible="rowMenu.visible"
      :x="rowMenu.x"
      :y="rowMenu.y"
      :items="rowMenu.items"
      @close="rowMenu = { ...rowMenu, visible: false }"
      @select="onRowMenuSelect"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import ContextMenu from "./ContextMenu.vue";
import { pathExists } from "../api.js";
import { bookmarks, addBookmark, removeBookmark, renameBookmark, moveBookmark, claimMenuOwner, releaseMenuOwner, openMenuOwner } from "../bookmarks.js";
import { normDir } from "../paths.js";

const props = defineProps({
  // The panel's current directory — what Ctrl+D would bookmark.
  currentPath: { type: String, default: "" },
  // Most-recent-first list of real directories (from the tab's history stack).
  recent: { type: Array, default: () => [] },
});

const emit = defineEmits(["navigate", "notify"]);

const open = ref(false);
let ownerToken = null;

// Unique per component instance; `openMenuOwner` holds the token of whichever
// dropdown is currently open, so this one knows whether it is the visible one.
const rootRef = ref(null);

// ── Dead-path probing ──
// A bookmark whose directory was deleted (or whose drive was unmounted) must be
// visibly inert rather than silently navigating the panel into an error state.
// Probed once per open — the answer can't change while the dropdown is up
// except by the user doing something outside the app, which they can't while
// the overlay is up.
const deadPaths = ref({});

function isDead(p) {
  return !!deadPaths.value[normDir(p)];
}

function deadTitle(b) {
  const p = b.path;
  return isDead(p) ? `${p}\n（目录已不存在）` : p;
}

async function probeDead(list) {
  const paths = [...new Set(list)];
  const results = await Promise.all(
    paths.map((p) => pathExists(p).catch(() => false))
  );
  const next = {};
  paths.forEach((p, i) => { next[normDir(p)] = !results[i]; });
  deadPaths.value = next;
}

// ── Open / close ──
//
// Ownership is tracked by a token handed out by `claimMenuOwner()`: the
// dropdown whose token equals `openMenuOwner.value` is the one on screen. Both
// panels render this component, so without a single owner clicking ⭐ in the
// left panel and then in the right one would leave two dropdowns up, each with
// its own outside-click handling.
function onToggle() {
  if (open.value) {
    close();
    return;
  }
  ownerToken = claimMenuOwner();
  open.value = true;
  probeDead([...bookmarks.value.map((b) => b.path), ...props.recent, props.currentPath].filter(Boolean));
}

// Another panel's dropdown opened (or ours was closed elsewhere): stand down.
watch(openMenuOwner, (owner) => {
  if (owner !== ownerToken) close();
});

function close() {
  if (ownerToken !== null) {
    releaseMenuOwner(ownerToken);
    ownerToken = null;
  }
  open.value = false;
  editingId.value = null;
}

// Outside click / Escape.
//
// Both listeners run in the CAPTURE phase, which is what makes them reliable:
// the dropdown's own markup is inside `.file-panel`, whose root carries a click
// handler that activates the panel. A bubble-phase document listener would
// therefore see clicks on our own rows AFTER the panel already reacted to them.
// Capture runs first, so we get to decide whether the event was ours.
//
// Two exceptions, both checked against our own subtree:
//   - a mousedown on the ⭐ button / a dropdown row must NOT close us (it is
//     the interaction, not an outside click),
//   - while renaming, Escape cancels the rename instead of collapsing the menu.
function onDocPointer(e) {
  if (!open.value) return;
  if (e.type === "mousedown") {
    const root = rootRef.value;
    if (root && e.target instanceof Node && root.contains(e.target)) return;
    close();
    return;
  }
  // keydown
  if (e.key !== "Escape") return;
  if (editingId.value) return; // the rename input handles its own Escape
  // Fully consume the key: App.vue binds Escape to "close preview", and both
  // panels could otherwise collapse at once. Captured at the document level, so
  // stopPropagation here also keeps the panels from seeing it.
  e.preventDefault();
  e.stopPropagation();
  close();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocPointer, true);
  document.addEventListener("keydown", onDocPointer, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointer, true);
  document.removeEventListener("keydown", onDocPointer, true);
  close();
});

// ── Navigation ──

function samePath(a, b) {
  return normDir(a).toLowerCase() === normDir(b).toLowerCase();
}

function leaf(p) {
  const parts = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.pop() || String(p || "");
}

const marked = computed(() => !!props.currentPath && !!bookmarks.value.find(
  (b) => samePath(b.path, props.currentPath)
));

// "添加当前目录" in the footer. Unlike `onPick` this does NOT navigate — the
// panel is already in that directory; it just records the bookmark.
function addCurrent() {
  if (!props.currentPath || marked.value) return;
  const res = addBookmark(props.currentPath);
  if (res.ok) emit("notify", `已添加书签：${res.bookmark.name}`, "success");
  else if (res.reason === "exists") emit("notify", "当前目录已在书签中", "info");
}

function onPick(b) {
  if (!b || !b.path) return;
  // Re-probe at click time: the dropdown may have been opened a while ago, and
  // navigating into a deleted directory would leave the panel on an error page.
  pathExists(b.path).catch(() => false).then((exists) => {
    if (!exists) {
      emit("notify", `目录已不存在：${b.path}`, "error");
      return;
    }
    close();
    emit("navigate", b.path);
  });
}

// ── Inline rename ──

const editingId = ref(null);
const editName = ref("");
const editInput = ref(null);

// Right-click menu on one row. Declared with the other menu state because
// `onRowMenu` (above) writes it — kept next to the handlers that use it.
const rowMenu = ref({ visible: false, x: 0, y: 0, id: null, items: [] });

function onRowMenu(b, e) {
  close();
  rowMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    id: b.id,
    items: [
      { label: "重命名", action: "rename" },
      { label: "上移", action: "up", disabled: bookmarks.value[0]?.id === b.id },
      {
        label: "下移",
        action: "down",
        disabled: bookmarks.value[bookmarks.value.length - 1]?.id === b.id,
      },
      { separator: true },
      { label: "删除书签", action: "delete" },
    ],
  };
}

function onRowMenuSelect(item) {
  const id = rowMenu.value.id;
  rowMenu.value = { ...rowMenu.value, visible: false };
  if (item.action === "rename") startRename(id);
  else if (item.action === "delete") {
    if (removeBookmark(id)) emit("notify", "书签已删除", "info");
  } else if (item.action === "up" || item.action === "down") {
    moveBookmark(id, item.action === "up" ? -1 : 1);
  }
}

function startRename(id) {
  const b = bookmarks.value.find((x) => x.id === id);
  if (!b) return;
  editingId.value = id;
  editName.value = b.name;
  nextTick(() => {
    const el = editInput.value;
    if (el) {
      el.focus();
      el.select();
    }
  });
}

function cancelRename() {
  editingId.value = null;
  editName.value = "";
}

function commitRename(b) {
  // Guard against the blur that fires right after Enter / Esc: once the row has
  // left rename mode there's nothing to commit.
  if (editingId.value !== b.id) return;
  const res = renameBookmark(b.id, editName.value);
  editingId.value = null;
  editName.value = "";
  if (!res.ok && res.reason === "empty") emit("notify", "书签名称不能为空", "error");
}
</script>

<style scoped>
.bm-root {
  position: relative;
  display: flex;
}

/* Star glyph. Both states use plain-text ★/☆ (an emoji would render in fixed
   colour and ignore `color` entirely — that's why the unmarked state used to
   look yellow too). */
.bm-btn {
  font-size: 13px;
  line-height: 1;
  padding: 2px 6px;
}

/* Unbookmarked: a hollow star in the dimmed text colour — clearly "not
   collected" at a glance, and recessive enough not to compete with the path. */
.bm-btn:not(.marked) {
  color: var(--text-dim);
}

/* Bookmarked: filled star + accent border, matching the "current" breadcrumb
   segment so the state reads without hovering for the tooltip. */
.bm-btn.marked {
  color: var(--accent);
  border-color: var(--accent);
}

.bm-dropdown {
  position: absolute;
  top: calc(100% + 3px);
  right: 0;
  z-index: 520;
  min-width: 300px;
  max-width: 460px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  padding: 4px 0;
  user-select: none;
}

.bm-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 12px 5px;
  border-bottom: 1px solid var(--border);
}

.bm-head-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  flex: 0 0 auto;
}

.bm-current {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono), "Consolas", monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bm-list {
  max-height: 320px;
  overflow-y: auto;
  padding: 2px 0;
}

.bm-empty {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}

.bm-empty kbd {
  font-family: var(--font-mono), "Consolas", monospace;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 0 3px;
}

.bm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.bm-row:hover {
  background: var(--hover);
}

/* Directory is gone (deleted, or its drive was unmounted) — visibly inert. */
.bm-row.dead {
  color: var(--text-dim);
  text-decoration: line-through;
}

.bm-row.current .bm-name {
  color: var(--accent);
}

.bm-star {
  flex: 0 0 auto;
  font-size: 11px;
}

/* A real bookmark: filled star in the accent colour, so it reads as "collected"
   even though the rest of the row is monochrome. */
.bm-star.mark {
  color: var(--accent);
}

/* History entries are deliberately dimmer than bookmarks — they're derived, not
   something the user saved, and shouldn't compete visually. */
.bm-star.hist {
  color: var(--text-dim);
}

.bm-name {
  flex: 0 0 auto;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bm-path {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-dim);
  font-family: var(--font-mono), "Consolas", monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bm-input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--text);
  outline: none;
  font-size: 12px;
  font-family: inherit;
}

.bm-sep {
  margin: 4px 12px 2px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}

.bm-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 3px;
  border-top: 1px solid var(--border);
}

.bm-foot-btn {
  padding: 2px 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--tab-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}

.bm-foot-btn:hover:not(:disabled) {
  background: var(--hover);
}

.bm-foot-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.bm-foot-hint {
  font-size: 11px;
  color: var(--text-dim);
}
</style>