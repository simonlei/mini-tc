<template>
  <div class="file-panel" :class="{ active: isActive }" :data-panel-id="panelId" @click="$emit('activate')">
    <!-- Tab bar -->
    <TabBar
      :tabs="tabs"
      :active-tab-id="activeTabId"
      @switch-tab="switchTab"
      @close-tab="closeTab"
      @add-tab="addTab"
      @tab-menu="onTabMenu"
    />

    <!-- Path bar. A search-results tab has no real path, so it gets a
         descriptive label instead of a breadcrumb (PathBar would otherwise try
         to render `minitc://search/1` as navigable segments). -->
    <PathBar
      :path="activeTab ? activeTab.path : ''"
      :drives="drives"
      :virtual-label="searchLabel"
      :virtual-root="activeTab?.search?.root || ''"
      :virtual="isVirtual"
      :can-back="canGoBack"
      :can-forward="canGoForward"
      @navigate="navigateTo"
      @back="goBack"
      @forward="goForward"
      @refresh="refresh({ force: true })"
    />

    <!-- File list -->
    <FileList
      ref="fileListRef"
      :entries="entries"
      :path="activeTab ? activeTab.path : ''"
      :sort-column="activeTab ? activeTab.sortColumn : 'name'"
      :sort-direction="activeTab ? activeTab.sortDirection : 'asc'"
      :allow-found-sort="isVirtual"
      :loading="loading"
      :error="error"
      :has-parent="hasParent"
      :dir-sizes="dirSizes"
      :pending-select-name="pendingSelectName"
      :is-active="isActive"
      :cut-names="cutNames"
      @sort="handleSort"
      @navigate="navigateInto"
      @navigate-parent="navigateParent"
      @navigate-back="goBack"
      @navigate-forward="goForward"
      @select="onSelect"
      @calc-dir-size="calcDirSize"
      @delete="onDelete"
      @open="onOpen"
      @rename="onRename"
      @ctx-menu="onCtxMenu"
      @pending-select-resolved="pendingSelectName = null"
    />

    <!-- Right-click context menu (archive extraction, open, copy path…) -->
    <ContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="closeCtxMenu"
      @select="handleCtxSelect"
    />

    <!-- Right-click context menu on a TAB (lock / unlock / jump back / close) -->
    <ContextMenu
      :visible="tabMenu.visible"
      :x="tabMenu.x"
      :y="tabMenu.y"
      :items="tabMenu.items"
      @close="closeTabMenu"
      @select="handleTabMenuSelect"
    />

    <!-- Panel status bar -->
    <div class="panel-status">
      <span v-if="isVirtual">{{ entries.length }} 个结果<template v-if="activeTab?.search?.live">（搜索中…）</template></span>
      <span v-else>{{ entries.length }} items</span>
      <span v-if="selectedEntries.length">{{ selectedEntries.length }} selected · {{ formatBytes(selectedSize) }}</span>
      <span v-if="selectedEntry">{{ selectedEntry.name }}</span>
      <span v-if="loading" class="loading-text">Loading...</span>
    </div>

    <!-- Local toast (context-menu feedback: extract / copy path) -->
    <div class="panel-toast" v-if="toast.visible" :class="'toast-' + toast.type">{{ toast.text }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import TabBar from "./TabBar.vue";
import PathBar from "./PathBar.vue";
import FileList from "./FileList.vue";
import ContextMenu from "./ContextMenu.vue";
import { listDirectory, getHomeDir, getParentDir, joinPath, listDrives, getDirSize, deleteToTrash, deletePermanently, deleteWithAdmin, renameFile, openFile, createDirectory, loadConfig, saveConfig, getArchiveTools, extractArchive, addToArchive, pathExists } from "../api.js";
import { entryPath, isSearchPath, parentDirOf, makeSearchPath } from "../paths.js";
import { cancelSearch, startSearch } from "../api.js";
import { listen } from "@tauri-apps/api/event";
import { mark, track } from "../bootLog.js";

// Extensions we consider extractable archives. Covers everything the bundled
// 7-Zip (and friends) can handle; the actual extraction is delegated to the
// external tool, so this list only gates which rows show the extract entries.
const ARCHIVE_EXTENSIONS = [
  "zip", "rar", "7z", "gz", "tar", "tgz", "bz2", "xz", "zst", "lz4",
  "cab", "iso", "wim", "jar", "apk", "deb", "rpm", "arj", "z", "lzh", "ace",
];

// Split-volume archive suffixes used by 7-Zip / WinRAR, e.g. `foo.7z.001`,
// `foo.zip.001`, `foo.rar.part1`. These are individual parts of a multi-file
// archive and must be treated as archives (the first part is enough to extract).
const ARCHIVE_VOLUME_SUFFIXES = [
  "001", "002", "003", "004", "005", "006", "007", "008", "009",
  "z01", "z02", "z03", "z04", "z05", "z06", "z07", "z08", "z09",
];
const ARCHIVE_VOLUME_PART_RE = /^part\d+$/i;

// Decide whether a file name (not just its last extension) points at an archive
// we can extract. Handles both plain archives (`foo.zip`) and split volumes
// (`foo.7z.001`, `foo.rar.part1`) whose last segment is a numeric volume index.
function isArchiveName(name) {
  const lower = name.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) return false;
  const lastExt = lower.slice(lastDot + 1);
  if (ARCHIVE_EXTENSIONS.includes(lastExt)) return true;
  if (lastExt === "exe") return true; // self-extracting archive
  const isVolumePart =
    ARCHIVE_VOLUME_SUFFIXES.includes(lastExt) || ARCHIVE_VOLUME_PART_RE.test(lastExt);
  if (!isVolumePart) return false;
  const prevDot = lower.lastIndexOf(".", lastDot - 1);
  const prevExt = prevDot === -1 ? "" : lower.slice(prevDot + 1, lastDot);
  return ARCHIVE_EXTENSIONS.includes(prevExt);
}

const props = defineProps({
  isActive: { type: Boolean, default: false },
  panelId: { type: String, required: true },
});

const emit = defineEmits(["activate", "open-video", "deleted", "drop-move"]);

// Config name → ~/.minitc/tabs-<panelId>.json (unified cross-run store).
const STORAGE_KEY = `tabs-${props.panelId}`;

// Tab state
const tabs = ref([]);
const activeTabId = ref(0);

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value));

// True when the active tab is a search-results pseudo-directory.
const isVirtual = computed(() => isSearchPath(activeTab.value?.path || ""));

// Label shown in place of the path breadcrumb on a search-results tab.
const searchLabel = computed(() => {
  if (!isVirtual.value) return "";
  const s = activeTab.value?.search;
  if (!s) return "搜索结果（已失效）";
  const scope = s.content ? `${s.pattern || "*"} +内容` : s.pattern || "*";
  const live = s.live ? " · 搜索中…" : "";
  return `🔍 ${scope}  —  ${s.root}${live}`;
});

// File listing state
const entries = ref([]);
const loading = ref(false);
const error = ref("");
const selectedEntry = ref(null);
const selectedEntries = ref([]);
const cutNames = ref([]);
const hasParent = ref(false);
const drives = ref([]);
const dirSizes = ref({});
const pendingSelectName = ref(null);

// Per-tab listing cache so switching tabs is instant (no per-tab "Loading…"
// flash). Keyed by tab id → { path, entries, hasParent }. Background-preloaded
// for inactive tabs after the active one loads.
const tabCache = ref({});
let preloaded = false;
// Tracks in-flight `loadDirectory` calls keyed by `${tabId}:${path}` so two
// watchers firing on the same tab switch (the path watcher + the active-tab
// watcher) collapse into a single backend request.
const inFlightLoads = new Set();

// Discovered external extraction tools (filled on mount).
const archiveTools = ref([]);

// Right-click context menu state.
const ctxMenu = ref({ visible: false, x: 0, y: 0, items: [] });
// Which entry the open menu was invoked on (null = background).
const ctxEntry = ref(null);

// Lightweight toast (mirrors App.vue's, kept local so this panel is self-contained).
const toast = ref({ visible: false, text: "", type: "info" });
let toastTimer = null;
function showToast(text, type = "info") {
  toast.value = { visible: true, text, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.visible = false; }, 3200);
}

// ── Persistence helpers ──
// Tabs (per panel) are persisted to ~/.minitc/tabs-<panelId>.json via the
// generic backend config commands, replacing the old localStorage approach.

async function saveState() {
  // Search-results tabs are deliberately NOT persisted: their rows are an
  // in-memory snapshot of a scan that may already be stale, and the whole
  // point of the tab is to be disposable. They are skipped here so a restart
  // never resurrects an empty `minitc://search/…` tab.
  const persistable = tabs.value.filter((t) => !isSearchPath(t.path));
  const state = {
    tabs: persistable.map((t) => ({
      id: t.id,
      path: t.path,
      sortColumn: t.sortColumn,
      sortDirection: t.sortDirection,
      // Persisted so a lock survives a restart — TC keeps locked tabs' anchor
      // dirs across sessions too. Old files simply lack the field (undefined
      // = unlocked), which is exactly the desired fallback.
      lockedPath: t.lockedPath || "",
      // Directory history (Alt+← / Alt+→) travels with the tab. Capped on write
      // by MAX_HISTORY during navigation; re-capped here so a hand-edited file
      // can't bloat the config.
      nav: t.nav
        ? {
            entries: (t.nav.entries || []).slice(-MAX_HISTORY),
            index: t.nav.index,
          }
        : undefined,
    })),
    // Never point at a tab we just filtered out.
    activeTabId: persistable.some((t) => t.id === activeTabId.value)
      ? activeTabId.value
      : persistable.length
        ? persistable[0].id
        : 0,
  };
  try {
    await saveConfig(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to persist tabs:", e);
  }
}

async function loadState() {
  // 1) Unified ~/.minitc store.
  try {
    const raw = await loadConfig(STORAGE_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state.tabs && state.tabs.length) return state;
    }
  } catch {
    /* fall through to migration */
  }

  // 2) Migrate legacy localStorage data, then remove it so the two stores
  //    don't drift apart.
  try {
    const legacy = localStorage.getItem(`mini-tc-tabs-${props.panelId}`);
    if (legacy) {
      localStorage.removeItem(`mini-tc-tabs-${props.panelId}`);
      const state = JSON.parse(legacy);
      if (state.tabs && state.tabs.length) {
        await saveConfig(STORAGE_KEY, legacy); // promote to the unified store
        return state;
      }
    }
  } catch {
    /* fall through */
  }

  return null;
}

// Watch for state changes and persist
watch(
  () => tabs.value.map((t) => ({
    id: t.id,
    path: t.path,
    sortColumn: t.sortColumn,
    sortDirection: t.sortDirection,
    lockedPath: t.lockedPath || "",
    // Deep-copied so the watcher fires on entries/index changes (walking back
    // and forth must be persisted, not just path switches).
    nav: t.nav ? { entries: [...(t.nav.entries || [])], index: t.nav.index } : null,
  })),
  () => { activeTabId.value && saveState(); },
  { deep: true }
);
watch(activeTabId, (newId) => { newId && saveState(); });

// ── Lifecycle ──

onMounted(async () => {
  mark(`panel:${props.panelId}:onMounted`);
  // Drives are only needed for the PathBar dropdown; `list_directory` already
  // supplies `hasParent`, so we don't need this before the first listing. Load
  // it in the background so it never delays showing the file list.
  track(`panel:${props.panelId}:drives`, refreshDrives());

  // Archive-extraction tools (7-Zip / WinRAR / unzip) are discovered lazily on
  // the first right-click (see ensureArchiveTools). Scanning the filesystem for
  // them — especially the C:..Z: drive walk in `get_archive_tools` — is the
  // single biggest source of launch latency, so it is deliberately kept off the
  // startup path.

  // Try to restore saved state — this is the only await that gates the first
  // directory listing, and it's a single tiny file read.
  const saved = await track(`panel:${props.panelId}:loadState`, loadState());
  if (saved) {
    // Normalise restored tabs: `lockedPath` was added after the first release,
    // so older ~/.minitc/tabs-*.json files simply don't have it. Defaulting to
    // "" keeps every tab unlocked instead of leaving `undefined` in the state
    // (which would then get written back as-is by saveState).
    tabs.value = saved.tabs.map((t) => ({
      sortColumn: "name",
      sortDirection: "asc",
      ...t,
      lockedPath: t.lockedPath || "",
      // History was added after the first release, so older
      // ~/.minitc/tabs-*.json files simply don't have it. Seed it from the
      // restored path so Alt+← has somewhere to go from the first move;
      // `navOf` repairs any malformed shape lazily on first use.
      nav: t.nav && Array.isArray(t.nav.entries) && t.nav.entries.length
        ? { entries: [...t.nav.entries], index: t.nav.index }
        : { entries: [t.path], index: 0 },
    }));
    activeTabId.value = saved.activeTabId;
  } else {
    // First launch: create initial tab with home directory
    let homePath = "/";
    try {
      homePath = await track(`panel:${props.panelId}:getHomeDir`, getHomeDir());
    } catch {
      homePath = "/";
    }
    createTab(homePath);
  }
});

// Reload the drive list (letter + free/total space shown in the PathBar
// dropdown). Called on mount and whenever the window regains focus (via
// App.vue's `tauri://focus` handler) so the free-space figures stay current
// for both panels after the user has been doing work outside mini-tc.
// Non-Windows hosts return no drive letters, so PathBar hides the selector
// anyway; we just let the cheap call run and swallow failures.
function refreshDrives() {
  // Returns the promise so callers can measure it (boot instrumentation);
  // a failure here is non-fatal and simply keeps the last known drive list.
  return listDrives()
    .then((d) => { drives.value = d; })
    .catch(() => { /* keep last known drives on failure */ });
}

// Reload when active tab path changes. If this tab's listing is already cached
// (e.g. it was background-preloaded, or we're returning to a previously visited
// tab), apply it instantly with no "Loading…" flash, then refresh it in the
// background so a tab switch never leaves a stale listing behind.
watch(
  () => activeTab.value?.path,
  (newPath) => {
    if (!newPath) return;
    const tab = activeTab.value;
    const cached = tabCache.value[tab.id];
    if (cached && cached.path === newPath) {
      entries.value = cached.entries;
      hasParent.value = cached.hasParent;
      // Silent background refresh: keep the cached listing on screen (no
      // "Loading…" flash) while fetching the current contents.
      trackFirstLoad(loadDirectory(newPath, tab.id, { silent: true }));
    } else {
      trackFirstLoad(loadDirectory(newPath, tab.id));
    }
  }
);

// Whenever the active tab changes (including switches to a tab whose path is
// identical to the previous one — a case the path watcher above does NOT fire
// for), refresh the drive free-space readout shown in the PathBar dropdown and
// force a fresh file listing for the now-active tab. This guarantees the drive
// capacity figures and the file list stay current after the user has been
// doing work in another tab or panel. The path watcher handles the visible
// path-change case; loadDirectory's in-flight guard collapses any duplicate
// request into one backend call.
watch(activeTabId, (newId) => {
  if (!newId) return;
  refreshDrives();
  const tab = tabs.value.find((t) => t.id === newId);
  if (tab) {
    // Drop the cache so this switch always re-fetches from disk (no stale view).
    if (tabCache.value[newId]) delete tabCache.value[newId];
    trackFirstLoad(loadDirectory(tab.path, newId, { silent: true }));
  }
});

// ── Tab management ──

// Tab id must be unique within the panel — it's the `:key` of the v-for, the
// key of the per-tab listing cache, and the `activeTabId` selector. A raw
// Date.now() can collide when two tabs are created inside the same
// millisecond (e.g. a burst of Ctrl+T), which would silently merge them, so
// nudge the clock forward until the id is free.
let lastTabId = 0;
function nextTabId() {
  let id = Date.now();
  if (id <= lastTabId) id = lastTabId + 1;
  lastTabId = id;
  // Ids restored from ~/.minitc/tabs-<panelId>.json are arbitrary past
  // timestamps, so also bump past anything already on the panel.
  while (tabs.value.some((t) => t.id === id)) id += 1;
  return id;
}

function createTab(path) {
  const tab = {
    id: nextTabId(),
    path,
    sortColumn: "name",
    sortDirection: "asc",
    // Locked-tab anchor dir. Empty = not locked (see toggleTabLock).
    lockedPath: "",
    // Per-tab directory history for Alt+← / Alt+→. Seeded with the opening
    // directory so there is something to go back to from the very first move.
    nav: { entries: [path], index: 0 },
    // Non-null only for a "search results" pseudo-directory: { root, pattern,
    // hits, live, searchId, done }. Kept on the tab (not in a module-level
    // variable) so two search tabs in the same panel can't tread on each other.
    search: null,
  };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  return tab;
}

// Open a search-results pseudo-directory in this panel. `hits` are entries
// already carrying absolute `path`s; `live` means the backend scan is
// still running and further batches will be appended in place.
function openSearchTab({ root, pattern, content, caseSensitive, includeHidden, hits, live, searchId, done }) {
  const tab = createTab(makeSearchPath(nextTabId()));
  tab.search = {
    root: root || "",
    pattern: pattern || "",
    content: content || "",
    caseSensitive: !!caseSensitive,
    includeHidden: !!includeHidden,
    hits: hits || [],
    live: !!live,
    searchId: searchId || 0,
    done: done || null,
  };
  // Default to "search order" (the backend's DFS walk, so results stay grouped
  // by their parent directory). Unlike a real listing there is no single
  // directory to float to the top, and re-sorting a live result set mid-scan
  // would make rows jump under the cursor.
  if (hits && hits.length > 1) {
    tab.sortColumn = "found";
    tab.sortDirection = "asc";
  }
  activeTabId.value = tab.id;
  loadDirectory(tab.path, tab.id);
  return tab;
}

function addTab() {
  // Ctrl+T on a search-results tab would clone the sentinel path, producing a
  // second tab that claims to be the same (already consumed) result set. Open
  // the search's ROOT directory instead — a real, useful starting point.
  const cur = activeTab.value?.path || "/";
  createTab(isSearchPath(cur) ? activeTab.value?.search?.root || "/" : cur);
}

function closeTab(id) {
  if (tabs.value.length <= 1) return;

  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;

  // Drop any cached listing for the closed tab.
  if (tabCache.value[id]) delete tabCache.value[id];

  const closing = tabs.value[idx];
  // A still-running scan would keep walking the disk and pushing batches at a
  // tab that no longer exists. Stop it — but only when no other tab in this
  // panel is showing the same search.
  if (closing && closing.search && closing.search.live) {
    const stillShown = tabs.value.some(
      (t) => t.id !== id && t.search && t.search.searchId === closing.search.searchId
    );
    if (!stillShown) cancelSearch().catch(() => {});
  }

  tabs.value.splice(idx, 1);

  // If we closed the active tab, switch to adjacent
  if (activeTabId.value === id) {
    const newIdx = Math.min(idx, tabs.value.length - 1);
    activeTabId.value = tabs.value[newIdx].id;
  }
}

function switchTab(id) {
  activeTabId.value = id;
}

// Total Commander 的 Ctrl+Tab / Ctrl+Shift+Tab：在本栏的标签页之间轮换，
// 到末尾回到第一个（环绕，不是停在最后一个）。只在 >1 个标签时有意义。
// 返回切换后的标签，供调用方在 toast 里报出落点。
function cycleTab(delta) {
  if (tabs.value.length <= 1) return null;
  const idx = tabs.value.findIndex((t) => t.id === activeTabId.value);
  const from = idx === -1 ? 0 : idx;
  const next = (from + delta + tabs.value.length) % tabs.value.length;
  activeTabId.value = tabs.value[next].id;
  return tabs.value[next];
}

// ── Tab lock (Total Commander's "Lock tab, directory changes allowed") ──
//
// Locking records the CURRENT directory as an anchor (`tab.lockedPath`) and
// nothing else: the tab keeps navigating freely, exactly like TC's
// "锁定，但允许更改文件夹" mode. `jumpToLocked` then snaps back to the anchor.
// A plain `Ctrl+Shift+L` toggle is the primary entry; the tab right-click menu
// exposes the same actions (plus "relock here").
//
// Note we deliberately do NOT re-anchor while the user browses — that would
// make the lock pointless. Re-anchoring only happens on an explicit lock.

function toggleTabLock(id = activeTabId.value) {
  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return null;
  // Locking records a real directory as an anchor; a search-results tab has
  // none, so the whole concept doesn't apply. Report it so the caller can say so.
  if (isSearchPath(tab.path)) return { ok: false, reason: "virtual" };
  if (tab.lockedPath) {
    tab.lockedPath = "";
    return { locked: false, tab };
  }
  tab.lockedPath = tab.path;
  return { locked: true, tab };
}

// Re-anchor a locked tab at wherever it currently is (TC has no direct
// equivalent, but it is the natural third item next to lock / jump back).
function relockTabAtCurrentPath(id = activeTabId.value) {
  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return null;
  tab.lockedPath = tab.path;
  return { locked: true, tab };
}

// Jump the tab back to its anchor. Reports why it did nothing so App.vue can
// surface a toast instead of silently swallowing the keypress.
function jumpToLocked(id = activeTabId.value) {
  const tab = tabs.value.find((t) => t.id === id);
  if (!tab) return { ok: false, reason: "none" };
  if (!tab.lockedPath) return { ok: false, reason: "unlocked" };
  if (tab.lockedPath === tab.path) return { ok: false, reason: "same" };
  setPath(tab, tab.lockedPath);
  return { ok: true, path: tab.lockedPath };
}

// ── Tab right-click menu ──

const tabMenu = ref({ visible: false, x: 0, y: 0, items: [], tabId: null });

function onTabMenu({ tabId, x, y }) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (!tab) return;
  const virtual = isSearchPath(tab.path);
  // Locking anchors a real directory, and "relock here" needs one too — both
  // are meaningless for a search-results tab, so they're replaced by actions
  // that do make sense there.
  const items = virtual
    ? [
        { label: "重新搜索", action: "rerun-search" },
        { label: "跳到搜索根目录", action: "goto-root" },
        { separator: true },
        { label: "关闭此标签页", action: "close", disabled: tabs.value.length <= 1 },
      ]
    : [
        { label: tab.lockedPath ? "解除锁定" : "锁定当前位置", action: "toggle-lock" },
        { label: "回到锁定位置", action: "jump-locked", disabled: !tab.lockedPath },
        { label: "以当前目录重新锁定", action: "relock", disabled: !tab.lockedPath },
        { separator: true },
        { label: "关闭此标签页", action: "close", disabled: tabs.value.length <= 1 },
      ];
  tabMenu.value = { visible: true, x, y, items, tabId };
}

function closeTabMenu() {
  tabMenu.value = { ...tabMenu.value, visible: false };
}

function handleTabMenuSelect(item) {
  const id = tabMenu.value.tabId;
  closeTabMenu();
  if (item.disabled) return;
  const tab = tabs.value.find((t) => t.id === id);
  switch (item.action) {
    case "toggle-lock":
      toggleTabLock(id);
      break;
    case "jump-locked":
      jumpToLocked(id);
      break;
    case "relock":
      relockTabAtCurrentPath(id);
      break;
    case "rerun-search":
      // Re-running only makes sense on the tab that owns the results, so switch
      // to it first — otherwise a right-click on a background tab would
      // refresh what the user isn't even looking at.
      if (tab && activeTabId.value !== id) activeTabId.value = id;
      rerunSearch();
      break;
    case "goto-root": {
      const root = tab && tab.search && tab.search.root;
      if (root) {
        tab.search = null;
        setPath(tab, root);
      }
      break;
    }
    case "close":
      closeTab(id);
      break;
  }
}

// ── Navigation history (Alt+← back / Alt+→ forward) ──
//
// Every TAB owns its own history stack, persisted together with the tab in
// ~/.minitc/tabs-<panelId>.json — so after a restart you can still walk back
// the directories you visited. Shape: { entries: string[], index: number },
// where `entries[index]` is ALWAYS the tab's current path. That makes
// entries[0..index] the back trail and entries[index+1..] the forward trail.
//
// The stack is deliberately NOT a browser-global undo list: each tab is its
// own browsing session, exactly like Total Commander's per-panel directory
// history.
//
// ⚠️ EVERY path change must go through `setPath()` below — that is the single
// place that records history. Assigning `tab.path` directly (there are several
// such sites: locked-tab jump, tab-menu "go to search root", open-container,
// …) silently skips the history and breaks Alt+← in a way that is very hard to
// trace back.

/// Longest history kept per tab. Bounded so a long browsing session can't grow
/// ~/.minitc/tabs-*.json without limit; the oldest entries are dropped.
const MAX_HISTORY = 100;

/// The tab's history stack WITHOUT any healing side effect.
///
/// Never mutate from here — this is read by computeds, and a computed that
/// writes reactive state re-triggers itself (the classic "computed with side
/// effects" trap). `navOf` below is the only place allowed to repair a stack,
/// and it is called from the navigation paths, not from render-time code.
function peekNav(tab) {
  if (!tab) return null;
  if (!tab.nav || !Array.isArray(tab.nav.entries)) return null;
  if (!Number.isInteger(tab.nav.index)) return null;
  if (tab.nav.index < 0 || tab.nav.index >= tab.nav.entries.length) return null;
  return tab.nav;
}

/// The tab's history stack, created on demand (tabs restored from an older
/// config file have none) and self-healing if it was ever persisted malformed.
///
/// ⚠️ Call this BEFORE mutating `tab.path`, and only from the navigation paths —
/// never from a computed (see `peekNav`). The repair branch exists solely for
/// hand-edited / truncated config files; during normal navigation a "cursor not
/// on the current path" state is INTENTIONAL (stepHistory moves it first), and
/// healing it there would corrupt the stack.
function navOf(tab) {
  const cur = tab.path || "";
  if (!tab.nav || !Array.isArray(tab.nav.entries)) {
    tab.nav = { entries: cur ? [cur] : [], index: cur ? 0 : -1 };
    return tab.nav;
  }
  // Defensive normalisation: a hand-edited / truncated config could leave the
  // index out of range, which would make back/forward jump somewhere arbitrary.
  if (!Number.isInteger(tab.nav.index)) tab.nav.index = -1;
  if (tab.nav.index >= tab.nav.entries.length) tab.nav.index = tab.nav.entries.length - 1;
  // Repair only a genuinely broken stack: one where the current directory isn't
  // recorded AT ALL. A cursor merely parked elsewhere is left alone — that's the
  // normal state between picking a destination and arriving at it.
  if (cur && !tab.nav.entries.includes(cur)) {
    tab.nav.entries = tab.nav.entries.slice(0, tab.nav.index + 1);
    tab.nav.entries.push(cur);
    tab.nav.index = tab.nav.entries.length - 1;
  }
  return tab.nav;
}

/// Set a tab's current directory, recording it in the tab's history.
///
/// `opts.record` is false for the back/forward moves themselves — those walk
/// the existing stack instead of pushing onto it (standard browser semantics:
/// going back then navigating somewhere new discards the forward trail).
/// `opts.skipHeal` suppresses `navOf`'s desync repair, for callers that have
/// already positioned the cursor on the destination (stepHistory) — there the
/// mismatch is intentional, and healing would splice the path we came FROM
/// back into the stack as a bogus extra entry.
function setPath(tab, newPath, opts = {}) {
  if (!tab || !newPath) return;
  const oldPath = tab.path;
  if (oldPath === newPath) return;

  // Leaving the result set for a real directory (or vice versa) invalidates the
  // stack: a `minitc://search/…` sentinel is not a directory you can return to,
  // so we don't keep it as a history entry. The real destination becomes the
  // new starting point instead.
  const wasVirtual = isSearchPath(oldPath);
  const isVirtualNow = isSearchPath(newPath);

  // ⚠️ ORDER MATTERS: resolve (and if needed create/repair) the stack while
  // `tab.path` is still the OLD directory. `navOf` anchors on `tab.path`, so
  // calling it after the assignment below would read the desync as "current
  // path isn't in the stack", push the new path to fix it — and then the
  // recording logic would push the very same path a second time, leaving
  // `entries = [.., new, new]`. Back would then appear to do nothing on the
  // first press (it lands on the duplicate, the same directory) and only move
  // on the second — the "have to press it twice" symptom.
  const nav = peekNav(tab) || navOf(tab);

  tab.path = newPath;

  if (opts.record === false) return;
  if (isVirtualNow) {
    // Entering a search-results tab: nothing to remember.
    tab.nav = { entries: [], index: -1 };
    return;
  }
  if (wasVirtual) {
    // Coming out of a search tab — start a fresh trail at the real directory.
    nav.entries = [newPath];
    nav.index = 0;
    return;
  }
  // New navigation: everything after the current position is now unreachable.
  nav.entries = nav.entries.slice(0, nav.index + 1);
  nav.entries.push(newPath);
  if (nav.entries.length > MAX_HISTORY) {
    nav.entries = nav.entries.slice(nav.entries.length - MAX_HISTORY);
  }
  nav.index = nav.entries.length - 1;
}

/// True when the active tab can go back / forward.
/// Read-only (`peekNav`, never `navOf`): computeds must not write reactive
/// state, or they re-trigger themselves on every evaluation.
const canGoBack = computed(() => {
  if (isVirtual.value) return false;
  const nav = peekNav(activeTab.value);
  return !!nav && nav.index > 0;
});

const canGoForward = computed(() => {
  if (isVirtual.value) return false;
  const nav = peekNav(activeTab.value);
  return !!nav && nav.index >= 0 && nav.index < nav.entries.length - 1;
});

/// Last segment of a path ("" for a drive root like `C:\`).
function leafName(p) {
  return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
}

/// Move the active tab `delta` steps through its history (−1 = back, +1 =
/// forward). Directories that no longer exist are dropped from the stack on
/// the way, so a folder deleted (or a drive unmounted) since the last visit
/// can't strand the panel on an error screen — we keep walking towards the
/// next reachable entry.
async function stepHistory(delta) {
  const tab = activeTab.value;
  if (!tab) return { ok: false, reason: "none" };
  if (isVirtual.value) return { ok: false, reason: "virtual" };

  const nav = navOf(tab);
  const from = tab.path;
  let start = nav.index;
  let dropped = 0;
  let i = start + delta;

  while (i >= 0 && i < nav.entries.length) {
    const candidate = nav.entries[i];
    let alive = false;
    try {
      alive = await pathExists(candidate);
    } catch {
      alive = false;
    }
    if (alive) {
      nav.index = i;
      // Coming back to a directory: select the folder we just left, the way a
      // browser highlights the previous page. FileList ignores the name when it
      // isn't there (e.g. after jumping several levels at once).
      pendingSelectName.value = leafName(from) || null;
      setPath(tab, candidate, { record: false });
      return { ok: true, path: candidate, dropped };
    }
    // Vanished — forget it and keep looking in the same direction. Splicing
    // shifts everything after it, so `start` and `i` are corrected per
    // direction: removing an entry BEFORE the cursor moves both left, while
    // removing one AFTER it leaves `i` already pointing at the next candidate.
    dropped += 1;
    nav.entries.splice(i, 1);
    if (delta < 0) {
      start -= 1;
      i -= 1;
    }
  }

  // Nothing left in that direction. Put the cursor back where it started so the
  // stack is left exactly as we found it (minus the dead entries).
  nav.index = Math.max(0, Math.min(start, nav.entries.length - 1));
  return { ok: false, reason: "edge", dropped };
}

function goBack() {
  return stepHistory(-1);
}

function goForward() {
  return stepHistory(1);
}

// ── Navigation ──

// Boot instrumentation: time only the very first listing of this panel —
// later loads are user-driven and would just be noise in the startup timeline.
// Two watchers (path + active tab) can both kick off that first load; the
// in-flight guard collapses them into one request, and this flag keeps the
// timeline to a single row.
let firstLoadTracked = false;
function trackFirstLoad(promise) {
  if (firstLoadTracked) return promise;
  firstLoadTracked = true;
  const tracked = track(`panel:${props.panelId}:first-listing`, promise);
  // Tell the splash screen (src/main.js) that this panel has content, so it
  // can dismiss as soon as both panels are populated instead of waiting out a
  // fixed delay. Fires on failure too — an error listing must still let the
  // user through to the UI.
  tracked.finally(() => {
    window.dispatchEvent(new CustomEvent("minitc:panel-listed"));
  });
  return tracked;
}

// Load a directory and cache the result by tab id. When `tabId` is not the
// active tab, the listing runs purely in the background (warming the cache) and
// never touches the visible UI / loading flag — this is what makes tab switches
// instant. `hasParent` now comes straight from `list_directory`, eliminating a
// second round-trip per load.
// `opts.silent` (used for tab-switch refreshes) skips the "Loading…" flash and
// selection/error reset: the previous listing stays on screen until the fresh
// one arrives, so a switch feels instant yet always shows current contents.
async function loadDirectory(path, tabId = activeTabId.value, opts = {}) {
  const silent = !!opts.silent;
  const isActive = tabId === activeTabId.value;
  const key = `${tabId}:${path}`;
  // Collapse duplicate in-flight loads (e.g. a tab switch that triggers both the
  // path watcher and the active-tab watcher) into a single backend request.
  if (inFlightLoads.has(key)) return;
  inFlightLoads.add(key);

  if (isActive && !silent) {
    loading.value = true;
    error.value = "";
    selectedEntry.value = null;
    selectedEntries.value = [];
    cutNames.value = [];
    dirSizes.value = {};
  }
  try {
    // A search-results tab has no directory to list — its rows live in the
    // tab's own `search.hits` array. Serving them here (rather than
    // special-casing every caller) keeps the whole rest of the panel working
    // unchanged: sorting, selection, preview, delete, F5 all just see entries.
    if (isSearchPath(path)) {
      const tab = tabs.value.find((t) => t.id === tabId);
      const s = tab && tab.search;
      if (isActive) {
        entries.value = s ? s.hits : [];
        hasParent.value = false; // no ".." row in a result set
        if (!s) error.value = "搜索结果已失效";
      }
      tabCache.value[tabId] = { path, entries: s ? s.hits : [], hasParent: false };
      return;
    }
    const res = await listDirectory(path);
    tabCache.value[tabId] = { path, entries: res.entries, hasParent: res.has_parent };
    if (isActive) {
      entries.value = res.entries;
      hasParent.value = res.has_parent;
      // Warm the rest of the tabs in the background now that the active one is
      // ready, so switching to them is also instant.
      if (!preloaded) {
        preloaded = true;
        preloadOtherTabs();
      }
    }
  } catch (e) {
    // Don't cache a failed load — allow a retry on the next switch/refresh.
    if (tabCache.value[tabId]) delete tabCache.value[tabId];
    if (isActive && !silent) {
      error.value = String(e);
      entries.value = [];
      hasParent.value = false;
    } else if (isActive && silent) {
      // Background refresh failed: keep the existing listing on screen rather
      // than wiping it; just log so the failure isn't invisible.
      console.warn("Background refresh failed:", e);
    }
  } finally {
    inFlightLoads.delete(key);
    if (isActive && !silent) loading.value = false;
  }
}

// Preload every non-active tab's directory in the background. Each result is
// stored in `tabCache`; the UI only picks it up when that tab becomes active.
function preloadOtherTabs() {
  for (const t of tabs.value) {
    // Search-results tabs are excluded: their rows are already in memory, and
    // "preloading" one would mean snapshotting a live scan that is still
    // growing.
    if (isSearchPath(t.path)) continue;
    if (t.id !== activeTabId.value && !tabCache.value[t.id]) {
      loadDirectory(t.path, t.id);
    }
  }
}

function navigateTo(newPath) {
  if (!activeTab.value) return;
  // Any explicit navigation (breadcrumb, path bar, "open containing folder")
  // leaves the search-results state — the tab is now a real directory.
  activeTab.value.search = null;
  setPath(activeTab.value, newPath);
}

async function navigateInto(entryOrName) {
  if (!activeTab.value) return;
  const entry =
    typeof entryOrName === "string" ? { name: entryOrName } : entryOrName;
  if (!entry || !entry.name) return;
  // Entering a directory row inside a search-results listing switches THIS tab
  // to the real directory (Total Commander behaves the same way: following a
  // hit takes you out of the result set and into the filesystem). The absolute
  // path on the row is what makes this work — a name-only join would resolve
  // against the sentinel `minitc://search/…` path and fail.
  const newPath = await entryPath(entry, activeTab.value.path);
  // Leaving the result set for a real directory: the tab is no longer virtual.
  activeTab.value.search = null;
  setPath(activeTab.value, newPath);
}

async function navigateParent() {
  if (!activeTab.value) return;
  // A search-results tab has no parent directory. The ".." row isn't rendered
  // (hasParent = false), so this is only reachable via the Backspace shortcut.
  if (isSearchPath(activeTab.value.path)) {
    showToast("搜索结果列表没有上级目录", "info");
    return;
  }
  try {
    // Remember current folder name so we can re-select it in the parent listing
    const currentName = activeTab.value.path.split(/[\\/]/).filter(Boolean).pop() || "";
    const parent = await getParentDir(activeTab.value.path);
    if (parent && parent.length > 0) {
      pendingSelectName.value = currentName;
      setPath(activeTab.value, parent);
    }
  } catch {
    // Already at root
  }
}

// `opts.force` distinguishes an EXPLICIT user refresh (the ↻ button, or the
// tab context menu) from the passive re-list fired on every window-focus regain
// and after a delete/extract. Only the explicit form may re-run a search.
async function refresh(opts = {}) {
  if (!activeTab.value) return;
  // Refreshing a search-results tab means re-running the scan, not re-listing
  // a directory (there isn't one). Drop the stale rows first so the panel
  // doesn't keep showing results the user asked to discard.
  if (isSearchPath(activeTab.value.path)) {
    const s = activeTab.value.search;
    if (!s) return;
    // A passive `refresh()` — the kind fired on every window-focus regain —
    // must NOT kick off a full disk rescan behind the user's back. Only an
    // explicit refresh (the ↻ button) does that; see `force`.
    if (!opts.force) return;
    if (s.live) {
      showToast("搜索仍在进行中，无需刷新", "info");
      return;
    }
    await rerunSearch();
    return;
  }
  {
    // A pending selection (e.g. set by rename/delete/parent-navigation) takes
    // priority over the current selection snapshot.
    const pending = pendingSelectName.value;
    // Snapshot the current selection (by name) so we can restore it after the
    // reload. This keeps the user's selection intact across a window focus
    // regain (App.vue's `tauri://focus` → refresh) instead of silently
    // clearing it whenever the entries reference is replaced.
    const keepNames = pending ? [] : selectedEntries.value.map((e) => e.name);
    // Force a real reload by dropping the cached entry first.
    const id = activeTab.value.id;
    if (tabCache.value[id]) delete tabCache.value[id];
    await loadDirectory(activeTab.value.path, id);
    // loadDirectory has now replaced `entries`; the file list reset its
    // selection. Re-apply the saved names (those still present; external
    // deletions are dropped automatically).
    if (pending) {
      pendingSelectName.value = null;
      fileListRef.value?.restoreByNames?.([pending]);
    } else if (keepNames.length) {
      fileListRef.value?.restoreByNames?.(keepNames);
    }
  }
}

// ── Search-results tabs ──
// A search tab owns its result rows and, while the scan is still running,
// its own `search-batch` / `search-done` listeners. The dialog hands the
// running search over with `openSearchTab(..., { live: true })`; from that
// moment the panel is the consumer and the dialog only keeps its own copy for
// display. Both sides filter on the search id, so a stale batch can never
// land in a tab it doesn't belong to.

const MAX_SEARCH_RESULTS = 5000;

async function rerunSearch() {
  const tab = activeTab.value;
  const s = tab && tab.search;
  if (!s) return;
  // A fresh id so the previous scan's trailing batches are ignored.
  const id = Date.now() % 1000000;
  s.searchId = id;
  s.hits = [];
  s.live = true;
  s.done = null;
  entries.value = [];
  ensureSearchListeners();
  try {
    await startSearch(id, {
      root: s.root,
      pattern: s.pattern,
      content: s.content,
      caseSensitive: s.caseSensitive,
      includeHidden: s.includeHidden,
      maxResults: MAX_SEARCH_RESULTS,
    });
  } catch (e) {
    s.live = false;
    error.value = String(e);
    showToast("搜索失败：" + String(e), "error");
  }
}

let unlistenBatch = null;
let unlistenDone = null;

function ensureSearchListeners() {
  if (unlistenBatch) return;
  const unwrap = (event, name) => {
    const p = event && event.payload;
    if (!p || typeof p !== "object") {
      console.warn(`[panel-search] ${name}: event carried no payload`, event);
      return null;
    }
    return p;
  };
  // `listen` hands back an Event WRAPPER { event, id, payload } — the payload
  // is on `.payload`, and `Event.id` is a global sequence number unrelated to
  // our search id. Reading `payload.id` off the wrapper would never match.
  unlistenBatch = listen("search-batch", (event) => {
    const p = unwrap(event, "search-batch");
    if (!p) return;
    const tab = tabs.value.find((t) => t.search && t.search.searchId === p.id);
    if (!tab) return; // stale scan, or one we no longer display
    if (tab.search.hits.length >= MAX_SEARCH_RESULTS) return;
    tab.search.hits.push(...(p.hits || []));
    if (tab.id === activeTabId.value) entries.value = tab.search.hits;
  });
  unlistenDone = listen("search-done", (event) => {
    const p = unwrap(event, "search-done");
    if (!p) return;
    const tab = tabs.value.find((t) => t.search && t.search.searchId === p.id);
    if (!tab) return;
    tab.search.live = false;
    tab.search.done = p;
    // Rows may have been dropped by the cap; make the visible list authoritative.
    if (tab.id === activeTabId.value) entries.value = tab.search.hits;
    if (p.cancelled) showToast("搜索已取消", "info");
    else if (p.truncated) showToast(`结果已达上限（${MAX_SEARCH_RESULTS}）`, "info");
  });
}

// The listeners above are installed lazily on the first hand-off and live as
// long as the panel does (both panels are permanent for the window's life), so
// there is normally nothing to tear down. Still unlisten on unmount rather
// than leave a backend push feeding a dead component.
onBeforeUnmount(() => {
  unlistenBatch?.();
  unlistenBatch = null;
  unlistenDone?.();
  unlistenDone = null;
});

// ── Sorting ──

function handleSort(column) {
  if (!activeTab.value) return;
  if (activeTab.value.sortColumn === column) {
    activeTab.value.sortDirection = activeTab.value.sortDirection === "asc" ? "desc" : "asc";
  } else {
    activeTab.value.sortColumn = column;
    activeTab.value.sortDirection = "asc";
  }
}

// ── Selection ──

function onSelect(entries, active) {
  selectedEntries.value = entries || [];
  selectedEntry.value = active || null;
}

// Total size of selected *files* only — directories contribute 0 (their sizes
// are not enumerated and the user asked to ignore folder sizes).
const selectedSize = computed(() =>
  selectedEntries.value.reduce((sum, e) => sum + (e.is_dir ? 0 : (e.size || 0)), 0)
);

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return (i === 0 ? String(bytes) : v.toFixed(1)) + " " + units[i];
}

// Mark the given entry names as "cut" (pending move) so FileList can ghost them.
function setCutNames(names) {
  cutNames.value = names || [];
}

function clearCut() {
  cutNames.value = [];
}

async function calcDirSize(entryOrName) {
  if (!activeTab.value) return;
  // Called with the entry (virtual directories need its absolute path) but we
  // keep accepting a bare name so the template's `:name` usage keeps working.
  const entry =
    typeof entryOrName === "string" ? { name: entryOrName } : entryOrName;
  if (!entry || !entry.name) return;
  const fullPath = await entryPath(entry, activeTab.value.path);
  // Key the cache the same way FileList reads it: by path in a search-results
  // tab (same-named folders from different parents can both be listed).
  const key = isSearchPath(activeTab.value.path)
    ? fullPath
    : entry.name;
  // Show loading state
  dirSizes.value = { ...dirSizes.value, [key]: -1 };
  try {
    const size = await getDirSize(fullPath);
    dirSizes.value = { ...dirSizes.value, [key]: size };
  } catch (e) {
    console.error("Failed to calculate dir size:", e);
    // Remove the loading placeholder on error
    const next = { ...dirSizes.value };
    delete next[key];
    dirSizes.value = next;
  }
}

// ── Delete ──

// `opts.permanent` (Shift+Delete) deletes outright instead of trashing. There
// is deliberately NO confirmation dialog: Shift+Delete is already a deliberate
// gesture, and the entry is removed from the list immediately on success —
// errors (locked / read-only / missing) surface as toasts or the UAC prompt.
async function onDelete(targets, opts = {}) {
  if (!activeTab.value) return;
  const list = Array.isArray(targets) ? targets : [targets];
  if (list.length === 0) return;
  const permanent = opts.permanent === true;

  const remove = permanent ? deletePermanently : deleteToTrash;

  const successNames = [];
  const successPaths = [];    // absolute paths, for exact row removal
  const failed = [];        // delete failed → auto-retry with admin
  const adminLaunched = []; // admin delete was accepted (UAC approved)

  for (const entry of list) {
    const fullPath = await entryPath(entry, activeTab.value.path);
    try {
      await remove(fullPath);
      successNames.push(entry.name);
      successPaths.push(fullPath);
    } catch (e) {
      const m = e && typeof e === "object" && e.message ? e.message : String(e);
      // A missing path is not worth an elevation prompt — report it directly.
      if (e && e.kind === "not_found") {
        showToast(`「${entry.name}」${m}`, "error");
        continue;
      }
      failed.push({ entry, fullPath });
    }
  }

  // Remove entries that were successfully deleted. Match on the ABSOLUTE path,
  // not the name: a search-results tab can legitimately contain two rows with
  // the same name coming from different folders, and deleting one of them must
  // not take its namesake with it.
  if (successPaths.length) {
    const removed = new Set(successPaths);
    entries.value = entries.value.filter((e) => !removed.has(e.path));
    const next = { ...dirSizes.value };
    // Drop both keyings — the row may have been cached under its name (real
    // directory) or its path (search-results tab).
    successNames.forEach((n) => delete next[n]);
    successPaths.forEach((p) => delete next[p]);
    dirSizes.value = next;
    // Keep the tab's own snapshot in sync — it is the source of truth for a
    // search tab, and anything that re-applies it (a refresh, a tab switch back)
    // would otherwise resurrect the deleted rows.
    const tab = activeTab.value;
    if (tab && tab.search) {
      tab.search.hits = tab.search.hits.filter((e) => !removed.has(e.path));
    }
    // Free space on the drive changed (trash or permanent delete), so refresh
    // the capacity readout shown in the PathBar drive dropdown.
    refreshDrives();
  }

  // 通知父组件删除结果（含本面板剩余条目数），供「预览中删光目录 → 自动退出预览」联动。
  emit("deleted", { panelId: props.panelId, remainingCount: entries.value.length });

  // For failed items: retry with admin elevation immediately. The UAC prompt
  // serves as the user's confirmation — no need for an extra dialog.
  if (failed.length === 0) return;

  for (const f of failed) {
    try {
      await deleteWithAdmin(f.fullPath);
      adminLaunched.push(f);
    } catch (e) {
      const m =
        e && typeof e === "object" && e.message ? e.message : String(e);
      showToast(`提权删除「${f.entry.name}」失败：${m}`, "error");
    }
  }

  if (adminLaunched.length > 0) {
    showToast(
      adminLaunched.length === failed.length
        ? `已发起 ${adminLaunched.length} 个项目管理员删除，请在 UAC 弹窗确认`
        : `已发起 ${adminLaunched.length} 个项目管理员删除（${failed.length - adminLaunched.length} 个失败），请在 UAC 弹窗确认`,
      "success"
    );
    // Elevated delete runs in its own process; delay-refresh to pick up results,
    // then re-check empty state so the preview can exit if the whole directory
    // is now gone.
    setTimeout(() => {
      refresh().then(() => {
        emit("deleted", { panelId: props.panelId, remainingCount: entries.value.length });
      });
      refreshDrives();
    }, 2000);
  }
}

// ── Rename ──

async function onRename(entry, newName) {
  if (!activeTab.value) return;
  const oldPath = await entryPath(entry, activeTab.value.path);
  try {
    await renameFile(oldPath, newName);
    // Re-select by the new name so the caret stays on the row (matching
    // Explorer). In a search-results directory there is nothing to re-list —
    // the rows are a detached snapshot — so patch the row in place instead.
    if (isSearchPath(activeTab.value.path)) {
      const newPath = (parentDirOf(oldPath) || oldPath) + "\\" + newName;
      const row = entries.value.find((e) => e.path === oldPath);
      if (row) {
        row.name = newName;
        row.extension = newName.includes(".")
          ? newName.split(".").pop().toUpperCase()
          : "";
        row.path = newPath;
      }
      // `entries` keeps its identity here (same array, one row mutated), so
      // FileList's entries watcher never fires and a pending selection would
      // never be consumed. Re-select the row directly instead.
      nextTick(() => fileListRef.value?.selectName?.(newName));
      return;
    }
    pendingSelectName.value = newName;
    await refresh();
  } catch (e) {
    error.value = String(e);
    showToast("重命名失败：" + String(e), "error");
  }
}

// ── Open file ──

async function onOpen(fileNameOrEntry) {
  if (!activeTab.value) return;
  const entry =
    typeof fileNameOrEntry === "string" ? { name: fileNameOrEntry } : fileNameOrEntry;
  if (!entry || !entry.name) return;
  const fullPath = await entryPath(entry, activeTab.value.path);

  // Double-clicking any file opens it with the OS default app/player. Videos
  // are no exception — the in-app video preview is still reachable via Ctrl+Q
  // (toggle preview), so we don't open it here on double-click.
  try {
    await openFile(fullPath);
  } catch (e) {
    console.error("[onOpen] openFile failed:", e);
    error.value = String(e);
  }
}

// ── Right-click context menu ──

function closeCtxMenu() {
  ctxMenu.value = { ...ctxMenu.value, visible: false };
}

// Which entries an "extract" action applies to. When the right-clicked row is
// part of a multi-selection, every selected archive is extracted (in listing
// order); otherwise just the right-clicked archive. Non-archives inside the
// selection are skipped.
function extractTargets(entry) {
  const sel = selectedEntries.value || [];
  const inSelection = entry && sel.some((e) => e.name === entry.name);
  const pool = inSelection && sel.length > 1 ? sel : entry ? [entry] : [];
  const order = new Map(entries.value.map((e, i) => [e.name, i]));
  return pool
    .filter((e) => e && !e.is_dir && isArchiveName(e.name))
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
}

// Build the menu items for the given entry (null = empty background).
function buildMenuItems(entry) {
  const items = [];
  if (!entry) {
    // "新建目录" needs a real parent directory; a search-results tab doesn't
    // have one, so offer only the actions that still make sense.
    if (!isSearchPath(activeTab.value?.path || "")) {
      items.push({ label: "新建目录", action: "new-folder" });
      items.push({ separator: true });
    }
    items.push({ label: "刷新", action: "refresh" });
    return items;
  }

  if (entry.is_dir) {
    items.push({ label: "进入目录", action: "open" });
  } else {
    items.push({ label: "打开", action: "open" });
  }
  // In a search-results tab, double-click / Enter opens the FILE wherever it
  // lives rather than navigating — so the containing directory (which may be
  // in a completely different part of the tree) needs its own explicit action.
  if (isSearchPath(activeTab.value?.path || "")) {
    items.push({ label: "打开所在目录", action: "open-container" });
  }
  items.push({ label: "重命名", action: "rename" });
  items.push({ label: "复制路径", action: "copy-path" });

  const extractSet = extractTargets(entry);
  if (extractSet.length > 0) {
    items.push({ separator: true });
    if (archiveTools.value.length === 0) {
      items.push({ label: "未检测到 7-Zip 等压缩工具", disabled: true });
    } else {
      // Extraction goes through each tool's GUI, which prompts for a password
      // on encrypted archives and lets the user pick the destination. Only the
      // GUI entries are listed (one per tool) to avoid duplicates.
      // When several archives are selected, every one of them is extracted in
      // listing order — the count is shown so it's obvious the action is a
      // batch, not a single file.
      const suffix = extractSet.length > 1 ? `（依次解压 ${extractSet.length} 个）` : "";
      for (const tool of archiveTools.value) {
        if (!tool.syntax.endsWith("-gui")) continue;
        items.push({
          label: `用 ${tool.name} 解压${suffix}`,
          action: "extract",
          tool,
          mode: "to_folder",
          targets: extractSet,
        });
      }
    }
  }

  // "Add to archive" works for any plain file or directory (including the
  // currently multi-selected set, when the right-clicked row is part of it).
  items.push({ separator: true });
  const compressTools = archiveTools.value.filter((t) =>
    ["7z-gui", "7z-cli", "7z", "winrar-gui", "winrar"].includes(t.syntax)
  );
  if (compressTools.length === 0) {
    items.push({ label: "未检测到 7-Zip 等压缩工具", disabled: true });
  } else {
    items.push({ label: "添加到压缩包", action: "add-to-archive" });
  }
  return items;
}

// Lazily discover external archive tools on first use. The filesystem scan is
// expensive (drive walk for 7-Zip/WinRAR), so it is intentionally deferred from
// startup to here, and cached so it only runs once per panel.
let archiveToolsPromise = null;
function ensureArchiveTools() {
  if (archiveToolsPromise) return archiveToolsPromise;
  archiveToolsPromise = getArchiveTools()
    .then((t) => { archiveTools.value = t; return t; })
    .catch((e) => {
      console.warn("get_archive_tools failed:", e);
      archiveTools.value = [];
      return [];
    });
  return archiveToolsPromise;
}

// Open the context menu at the cursor for the given entry.
async function onCtxMenu({ entry, x, y }) {
  ctxEntry.value = entry;
  // Ensure the archive-tool list is available before building the menu (first
  // right-click only; afterwards it's cached and instant).
  await ensureArchiveTools();
  ctxMenu.value = { visible: true, x, y, items: buildMenuItems(entry) };
}

// Dispatch a menu selection.
async function handleCtxSelect(item) {
  closeCtxMenu();
  if (item.disabled) return;
  const entry = ctxEntry.value;
  const path = activeTab.value?.path;
  if (!path) return;

  switch (item.action) {
    case "open":
      if (entry.is_dir) {
        navigateInto(entry);
      } else {
        onOpen(entry);
      }
      break;
    case "open-container": {
      const full = await entryPath(entry, path);
      const dir = parentDirOf(full);
      if (dir) {
        activeTab.value.search = null;
        setPath(activeTab.value, dir);
      }
      break;
    }
    case "copy-path": {
      const full = await entryPath(entry, path);
      copyTextToClipboard(full);
      break;
    }
    case "refresh":
      refresh({ force: true });
      break;
    case "new-folder":
      await doNewFolder();
      break;
    case "rename":
      fileListRef.value?.startRenameByEntry?.(entry);
      break;
    case "extract": {
      // Batch case: the menu item carries the full set of selected archives
      // (see extractTargets); fall back to the right-clicked row alone.
      const targets = item.targets?.length ? item.targets : extractTargets(entry);
      await doExtract(targets, item.tool, item.mode);
      break;
    }
    case "add-to-archive":
      await doAddToArchive();
      break;
  }
}

// Compute a non-colliding name for a new folder in the current directory,
// matching Explorer: "新建文件夹", then "新建文件夹 (2)", "新建文件夹 (3)"…
function uniqueNewFolderName() {
  const existing = new Set(entries.value.map((e) => e.name));
  const base = "新建文件夹";
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

// Create a new empty directory in the current directory (triggered by the
// right-click "新建目录" menu item). After creation we refresh the listing and
// immediately drop the new folder into inline-rename, mirroring Explorer's
// "create + edit name" flow.
async function doNewFolder() {
  const path = activeTab.value?.path;
  if (!path) return;
  // A search-results directory has no real parent to create anything inside —
  // its rows merely *look* co-located. Refuse rather than silently creating
  // the folder in the search's root directory.
  if (isSearchPath(path)) {
    showToast("搜索结果列表无法新建目录，请先跳转到实际目录", "error");
    return;
  }
  const name = uniqueNewFolderName();
  const full = await joinPath(path, name);
  try {
    await createDirectory(full);
    // Pre-select by name so the watch in FileList lands the caret on it, then
    // enter inline rename once the refreshed listing includes the new folder.
    pendingSelectName.value = name;
    await refresh();
    const entry = entries.value.find((e) => e.name === name);
    if (entry) {
      fileListRef.value?.startRenameByEntry?.(entry);
    }
  } catch (e) {
    showToast("新建目录失败：" + String(e), "error");
  }
}

// Compress the current selection (or the right-clicked entry) into a single
// archive named after the current folder, using the first available CLI tool.
async function doAddToArchive() {
  const path = activeTab.value?.path;
  if (!path) return;

  // The set to compress: the full multi-selection when it's non-empty (the
  // right-clicked row is part of it), otherwise just this entry.
  let targets = selectedEntries.value;
  if (!targets || targets.length === 0) {
    if (!entry) return;
    targets = [entry];
  }

  const compressTools = archiveTools.value.filter((t) =>
    ["7z-gui", "7z-cli", "7z", "winrar-gui", "winrar"].includes(t.syntax)
  );
  if (compressTools.length === 0) {
    showToast("未检测到 7-Zip 等压缩工具，无法压缩", "error");
    return;
  }
  const tool = compressTools[0];
  const isGui = tool.syntax === "7z-gui" || tool.syntax === "winrar-gui";

  // Archive name = current folder name (matches Explorer's "Compressed folder").
  // A search-results directory has no meaningful "current folder", so name the
  // archive after the first selected item instead — and, crucially, write the
  // archive NEXT TO THAT ITEM rather than into the sentinel path.
  const fromResultSet = isSearchPath(path);
  const sources = [];
  for (const t of targets) {
    sources.push(await entryPath(t, path));
  }
  const baseDir = fromResultSet ? parentDirOf(sources[0]) : path;
  if (!baseDir) {
    showToast("无法确定压缩包的目标位置", "error");
    return;
  }
  const firstName = (targets[0] && targets[0].name) || "";
  const stem = firstName.includes(".")
    ? firstName.split(".")[0]
    : firstName;
  const folderName = fromResultSet
    ? stem || "archive"
    : path.split(/[\\/]/).filter(Boolean).pop() || "archive";

  try {
    const res = await addToArchive(sources, baseDir, folderName, tool.exe, tool.syntax);
    if (res && res.success) {
      showToast(res.message, "success");
      // GUI tools build the archive asynchronously in their own window (and
      // may prompt for a password), so don't refresh immediately. CLI tools
      // finish synchronously, so refresh to reveal the new archive. In a
      // search-results directory refresh() re-runs the search rather than
      // re-listing, which is equally correct here.
      if (!isGui) refresh();
    } else {
      showToast("压缩失败", "error");
    }
  } catch (e) {
    showToast("压缩失败：\n" + String(e), "error");
  }
}

// Run an external extractor over one or more archives and refresh the panel
// afterwards. `targets` is extracted strictly in order: GUI tools are waited
// on (bounded) so only one tool window is open at a time, and CLI tools run to
// completion before the next archive starts.
async function doExtract(targets, tool, mode) {
  const path = activeTab.value?.path;
  if (!path) return;
  const list = (targets || []).filter(Boolean);
  if (list.length === 0) return;

  const isGui = tool?.syntax === "7z-gui" || tool?.syntax === "winrar-gui";
  // Only make the backend wait when there is actually a queue behind it, so a
  // single archive still returns immediately like before.
  const wait = isGui && list.length > 1;

  let done = 0;
  let lastMessage = "";
  const failed = [];
  // A batch can take a while (password prompts included), so say what's
  // happening up front instead of leaving the UI silent until the last file.
  if (list.length > 1) showToast(`正在依次解压 ${list.length} 个压缩包…`, "info");

  for (const entry of list) {
    const fullArchive = await entryPath(entry, path);
    // Extract next to the archive itself. In a real directory that is the
    // current dir; in a search-results directory the rows come from many
    // parents, so each archive must land in its OWN folder — extracting them
    // all into one (possibly non-existent) target would scatter output.
    const destDir = isSearchPath(path) ? parentDirOf(fullArchive) : path;
    if (!destDir) {
      failed.push(entry.name);
      continue;
    }
    try {
      const res = await extractArchive(fullArchive, destDir, tool.exe, tool.syntax, mode, wait);
      if (res && res.success) {
        done++;
        lastMessage = res.message || "";
      } else {
        failed.push(entry.name);
      }
    } catch (e) {
      console.error("[doExtract] failed:", entry.name, e);
      failed.push(entry.name);
    }
  }

  if (list.length === 1) {
    if (done === 1) showToast(lastMessage || "已解压", "success");
    else showToast(`解压失败：${list[0].name}`, "error");
  } else {
    const parts = [`已解压 ${done}/${list.length} 个压缩包`];
    if (failed.length) parts.push(`失败：${failed.join("、")}`);
    showToast(parts.join("\n"), failed.length ? "error" : "success");
  }

  // GUI tools work in their own window (and may prompt for a password), so
  // nothing new shows up until they are finished — unless we waited for them,
  // in which case the results are already on disk. CLI tools are synchronous.
  if (done > 0 && (!isGui || wait)) refresh();
}

// Copy text to the OS clipboard, falling back to a hidden textarea + execCommand
// when the async Clipboard API is unavailable.
function copyTextToClipboard(text) {
  const done = () => showToast("已复制路径", "info");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch {
    showToast("复制路径失败", "error");
  }
}

// Expose selectedEntry and currentPath for parent access (preview feature)
const fileListRef = ref(null);

defineExpose({
  selectedEntry,
  selectedEntries,
  currentPath: computed(() => activeTab.value?.path || ""),
  // Tab 管理（由 App.vue 的全局快捷键 Ctrl+T / Ctrl+W 驱动，作用于活动面板）
  addTab,
  closeActiveTab: () => closeTab(activeTabId.value),
  // Tab 轮换（Ctrl+Tab / Ctrl+Shift+Tab）
  cycleTab,
  // Tab 锁定（Ctrl+Shift+L / Ctrl+Y）。返回结果供 App.vue 弹 toast，
  // 让「没锁定 / 已在锁定位置」这类空操作对用户可见。
  toggleLock: () => toggleTabLock(activeTabId.value),
  jumpToLocked: () => jumpToLocked(activeTabId.value),
  // Directory history（Alt+← / Alt+→）。返回结果供 App.vue 弹 toast，让「已在
  // 最前/最后一条」这类空操作对用户可见；`canGoBack` / `canGoForward` 让调用方
  // 提前知道该不该处理这次按键。
  canGoBack: () => canGoBack.value,
  canGoForward: () => canGoForward.value,
  goBack,
  goForward,
  refresh,
  refreshDrives,
  // Jump the panel to an arbitrary directory (used by the search dialog's
  // "打开所在目录" action).
  goTo: (path) => navigateTo(path),
  // Open the given search hits as a pseudo-directory tab in THIS panel.
  // Called by the search dialog's 「送到面板」 action. A still-running scan is
  // handed over (`live: true`) and the panel keeps consuming its batches.
  openSearchResults: (payload) => {
    const tab = openSearchTab(payload);
    if (payload && payload.live) ensureSearchListeners();
    return { tabId: tab.id };
  },
  // True when the active tab is a search-results pseudo-directory (App.vue
  // uses this to block operations that need a real current directory).
  isVirtual: () => isVirtual.value,
  // Navigate to `dir` and select `name` inside it — how a search result is
  // revealed. Same directory → just move the selection; different directory →
  // arm `pendingSelectName` so the selection lands once the listing arrives
  // (FileList consumes it on the entries change, then emits
  // `pending-select-resolved`).
  revealFile: (dir, name) => {
    if (!activeTab.value || !dir) return;
    if (activeTab.value.path === dir) {
      fileListRef.value?.selectName?.(name);
    } else {
      pendingSelectName.value = name;
      navigateTo(dir);
    }
    nextTick(() => fileListRef.value?.focusList?.());
  },
  moveSelection: (delta) => fileListRef.value?.moveSelection(delta),
  selectName: (name) => fileListRef.value?.selectName(name),
  getNextVideoEntry: (name) => fileListRef.value?.getNextVideoEntry(name),
  selectAll: () => fileListRef.value?.selectAll(),
  clearSelection: () => fileListRef.value?.clearSelection(),
  restoreByNames: (names) => fileListRef.value?.restoreByNames(names),
  focusList: () => fileListRef.value?.focusList(),
  setCutNames,
  clearCut,
  // Forward drag-target highlighting (App.vue drives this from tauri://drag-*).
  setDragHighlight: (target) => fileListRef.value?.setDragHighlight(target),
});
</script>

<style scoped>
.file-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  overflow: hidden;
  position: relative;
}

.file-panel.active {
  border-color: var(--accent);
}

.panel-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 8px;
  background: var(--header-bg);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  min-height: 22px;
}

.loading-text {
  color: var(--accent);
}

/* ── Local toast (context-menu feedback) ── */

.panel-toast {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 90%;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-line;
  z-index: 300;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  text-align: center;
}

.panel-toast.toast-info {
  background: var(--panel-bg);
  color: var(--text);
  border: 1px solid var(--border);
}

.panel-toast.toast-success {
  background: #1f6f3f;
  color: #e8ffe8;
  border: 1px solid #2f9d5b;
}

.panel-toast.toast-error {
  background: #7a1f1f;
  color: #ffe8e8;
  border: 1px solid #c0392b;
}
</style>
