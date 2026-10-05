<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === activeTabId, locked: !!tab.lockedPath }"
      :title="tabTitle(tab)"
      @click="$emit('switch-tab', tab.id)"
      @contextmenu.prevent="$emit('tab-menu', { tabId: tab.id, x: $event.clientX, y: $event.clientY })"
      @auxclick="onAuxClick($event, tab.id)"
    >
      <span class="tab-icon">📁</span>
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
defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: [Number, String], default: 0 },
});

const emit = defineEmits(["switch-tab", "close-tab", "add-tab", "tab-menu"]);

function tabLabel(tab) {
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
  background: var(--tab-bg);
  font-size: 12px;
  transition: background 0.15s;
  flex-shrink: 0;
  max-width: 200px;
}

.tab:hover {
  background: var(--tab-hover);
}

.tab.active {
  background: var(--tab-active);
  border-bottom: 2px solid var(--accent);
}

/* Locked tab: the lock glyph carries the meaning, this only tints the tab so
   the locked one is findable when several tabs are open. */
.tab.locked {
  background: color-mix(in srgb, var(--tab-active) 70%, var(--accent) 12%);
}

.tab.locked.active {
  border-bottom-color: var(--accent);
}

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
