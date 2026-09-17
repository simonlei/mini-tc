<template>
  <div class="file-panel" :class="{ active: isActive }" :data-panel-id="panelId" @click="$emit('activate')">
    <!-- Tab bar -->
    <TabBar
      :tabs="tabs"
      :active-tab-id="activeTabId"
      @switch-tab="switchTab"
      @close-tab="closeTab"
      @add-tab="addTab"
    />

    <!-- Path bar -->
    <PathBar
      :path="activeTab ? activeTab.path : ''"
      :drives="drives"
      @navigate="navigateTo"
      @refresh="refresh"
    />

    <!-- File list -->
    <FileList
      ref="fileListRef"
      :entries="entries"
      :path="activeTab ? activeTab.path : ''"
      :sort-column="activeTab ? activeTab.sortColumn : 'name'"
      :sort-direction="activeTab ? activeTab.sortDirection : 'asc'"
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

    <!-- Panel status bar -->
    <div class="panel-status">
      <span>{{ entries.length }} items</span>
      <span v-if="selectedEntries.length">{{ selectedEntries.length }} selected · {{ formatBytes(selectedSize) }}</span>
      <span v-if="selectedEntry">{{ selectedEntry.name }}</span>
      <span v-if="loading" class="loading-text">Loading...</span>
    </div>

    <!-- Local toast (context-menu feedback: extract / copy path) -->
    <div class="panel-toast" v-if="toast.visible" :class="'toast-' + toast.type">{{ toast.text }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import TabBar from "./TabBar.vue";
import PathBar from "./PathBar.vue";
import FileList from "./FileList.vue";
import ContextMenu from "./ContextMenu.vue";
import { listDirectory, getHomeDir, getParentDir, joinPath, listDrives, getDirSize, deleteToTrash, deletePermanently, deleteWithAdmin, renameFile, openFile, createDirectory, loadConfig, saveConfig, getArchiveTools, extractArchive, addToArchive } from "../api.js";

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
  const state = {
    tabs: tabs.value.map((t) => ({
      id: t.id,
      path: t.path,
      sortColumn: t.sortColumn,
      sortDirection: t.sortDirection,
    })),
    activeTabId: activeTabId.value,
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
  () => tabs.value.map((t) => ({ id: t.id, path: t.path, sortColumn: t.sortColumn, sortDirection: t.sortDirection })),
  () => { activeTabId.value && saveState(); },
  { deep: true }
);
watch(activeTabId, (newId) => { newId && saveState(); });

// ── Lifecycle ──

onMounted(async () => {
  // Drives are only needed for the PathBar dropdown; `list_directory` already
  // supplies `hasParent`, so we don't need this before the first listing. Load
  // it in the background so it never delays showing the file list.
  refreshDrives();

  // Archive-extraction tools (7-Zip / WinRAR / unzip) are discovered lazily on
  // the first right-click (see ensureArchiveTools). Scanning the filesystem for
  // them — especially the C:..Z: drive walk in `get_archive_tools` — is the
  // single biggest source of launch latency, so it is deliberately kept off the
  // startup path.

  // Try to restore saved state — this is the only await that gates the first
  // directory listing, and it's a single tiny file read.
  const saved = await loadState();
  if (saved) {
    tabs.value = saved.tabs;
    activeTabId.value = saved.activeTabId;
  } else {
    // First launch: create initial tab with home directory
    let homePath = "/";
    try {
      homePath = await getHomeDir();
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
  listDrives()
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
      loadDirectory(newPath, tab.id, { silent: true });
    } else {
      loadDirectory(newPath, tab.id);
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
    loadDirectory(tab.path, newId, { silent: true });
  }
});

// ── Tab management ──

function createTab(path) {
  const tab = {
    id: Date.now(),
    path,
    sortColumn: "name",
    sortDirection: "asc",
  };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  return tab;
}

function addTab() {
  const currentPath = activeTab.value?.path || "/";
  createTab(currentPath);
}

function closeTab(id) {
  if (tabs.value.length <= 1) return;

  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;

  // Drop any cached listing for the closed tab.
  if (tabCache.value[id]) delete tabCache.value[id];

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

// ── Navigation ──

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
    if (t.id !== activeTabId.value && !tabCache.value[t.id]) {
      loadDirectory(t.path, t.id);
    }
  }
}

function navigateTo(newPath) {
  if (!activeTab.value) return;
  activeTab.value.path = newPath;
}

async function navigateInto(folderName) {
  if (!activeTab.value) return;
  const newPath = await joinPath(activeTab.value.path, folderName);
  activeTab.value.path = newPath;
}

async function navigateParent() {
  if (!activeTab.value) return;
  try {
    // Remember current folder name so we can re-select it in the parent listing
    const currentName = activeTab.value.path.split(/[\\/]/).filter(Boolean).pop() || "";
    const parent = await getParentDir(activeTab.value.path);
    if (parent && parent.length > 0) {
      pendingSelectName.value = currentName;
      activeTab.value.path = parent;
    }
  } catch {
    // Already at root
  }
}

async function refresh() {
  if (activeTab.value) {
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

async function calcDirSize(folderName) {
  if (!activeTab.value) return;
  const fullPath = await joinPath(activeTab.value.path, folderName);
  // Show loading state
  dirSizes.value = { ...dirSizes.value, [folderName]: -1 };
  try {
    const size = await getDirSize(fullPath);
    dirSizes.value = { ...dirSizes.value, [folderName]: size };
  } catch (e) {
    console.error("Failed to calculate dir size:", e);
    // Remove the loading placeholder on error
    const next = { ...dirSizes.value };
    delete next[folderName];
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
  const failed = [];        // delete failed → auto-retry with admin
  const adminLaunched = []; // admin delete was accepted (UAC approved)

  for (const entry of list) {
    const fullPath = await joinPath(activeTab.value.path, entry.name);
    try {
      await remove(fullPath);
      successNames.push(entry.name);
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

  // Remove entries that were successfully deleted.
  if (successNames.length) {
    const removed = new Set(successNames);
    entries.value = entries.value.filter((e) => !removed.has(e.name));
    const next = { ...dirSizes.value };
    successNames.forEach((n) => delete next[n]);
    dirSizes.value = next;
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
  const oldPath = await joinPath(activeTab.value.path, entry.name);
  try {
    await renameFile(oldPath, newName);
    // Reload the listing, then re-select the renamed entry by its new name so
    // the selection/caret stays on it (matching Explorer).
    pendingSelectName.value = newName;
    await refresh();
  } catch (e) {
    error.value = String(e);
    showToast("重命名失败：" + String(e), "error");
  }
}

// ── Open file ──

async function onOpen(fileName) {
  if (!activeTab.value) return;
  const fullPath = await joinPath(activeTab.value.path, fileName);

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
    items.push({ label: "新建目录", action: "new-folder" });
    items.push({ separator: true });
    items.push({ label: "刷新", action: "refresh" });
    return items;
  }

  if (entry.is_dir) {
    items.push({ label: "进入目录", action: "open" });
  } else {
    items.push({ label: "打开", action: "open" });
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
        navigateInto(entry.name);
      } else {
        onOpen(entry.name);
      }
      break;
    case "copy-path": {
      const full = await joinPath(path, entry.name);
      copyTextToClipboard(full);
      break;
    }
    case "refresh":
      refresh();
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
  const folderName = path.split(/[\\/]/).filter(Boolean).pop() || "archive";
  const sources = [];
  for (const t of targets) {
    sources.push(await joinPath(path, t.name));
  }

  try {
    const res = await addToArchive(sources, path, folderName, tool.exe, tool.syntax);
    if (res && res.success) {
      showToast(res.message, "success");
      // GUI tools build the archive asynchronously in their own window (and
      // may prompt for a password), so don't refresh immediately. CLI tools
      // finish synchronously, so refresh to reveal the new archive.
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
    const fullArchive = await joinPath(path, entry.name);
    try {
      const res = await extractArchive(fullArchive, path, tool.exe, tool.syntax, mode, wait);
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
  refresh,
  refreshDrives,
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
