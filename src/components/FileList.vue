<template>
  <div class="file-list" ref="listContainer" tabindex="0" title="按 / 过滤当前目录文件" @keydown="onKeydown" @mousedown="onMouseDown" @mouseup="onMouseUp" @compositionstart="onCompositionStart">
    <!-- Column headers -->
    <div class="file-header">
      <div class="col-name sortable" @click="$emit('sort', 'name')">
        Name
        <span class="sort-arrow" v-if="sortColumn === 'name'">{{ sortDirection === "asc" ? "▲" : "▼" }}</span>
      </div>
      <div class="col-size sortable" @click="$emit('sort', 'size')">
        Size
        <span class="sort-arrow" v-if="sortColumn === 'size'">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
      </div>
      <div class="col-modified sortable" @click="$emit('sort', 'modified')">
        Modified
        <span class="sort-arrow" v-if="sortColumn === 'modified'">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
      </div>
    </div>

    <!-- Incremental filename filter bar. Always in the DOM (just moved
         off-screen when idle) so it can be synchronously focused on the first
         keydown — that lets an IME compose its very first key into the input
         instead of committing it as a stray English char on the div. -->
    <div class="search-bar" :class="{ hidden: !isSearching }">
      <span class="search-icon">🔍</span>
      <input
        ref="searchInput"
        class="search-input"
        v-model="searchQuery"
        type="text"
        placeholder="Filter files… (Esc to cancel)"
        @keydown="onSearchKeydown"
        @compositionstart="onCompositionStart"
      />
      <span class="search-count">{{ displayedEntries.length }} match{{ displayedEntries.length === 1 ? "" : "es" }}</span>
      <button class="search-clear" @click="closeSearch" title="Clear (Esc)">×</button>
    </div>

    <!-- Scrollable file entries -->
    <div class="file-entries" ref="entriesContainer" @click="onEntriesClick" @contextmenu.prevent="onEntriesContextMenu">
      <!-- Parent dir entry (hidden only while an actual filter is active) -->
      <div
        v-if="hasParent && (!isSearching || searchQuery === '')"
        class="file-row parent-row"
        @click="clearSelection"
        @dblclick="$emit('navigate-parent')"
        @contextmenu.prevent.stop="onRowContextMenu(null, $event)"
      >
        <div class="col-name"><span class="file-icon folder-icon">📁</span>..</div>
        <div class="col-size"></div>
        <div class="col-modified"></div>
      </div>

      <!-- Actual file entries (search-filtered) -->
      <div
        v-for="(entry, index) in displayedEntries"
        :key="entry.name"
        class="file-row"
        :class="{
          selected: selectedIndices.has(index),
          'is-dir': entry.is_dir,
          'is-hidden': entry.is_hidden,
          'is-cut': cutSet.has(entry.name),
        }"
        @click="onRowClick(index, $event)"
        @dblclick="onDoubleClick(entry)"
        @contextmenu.prevent.stop="onRowContextMenu(index, $event, entry)"
      >
        <div class="col-name">
          <span class="file-icon" :class="entry.is_dir ? 'folder-icon' : 'file-icon-' + entry.extension.toLowerCase()">
            {{ entry.is_dir ? "📁" : getFileIcon(entry.name) }}
          </span>
          <input
            v-if="renamingIndex === index"
            :ref="setRenameInput"
            class="rename-input"
            v-model="renameValue"
            @keydown.stop="onRenameKeydown"
            @compositionstart="onCompositionStart"
            @blur="onRenameBlur"
            @click.stop
            @dblclick.stop
          />
          <span v-else class="file-name">{{ entry.name }}</span>
        </div>
        <div class="col-size">
          <template v-if="entry.is_dir">
            <span v-if="dirSizes[entry.name] !== undefined">{{ formatSize(dirSizes[entry.name]) }}</span>
            <span v-else-if="dirSizes[entry.name] === -1">...</span>
            <span v-else>&lt;DIR&gt;</span>
          </template>
          <template v-else>{{ formatSize(entry.size) }}</template>
        </div>
        <div class="col-modified">{{ formatDate(entry.modified) }}</div>
      </div>

      <!-- Empty / no-match state -->
      <div v-if="displayedEntries.length === 0 && !loading && !error" class="empty-state">{{ searchEmptyMessage }}</div>
      <div v-if="error" class="error-state">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick } from "vue";

const props = defineProps({
  entries: { type: Array, default: () => [] },
  path: { type: String, default: "" },
  sortColumn: { type: String, default: "name" },
  sortDirection: { type: String, default: "asc" },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
  hasParent: { type: Boolean, default: true },
  dirSizes: { type: Object, default: () => ({}) },
  pendingSelectName: { type: String, default: null },
  isActive: { type: Boolean, default: false },
  cutNames: { type: Array, default: () => [] },
});

const emit = defineEmits(["sort", "navigate", "navigate-parent", "select", "calc-dir-size", "delete", "open", "pending-select-resolved", "ctx-menu", "rename"]);

// ── Multi-selection state ──
// selectedIndices: indices (into displayedEntries) of every selected row.
// activeIndex:    the "focused" row (last clicked / keyboard caret); used for
//                 dblclick / Enter / preview / delete target.
// anchorIndex:    the anchor for Shift+range selection.
const selectedIndices = ref(new Set());
const activeIndex = ref(-1);
const anchorIndex = ref(-1);

const cutSet = computed(() => new Set(props.cutNames || []));

const entriesContainer = ref(null);
const listContainer = ref(null);
const pendingSelectName = ref(null);

// ── Incremental search state ──
const searchQuery = ref("");
const isSearching = ref(false);
const searchInput = ref(null);

// ── Inline rename state ──
// renamingIndex: the index (into displayedEntries) currently being renamed;
//                -1 means not renaming. When multiple rows are selected, F2
//                targets the LAST selected one (matching Explorer behaviour).
// renameValue:   the editable text bound to the inline input.
const renamingIndex = ref(-1);
const renameValue = ref("");
const renameInput = ref(null);

// Function ref for the inline rename <input> (rendered inside a v-for, where a
// plain string ref would be ambiguous). Vue calls this with the mounted DOM
// node on render and with null on unmount; we keep the live node in renameInput.
function setRenameInput(el) {
  renameInput.value = el;
}

// Reset selection when entries change, unless we have a pending selection from delete or parent navigation.
// flush: "post" so the DOM has already re-rendered the new rows before we scrollIntoView.
watch(
  () => props.entries,
  () => {
    // Any directory-content change clears the multi-selection (each panel
    // manages its own state, so left/right stay isolated automatically).
    selectedIndices.value = new Set();
    anchorIndex.value = -1;

    if (pendingSelectName.value) {
      const name = pendingSelectName.value;
      pendingSelectName.value = null;
      const idx = displayedEntries.value.findIndex((e) => e.name === name);
      if (idx >= 0) {
        selectRow(idx);
        scrollToRow(idx);
      } else {
        activeIndex.value = -1;
        emitSelection();
      }
    } else if (props.pendingSelectName) {
      const name = props.pendingSelectName;
      const idx = displayedEntries.value.findIndex((e) => e.name === name);
      if (idx >= 0) {
        selectRow(idx);
        scrollToRow(idx);
      } else {
        activeIndex.value = -1;
        emitSelection();
      }
      emit("pending-select-resolved");
    } else {
      activeIndex.value = -1;
      emitSelection();
    }
  },
  { flush: "post" }
);

// Clear the search filter whenever the directory changes (path changes), but keep
// it across a delete so the remaining matches stay filtered.
watch(
  () => props.path,
  () => {
    isSearching.value = false;
    searchQuery.value = "";
  }
);

// Sort entries based on current sort settings
const sortedEntries = computed(() => {
  const list = [...props.entries];
  const col = props.sortColumn;
  const dir = props.sortDirection === "asc" ? 1 : -1;

  list.sort((a, b) => {
    // Directories always first (unless sorting by modified/size)
    if (a.is_dir !== b.is_dir && col === "name") {
      return a.is_dir ? -1 : 1;
    }

    let cmp = 0;
    if (col === "name") {
      // Natural sort: digit runs compare by numeric value (so "1a.jpg" <
      // "2c.jpg" < "10b.jpg"), case/accent-insensitive via sensitivity:"base"
      // (replaces the old toLowerCase()). The directory-first check above still
      // runs first, so dirs keep sorting before files regardless of name order.
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    } else if (col === "size") {
      cmp = a.size - b.size;
      // For size sort, directories go first regardless
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    } else if (col === "modified") {
      cmp = a.modified - b.modified;
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    }
    return cmp * dir;
  });

  return list;
});

// Filtered view: when searching, keep only names containing the query (case-insensitive).
const displayedEntries = computed(() => {
  if (!searchQuery.value) return sortedEntries.value;
  const q = searchQuery.value.toLowerCase();
  return sortedEntries.value.filter((e) => e.name.toLowerCase().includes(q));
});

const searchEmptyMessage = computed(() => {
  if (isSearching.value && searchQuery.value) {
    return `No matches for "${searchQuery.value}"`;
  }
  return "Empty folder";
});

// Collect the entry objects for every selected index.
function getSelectedEntries() {
  const arr = [];
  for (const i of selectedIndices.value) {
    const e = displayedEntries.value[i];
    if (e) arr.push(e);
  }
  return arr;
}

// Emit the current selection up to the parent panel.
function emitSelection() {
  const entries = getSelectedEntries();
  const active = activeIndex.value >= 0 ? displayedEntries.value[activeIndex.value] || null : null;
  emit("select", entries, active);
}

// Plain single-select: clears other rows, sets anchor + active to this index.
function selectRow(index) {
  selectedIndices.value = new Set([index]);
  activeIndex.value = index;
  anchorIndex.value = index;
  emitSelection();
}

function clearSelection() {
  selectedIndices.value = new Set();
  anchorIndex.value = -1;
  activeIndex.value = -1;
  emitSelection();
}

function selectAll() {
  const set = new Set();
  for (let i = 0; i < displayedEntries.value.length; i++) set.add(i);
  selectedIndices.value = set;
  anchorIndex.value = 0;
  activeIndex.value = displayedEntries.value.length - 1;
  emitSelection();
}

// Row click with modifier awareness.
function onRowClick(index, e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  if (shift && anchorIndex.value >= 0) {
    // Continuous range select from anchor to this row (replaces selection).
    const a = Math.min(anchorIndex.value, index);
    const b = Math.max(anchorIndex.value, index);
    const set = new Set();
    for (let i = a; i <= b; i++) set.add(i);
    selectedIndices.value = set;
    activeIndex.value = index;
  } else if (ctrl) {
    // Discontinuous toggle.
    const set = new Set(selectedIndices.value);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    selectedIndices.value = set;
    activeIndex.value = index;
    anchorIndex.value = index;
  } else {
    // Plain click: single-select this row.
    selectedIndices.value = new Set([index]);
    activeIndex.value = index;
    anchorIndex.value = index;
  }
  emitSelection();
}

// Clicking empty space inside the list (not a row) clears the selection.
function onEntriesClick(e) {
  if (e.target === e.currentTarget) clearSelection();
}

// Right-click on a row (or the ".." parent row, where entry is null): select
// the row first (unless it's already part of the current multi-selection), then
// open the context menu with the entry + viewport coordinates.
function onRowContextMenu(index, e, entry) {
  if (entry && index >= 0 && !selectedIndices.value.has(index)) {
    // Selecting a row also resets the multi-selection to just this row —
    // matching Explorer, where right-clicking an unselected item pivots the
    // selection to it. (When the row is already selected we keep the group.)
    selectRow(index);
  }
  emit("ctx-menu", { entry: entry || null, x: e.clientX, y: e.clientY });
}

// Right-click on empty space inside the list (not a row): open the background
// context menu (only fires when the target is the container itself).
function onEntriesContextMenu(e) {
  if (e.target !== e.currentTarget) return;
  emit("ctx-menu", { entry: null, x: e.clientX, y: e.clientY });
}

function scrollToRow(index, block = "nearest") {
  const container = entriesContainer.value;
  if (!container) return;
  // parent row (..) is the first .file-row when hasParent (and not searching), so offset by 1
  const offset = props.hasParent && !isSearching.value ? 1 : 0;
  const row = container.querySelectorAll(".file-row")[offset + index];
  if (row) row.scrollIntoView({ block, behavior: "auto" });
}

// Move the single selection by delta (+1 down / -1 up). Does NOT wrap.
function moveSelection(delta) {
  const list = displayedEntries.value;
  if (list.length === 0) return;
  const cur = activeIndex.value;
  let next;
  if (cur === -1) {
    if (delta > 0) next = 0; // from nothing selected → first item
    else return;             // from nothing, Up → no-op
  } else {
    next = cur + delta;
    if (next < 0) next = 0;                        // first item + Up → no-op
    if (next > list.length - 1) next = list.length - 1; // last item + Down → no-op
  }
  if (next === cur) return;
  selectRow(next);
  scrollToRow(next);
}

// Select a specific entry by its file name (single-select, scroll into view).
// Used by autoplay-next so the file-list highlight follows the clip now playing.
function selectName(name) {
  const idx = displayedEntries.value.findIndex((e) => e.name === name);
  if (idx >= 0) {
    selectRow(idx);
    scrollToRow(idx);
  } else {
    activeIndex.value = -1;
    emitSelection();
  }
}

// Shift+Arrow: extend the selection continuously from the anchor.
function extendSelection(delta) {
  const list = displayedEntries.value;
  if (list.length === 0) return;
  if (activeIndex.value === -1) {
    selectRow(0);
    return;
  }
  let next = activeIndex.value + delta;
  if (next < 0) next = 0;
  if (next > list.length - 1) next = list.length - 1;
  if (anchorIndex.value === -1) anchorIndex.value = activeIndex.value;
  const a = Math.min(anchorIndex.value, next);
  const b = Math.max(anchorIndex.value, next);
  const set = new Set();
  for (let i = a; i <= b; i++) set.add(i);
  selectedIndices.value = set;
  activeIndex.value = next;
  emitSelection();
  scrollToRow(next);
}

// Number of fully-visible rows in the scroll viewport — the step unit for
// PageUp / PageDown. Measured from a real row so it stays correct if the row
// height ever changes in CSS; falls back to 24px when the list is empty.
function pageSize() {
  const c = entriesContainer.value;
  if (!c) return 1;
  const row = c.querySelector(".file-row");
  const rowH = row ? row.getBoundingClientRect().height : 0;
  return Math.max(1, Math.floor(c.clientHeight / (rowH || 24)));
}

// Jump the active selection up/down by one viewport page. Clamped to the first
// / last row (never wraps). Plain PageUp/PageDown only moves the caret.
function movePage(delta) {
  const list = displayedEntries.value;
  if (list.length === 0) return;
  if (activeIndex.value === -1) {
    if (delta > 0) { selectRow(0); scrollToRow(0); }
    return;
  }
  const step = pageSize() * (delta > 0 ? 1 : -1);
  let next = activeIndex.value + step;
  if (next < 0) next = 0;
  if (next > list.length - 1) next = list.length - 1;
  if (next === activeIndex.value) return;
  selectRow(next);
  scrollToRow(next, "nearest");
}

// Shift+PageUp / Shift+PageDown: extend the multi-selection by one page from
// the anchor — mirrors Shift+Arrow but with the viewport page as the unit.
function extendPage(delta) {
  const list = displayedEntries.value;
  if (list.length === 0) return;
  if (activeIndex.value === -1) { selectRow(0); return; }
  const step = pageSize() * (delta > 0 ? 1 : -1);
  let next = activeIndex.value + step;
  if (next < 0) next = 0;
  if (next > list.length - 1) next = list.length - 1;
  if (next === activeIndex.value) return;
  if (anchorIndex.value === -1) anchorIndex.value = activeIndex.value;
  const a = Math.min(anchorIndex.value, next);
  const b = Math.max(anchorIndex.value, next);
  const set = new Set();
  for (let i = a; i <= b; i++) set.add(i);
  selectedIndices.value = set;
  activeIndex.value = next;
  emitSelection();
  scrollToRow(next, "nearest");
}

function onDoubleClick(entry) {
  console.log("[onDoubleClick] entry:", entry.name, "is_dir:", entry.is_dir);
  if (entry.is_dir) {
    emit("navigate", entry.name);
  } else {
    emit("open", entry.name);
  }
}

// ── Search control ──

function startSearch() {
  isSearching.value = true;
  // Focus synchronously (the input is always in the DOM). We open via the "/"
  // activation key — a non-composing key — so by the time the user types the
  // first real search character (which may be the first pinyin letter of a
  // Chinese composition), the input is already focused. TSF-based IMEs bind
  // composition to the focused element on the composing keypress, so the
  // Chinese text composes into the input from the very first letter.
  const el = searchInput.value;
  if (el) {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
}

function closeSearch() {
  isSearching.value = false;
  searchQuery.value = "";
  const el = searchInput.value;
  if (el) el.blur();
  clearSelection();
  // Return focus to the list so "/" can re-open the search immediately.
  nextTick(() => { listContainer.value?.focus(); });
}

// Keydown inside the search input: arrows/enter act on results, Esc/empty-backspace exits.
function onSearchKeydown(e) {
  // During IME composition (Chinese input), let the IME handle every key
  // (including Enter to confirm a candidate) without our interference.
  if (e.isComposing || e.keyCode === 229) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = displayedEntries.value[activeIndex.value];
    if (entry) {
      if (entry.is_dir) emit("navigate", entry.name);
      else emit("open", entry.name);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Backspace" && searchQuery.value === "") {
    // Backspace on an empty filter closes the search (backs out to the list).
    e.preventDefault();
    closeSearch();
  }
}

// Ensure the IME composition continues in the search input. If the composition
// started on the list div before focus moved, hand focus to the input so the
// Chinese text composes there and not in the div (which can't hold text).
function onCompositionStart() {
  if (searchInput.value && document.activeElement !== searchInput.value) {
    searchInput.value.focus();
  }
}

// Mouse back button (XButton1, e.button === 3) navigates to parent, but only
// when this panel is the active one. Matches the Backspace behaviour.
// preventDefault on mousedown blocks any browser/Tauri back/forward side effects.
function onMouseDown(e) {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
  }
}

function onMouseUp(e) {
  if (e.button === 3 && props.isActive) {
    e.preventDefault();
    emit("navigate-parent");
  }
}

// Enter inline rename mode for a given row index. Prefills the input with the
// current name and (for files) selects the base name excluding the extension,
// matching Explorer's default selection. Called by F2 (last-selected row) and
// optionally by the context menu.
async function startRename(index) {
  if (index === undefined || index < 0) return;
  const entry = displayedEntries.value[index];
  if (!entry) return;
  renamingIndex.value = index;
  renameValue.value = entry.name;
  await nextTick();
  const el = renameInput.value;
  if (el) {
    el.focus();
    // Select the base name (without extension) for a file; select all for a dir.
    if (!entry.is_dir && entry.name.includes(".")) {
      const dot = entry.name.lastIndexOf(".");
      el.setSelectionRange(0, dot);
    } else {
      el.setSelectionRange(0, entry.name.length);
    }
  }
}

// Which index to rename when F2 is pressed: the last selected row if multiple
// are selected, otherwise the active row. Returns -1 if nothing is focusable.
function targetRenameIndex() {
  if (selectedIndices.value.size > 0) {
    // last clicked = the max index among the selection set
    let last = -1;
    for (const i of selectedIndices.value) if (i > last) last = i;
    return last;
  }
  return activeIndex.value;
}

// Locate a row by its entry object (used by the right-click "rename" menu item)
// and enter inline rename. Falls back to the active row when not found.
async function startRenameByEntry(entry) {
  if (!entry) return;
  const idx = displayedEntries.value.findIndex((e) => e === entry);
  startRename(idx >= 0 ? idx : targetRenameIndex());
}

// Keydown inside the rename input: Enter commits, Esc cancels. IME composition
// is respected so confirming a Chinese candidate doesn't commit prematurely.
function onRenameKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelRename();
  }
}

// Commit the inline rename: emit a "rename" event with the old entry + new name
// (the parent panel performs the actual IO and refreshes). Cancels on empty /
// unchanged input.
function commitRename() {
  const idx = renamingIndex.value;
  if (idx < 0) return;
  const entry = displayedEntries.value[idx];
  const newName = renameValue.value.trim();
  renamingIndex.value = -1;
  renameValue.value = "";
  // Return keyboard focus to the list so the renamed row (which the parent
  // re-selects by its new name after refresh) stays keyboard-active.
  nextTick(() => listContainer.value?.focus());
  if (!entry || newName === "" || newName === entry.name) return;
  emit("rename", entry, newName);
}

function cancelRename() {
  renamingIndex.value = -1;
  renameValue.value = "";
  // Esc cancels: drop the edit and hand focus back to the list.
  nextTick(() => listContainer.value?.focus());
}

// Clicking away (blur) from the rename input commits, just like Enter — unless
// the blur was caused by Esc (which already reset state) or an active IME
// composition (which would commit a half-typed candidate). When committing
// would be a no-op (empty / unchanged), we simply drop the edit state.
function onRenameBlur(e) {
  if (renamingIndex.value < 0) return; // already cancelled (e.g. via Esc)
  if (e && e.isComposing) return;
  commitRename();
}

// Emit a "delete" event for the current selection (or the active row when
// nothing is explicitly selected). Shared by the Delete key and Cmd/Ctrl+Backspace.
function deleteSelected() {
  const list = displayedEntries.value;
  const targets = getSelectedEntries();
  if (targets.length === 0 && activeIndex.value >= 0) {
    const e0 = list[activeIndex.value];
    if (e0) targets.push(e0);
  }
  if (targets.length === 0) return;

  // Preserve focus on a neighbour for the single-delete case.
  let pendingName = null;
  if (targets.length === 1) {
    const idx = list.indexOf(targets[0]);
    if (idx >= 0) {
      if (idx < list.length - 1) pendingName = list[idx + 1].name;
      else if (idx > 0) pendingName = list[idx - 1].name;
    }
  }
  if (pendingName) pendingSelectName.value = pendingName;
  emit("delete", targets);
}

function onKeydown(e) {
  // If focus is inside the search input, let it handle keys itself.
  if (e.target && e.target.tagName === "INPUT") return;

  // Open the filter with an explicit activation key ("/"). Using a dedicated
  // non-composing key — instead of "any printable key" — guarantees the search
  // input is focused BEFORE the user types any composition character. Chinese
  // IMEs (TSF) bind composition to the focused element on the keypress that
  // starts composition; since "/" is plain text (not composition) and focuses
  // the input synchronously, the very next key (the first pinyin letter) composes
  // into the already-focused input. "/" itself is prevented from being typed.
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    startSearch();
    return;
  }

  const list = displayedEntries.value;

  // Backspace navigates to parent — works even in empty directories.
  // macOS has no dedicated forward-Delete key, so Cmd+Backspace is the
  // conventional "delete" gesture there; we also accept Ctrl+Backspace for
  // parity on Windows/Linux. A bare Backspace (no modifier) still goes up a level.
  if (e.key === "Backspace") {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    e.preventDefault();
    emit("navigate-parent");
    return;
  }

  // Enter on ".." (activeIndex === -1) navigates to parent — but only when not searching
  if (e.key === "Enter" && activeIndex.value === -1 && !isSearching.value) {
    e.preventDefault();
    emit("navigate-parent");
    return;
  }

  if (list.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (e.shiftKey) extendSelection(1);
    else moveSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (e.shiftKey) extendSelection(-1);
    else moveSelection(-1);
  } else if (e.key === "PageDown") {
    e.preventDefault();
    if (e.shiftKey) extendPage(1);
    else movePage(1);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    if (e.shiftKey) extendPage(-1);
    else movePage(-1);
  } else if (e.key === "Home") {
    e.preventDefault();
    if (e.shiftKey) {
      if (anchorIndex.value === -1) anchorIndex.value = activeIndex.value === -1 ? 0 : activeIndex.value;
      const end = anchorIndex.value;
      const set = new Set();
      for (let i = 0; i <= end; i++) set.add(i);
      selectedIndices.value = set;
      activeIndex.value = 0;
      emitSelection();
      scrollToRow(0, "start");
    } else {
      selectRow(0);
      scrollToRow(0, "start");
    }
  } else if (e.key === "End") {
    e.preventDefault();
    const last = list.length - 1;
    if (e.shiftKey) {
      if (anchorIndex.value === -1) anchorIndex.value = activeIndex.value === -1 ? last : activeIndex.value;
      const start = anchorIndex.value;
      const set = new Set();
      for (let i = start; i <= last; i++) set.add(i);
      selectedIndices.value = set;
      activeIndex.value = last;
      emitSelection();
      scrollToRow(last, "end");
    } else {
      selectRow(last);
      scrollToRow(last, "end");
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = list[activeIndex.value];
    console.log("[Enter] activeIndex:", activeIndex.value, "entry:", entry?.name, "is_dir:", entry?.is_dir);
    if (entry) {
      if (entry.is_dir) {
        emit("navigate", entry.name);
      } else {
        emit("open", entry.name);
      }
    }
  } else if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    if (activeIndex.value >= 0) {
      const entry = list[activeIndex.value];
      if (entry && entry.is_dir) {
        emit("calc-dir-size", entry.name);
      }
    }
  } else if (e.key === "Escape") {
    // Cancel the current selection (when not searching).
    if (!isSearching.value) {
      e.preventDefault();
      clearSelection();
    }
  } else if (e.key === "Delete") {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === "F2") {
    // Inline rename the last-selected row (or active row when only one/none).
    e.preventDefault();
    const idx = targetRenameIndex();
    if (idx >= 0) startRename(idx);
  }
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date + " " + time;
}

const ARCHIVE_EXTENSIONS = [
  "zip", "rar", "7z", "gz", "tar", "tgz", "bz2", "xz", "zst", "lz4",
  "cab", "iso", "wim", "jar", "apk", "deb", "rpm", "arj", "z", "lzh", "ace",
];
const ARCHIVE_VOLUME_SUFFIXES = [
  "001", "002", "003", "004", "005", "006", "007", "008", "009",
  "z01", "z02", "z03", "z04", "z05", "z06", "z07", "z08", "z09",
];

// Whether a file name is an archive, including split-volume parts like
// `foo.7z.001` / `foo.rar.part1` whose last segment is a numeric volume index.
function isArchiveName(name) {
  const lower = name.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) return false;
  const lastExt = lower.slice(lastDot + 1);
  if (ARCHIVE_EXTENSIONS.includes(lastExt)) return true;
  if (lastExt === "exe") return true; // self-extracting archive
  const isVolumePart = ARCHIVE_VOLUME_SUFFIXES.includes(lastExt) || /^part\d+$/i.test(lastExt);
  if (!isVolumePart) return false;
  const prevDot = lower.lastIndexOf(".", lastDot - 1);
  const prevExt = prevDot === -1 ? "" : lower.slice(prevDot + 1, lastDot);
  return ARCHIVE_EXTENSIONS.includes(prevExt);
}

function getFileIcon(name) {
  if (isArchiveName(name)) return "🗜️";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  const icons = {
    TXT: "📄",
    MD: "📝",
    PDF: "📕",
    DOC: "📘",
    DOCX: "📘",
    XLS: "📗",
    XLSX: "📗",
    PPT: "📙",
    PPTX: "📙",
    EXE: "⚙️",
    MSI: "⚙️",
    JS: "📜",
    TS: "📜",
    JSON: "🔧",
    XML: "🔧",
    HTML: "🌐",
    CSS: "🎨",
    RUST: "🦀",
    PY: "🐍",
    JAVA: "☕",
    PNG: "🖼️",
    JPG: "🖼️",
    JPEG: "🖼️",
    GIF: "🖼️",
    SVG: "🖼️",
    BMP: "🖼️",
    WEBP: "🖼️",
    AVIF: "🖼️",
    MP3: "🎵",
    WAV: "🎵",
    MP4: "🎬",
    AVI: "🎬",
    MKV: "🎬",
    WEBM: "🎬",
    MOV: "🎬",
    OGV: "🎬",
    FLV: "🎬",
    WMV: "🎬",
    M4V: "🎬",
    MPG: "🎬",
    MPEG: "🎬",
    RM: "🎬",
    RMVB: "🎬",
    "3GP": "🎬",
    TS: "🎬",
    VOB: "🎬",
  };
  return icons[ext] || "📄";
}

// Restore a multi-selection by entry names after a directory re-list (e.g. a
// background refresh). Names no longer present in the list (deleted externally)
// are silently dropped. Restores `activeIndex` to the first matched row so the
// keyboard caret and metadata stay consistent. Used by FilePanel.refresh() to
// keep the user's selection across a window focus regain.
function restoreByNames(names) {
  if (!names || !names.length) return;
  const set = new Set(names);
  const newSel = new Set();
  let firstIdx = -1;
  displayedEntries.value.forEach((e, i) => {
    if (set.has(e.name)) {
      newSel.add(i);
      if (firstIdx === -1) firstIdx = i;
    }
  });
  if (newSel.size === 0) return;
  selectedIndices.value = newSel;
  activeIndex.value = firstIdx;
  anchorIndex.value = firstIdx;
  emitSelection();
}

defineExpose({ moveSelection, selectName, selectAll, clearSelection, restoreByNames, startRename, startRenameByEntry });
</script>

<style scoped>
.file-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}

.file-header {
  display: flex;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 12px;
  user-select: none;
}

.file-header > div {
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
}

.file-header > div:hover {
  background: var(--hover);
}

.sort-arrow {
  color: var(--accent);
  font-size: 10px;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
}

/* Idle (not searching): keep the bar in the DOM but move it off-screen so it
   stays focusable for IME. Must NOT use display:none / visibility:hidden, which
   would make it un-focusable and break composition on the first key. */
.search-bar.hidden {
  position: absolute;
  left: -10000px;
  top: -10000px;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  border: 0;
  overflow: hidden;
}

.search-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: var(--panel-bg);
  color: var(--text);
  border: 1px solid var(--accent);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 12px;
  outline: none;
}

.search-count {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}

.search-clear {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}

.search-clear:hover {
  color: var(--danger);
}

.col-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-size {
  width: 80px;
  text-align: right;
}

.col-modified {
  width: 140px;
}

.file-entries {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.file-row {
  display: flex;
  align-items: center;
  height: 24px;
  cursor: pointer;
  white-space: nowrap;
  padding: 0;
}

.file-row:hover {
  background: var(--row-hover);
}

.file-row.selected {
  background: var(--selected);
  color: var(--selected-text);
}

.file-row.is-hidden {
  opacity: 0.5;
}

/* Cut (pending move) items: ghosted so the user can see what will be moved. */
.file-row.is-cut {
  opacity: 0.45;
  font-style: italic;
}

.file-row > div {
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-row .col-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.file-icon {
  flex-shrink: 0;
  font-size: 14px;
  width: 16px;
  text-align: center;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Inline rename input: replaces the file name span while editing. */
.rename-input {
  flex: 1;
  min-width: 0;
  background: var(--panel-bg);
  color: var(--text);
  border: 1px solid var(--accent);
  border-radius: 2px;
  padding: 0 2px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.parent-row {
  font-weight: 600;
}

.empty-state,
.error-state {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
}

.error-state {
  color: var(--danger);
}
</style>
