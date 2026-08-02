<template>
  <div class="file-panel" :class="{ active: isActive }" @click="$emit('activate')">
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
      <span v-if="selectedEntries.length">{{ selectedEntries.length }} selected</span>
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
import { listDirectory, getHomeDir, getParentDir, joinPath, listDrives, getDirSize, deleteToTrash, openFile, loadConfig, saveConfig, getArchiveTools, extractArchive } from "../api.js";

// Extensions we consider extractable archives. Covers everything the bundled
// 7-Zip (and friends) can handle; the actual extraction is delegated to the
// external tool, so this list only gates which rows show the extract entries.
const ARCHIVE_EXTENSIONS = [
  "zip", "rar", "7z", "gz", "tar", "tgz", "bz2", "xz", "zst", "lz4",
  "cab", "iso", "wim", "jar", "apk", "deb", "rpm", "arj", "z", "lzh", "ace",
];

const props = defineProps({
  isActive: { type: Boolean, default: false },
  panelId: { type: String, required: true },
});

const emit = defineEmits(["activate", "open-video"]);

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
const hasParent = ref(true);
const drives = ref([]);
const dirSizes = ref({});
const pendingSelectName = ref(null);

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
  // Load drives for parent detection
  try {
    drives.value = await listDrives();
  } catch {
    drives.value = [];
  }

  // Discover external archive tools (7-Zip / WinRAR / unzip) so the right-click
  // menu can offer extraction. Failures are non-fatal — the menu simply shows
  // a "not installed" placeholder.
  try {
    archiveTools.value = await getArchiveTools();
  } catch (e) {
    console.warn("get_archive_tools failed:", e);
    archiveTools.value = [];
  }

  // Try to restore saved state
  const saved = await loadState();
  if (saved) {
    tabs.value = saved.tabs;
    activeTabId.value = saved.activeTabId;
    return;
  }

  // First launch: create initial tab with home directory
  let homePath;
  try {
    homePath = await getHomeDir();
  } catch {
    homePath = "C:\\";
  }
  createTab(homePath);
});

// Reload when active tab path changes
watch(
  () => activeTab.value?.path,
  (newPath) => {
    if (newPath) loadDirectory(newPath);
  }
);

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
  const currentPath = activeTab.value?.path || "C:\\";
  createTab(currentPath);
}

function closeTab(id) {
  if (tabs.value.length <= 1) return;

  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;

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

async function loadDirectory(path) {
  loading.value = true;
  error.value = "";
  selectedEntry.value = null;
  selectedEntries.value = [];
  cutNames.value = [];
  dirSizes.value = {};
  try {
    entries.value = await listDirectory(path);

    // Check if path has a parent
    try {
      const parent = await getParentDir(path);
      hasParent.value = parent && parent.length > 0;
    } catch {
      hasParent.value = false;
    }
  } catch (e) {
    error.value = String(e);
    entries.value = [];
  } finally {
    loading.value = false;
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
    const currentName = activeTab.value.path.split("\\").filter(Boolean).pop() || "";
    const parent = await getParentDir(activeTab.value.path);
    if (parent && parent.length > 0) {
      pendingSelectName.value = currentName;
      activeTab.value.path = parent;
    }
  } catch {
    // Already at root
  }
}

function refresh() {
  if (activeTab.value) {
    loadDirectory(activeTab.value.path);
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

async function onDelete(targets) {
  if (!activeTab.value) return;
  const list = Array.isArray(targets) ? targets : [targets];
  if (list.length === 0) return;

  const names = list.map((e) => e.name);
  for (const entry of list) {
    const fullPath = await joinPath(activeTab.value.path, entry.name);
    try {
      await deleteToTrash(fullPath);
    } catch (e) {
      error.value = String(e);
    }
  }

  // Remove the deleted entries locally instead of full refresh, so FileList can
  // restore selection. Multi-delete just clears the selection (handled by the
  // entries watch in FileList); single-delete re-selects the next neighbour.
  entries.value = entries.value.filter((e) => !names.includes(e.name));
  const next = { ...dirSizes.value };
  names.forEach((n) => delete next[n]);
  dirSizes.value = next;
}

// ── Open file ──

const VIDEO_EXTS = ["mp4", "webm", "ogv", "ogg", "mov", "m4v", "3gp", "mkv", "avi", "flv", "wmv", "rm", "rmvb", "asf", "vob", "ts", "m2ts", "m3u8", "mpg", "mpeg", "divx", "f4v"];

async function onOpen(fileName) {
  if (!activeTab.value) return;
  const fullPath = await joinPath(activeTab.value.path, fileName);
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  // Route video files to the in-app video preview instead of the OS player.
  if (VIDEO_EXTS.includes(ext)) {
    emit("open-video", { path: fullPath, name: fileName, bytes: selectedEntry.value?.size || 0, panelId: props.panelId });
    return;
  }

  console.log("[onOpen] fileName:", fileName, "fullPath:", fullPath);
  try {
    await openFile(fullPath);
    console.log("[onOpen] openFile succeeded");
  } catch (e) {
    console.error("[onOpen] openFile failed:", e);
    error.value = String(e);
  }
}

// ── Right-click context menu ──

function closeCtxMenu() {
  ctxMenu.value = { ...ctxMenu.value, visible: false };
}

// Build the menu items for the given entry (null = empty background).
function buildMenuItems(entry) {
  const items = [];
  if (!entry) {
    items.push({ label: "刷新", action: "refresh" });
    return items;
  }

  if (entry.is_dir) {
    items.push({ label: "进入目录", action: "open" });
  } else {
    items.push({ label: "打开", action: "open" });
  }
  items.push({ label: "复制路径", action: "copy-path" });

  const ext = (entry.extension || "").toLowerCase();
  if (ARCHIVE_EXTENSIONS.includes(ext)) {
    items.push({ separator: true });
    if (archiveTools.value.length === 0) {
      items.push({ label: "未检测到 7-Zip 等压缩工具", disabled: true });
    } else {
      const stem = entry.name.replace(/\.[^.]+$/, "");
      for (const tool of archiveTools.value) {
        items.push({
          label: `用 ${tool.name} 解压到当前文件夹`,
          action: "extract",
          tool,
          mode: "here",
        });
        items.push({
          label: `用 ${tool.name} 解压到 "${stem}"`,
          action: "extract",
          tool,
          mode: "to_folder",
        });
      }
    }
  }
  return items;
}

// Open the context menu at the cursor for the given entry.
function onCtxMenu({ entry, x, y }) {
  ctxEntry.value = entry;
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
    case "extract":
      await doExtract(entry, item.tool, item.mode);
      break;
  }
}

// Run an external extractor on the archive and refresh the panel afterwards.
async function doExtract(entry, tool, mode) {
  const path = activeTab.value?.path;
  if (!path) return;
  const fullArchive = await joinPath(path, entry.name);
  try {
    const res = await extractArchive(fullArchive, path, tool.exe, tool.syntax, mode);
    if (res && res.success) {
      showToast(res.message, "success");
      refresh();
    } else {
      showToast("解压失败", "error");
    }
  } catch (e) {
    showToast("解压失败：\n" + String(e), "error");
  }
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
  moveSelection: (delta) => fileListRef.value?.moveSelection(delta),
  selectAll: () => fileListRef.value?.selectAll(),
  clearSelection: () => fileListRef.value?.clearSelection(),
  setCutNames,
  clearCut,
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
