<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === activeTabId }"
      @click="$emit('switch-tab', tab.id)"
      @auxclick="onAuxClick($event, tab.id)"
    >
      <span class="tab-icon">📁</span>
      <span class="tab-name" :title="tab.path">{{ tabLabel(tab) }}</span>
      <button
        v-if="tabs.length > 1"
        class="tab-close"
        @click.stop="$emit('close-tab', tab.id)"
        title="Close tab"
      >
        ×
      </button>
    </div>
    <button class="tab-add" @click="$emit('add-tab')" title="New tab">
      +
    </button>
  </div>
</template>

<script setup>
defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: [Number, String], default: 0 },
});

const emit = defineEmits(["switch-tab", "close-tab", "add-tab"]);

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
