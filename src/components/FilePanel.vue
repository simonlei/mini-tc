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
      :entries="entries"
      :sort-column="activeTab ? activeTab.sortColumn : 'name'"
      :sort-direction="activeTab ? activeTab.sortDirection : 'asc'"
      :loading="loading"
      :error="error"
      :has-parent="hasParent"
      @sort="handleSort"
      @navigate="navigateInto"
      @navigate-parent="navigateParent"
      @select="onSelect"
    />

    <!-- Panel status bar -->
    <div class="panel-status">
      <span>{{ entries.length }} items</span>
      <span v-if="selectedEntry">{{ selectedEntry.name }}</span>
      <span v-if="loading" class="loading-text">Loading...</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import TabBar from "./TabBar.vue";
import PathBar from "./PathBar.vue";
import FileList from "./FileList.vue";
import { listDirectory, getHomeDir, getParentDir, joinPath, listDrives } from "../api.js";

const props = defineProps({
  isActive: { type: Boolean, default: false },
  panelId: { type: String, required: true },
});

const emit = defineEmits(["activate"]);

const STORAGE_KEY = `mini-tc-tabs-${props.panelId}`;

// Tab state
const tabs = ref([]);
const activeTabId = ref(0);

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value));

// File listing state
const entries = ref([]);
const loading = ref(false);
const error = ref("");
const selectedEntry = ref(null);
const hasParent = ref(true);
const drives = ref([]);

// ── Persistence helpers ──

function saveState() {
  const state = {
    tabs: tabs.value.map((t) => ({
      id: t.id,
      path: t.path,
      sortColumn: t.sortColumn,
      sortDirection: t.sortDirection,
    })),
    activeTabId: activeTabId.value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state.tabs || state.tabs.length === 0) return null;
    return state;
  } catch {
    return null;
  }
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

  // Try to restore saved state
  const saved = loadState();
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
    const parent = await getParentDir(activeTab.value.path);
    if (parent && parent.length > 0) {
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

function onSelect(entry) {
  selectedEntry.value = entry;
}

// Expose selectedEntry and currentPath for parent access (preview feature)
defineExpose({
  selectedEntry,
  currentPath: computed(() => activeTab.value?.path || ""),
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
</style>
