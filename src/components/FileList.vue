<template>
  <div class="file-list" tabindex="0" @keydown="onKeydown">
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

    <!-- Scrollable file entries -->
    <div class="file-entries" ref="entriesContainer">
      <!-- Parent dir entry -->
      <div
        v-if="hasParent"
        class="file-row parent-row"
        :class="{ selected: selectedIndex === -1 }"
        @click="selectedIndex = -1"
        @dblclick="$emit('navigate-parent')"
      >
        <div class="col-name"><span class="file-icon folder-icon">📁</span>..</div>
        <div class="col-size"></div>
        <div class="col-modified"></div>
      </div>

      <!-- Actual file entries -->
      <div
        v-for="(entry, index) in sortedEntries"
        :key="entry.name"
        class="file-row"
        :class="{
          selected: selectedIndex === index,
          'is-dir': entry.is_dir,
          'is-hidden': entry.is_hidden,
        }"
        @click="selectRow(index)"
        @dblclick="onDoubleClick(entry)"
      >
        <div class="col-name">
          <span class="file-icon" :class="entry.is_dir ? 'folder-icon' : 'file-icon-' + entry.extension.toLowerCase()">
            {{ entry.is_dir ? "📁" : getFileIcon(entry.extension) }}
          </span>
          <span class="file-name">{{ entry.name }}</span>
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

      <!-- Empty state -->
      <div v-if="sortedEntries.length === 0 && !loading" class="empty-state">Empty folder</div>
      <div v-if="error" class="error-state">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  entries: { type: Array, default: () => [] },
  sortColumn: { type: String, default: "name" },
  sortDirection: { type: String, default: "asc" },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
  hasParent: { type: Boolean, default: true },
  dirSizes: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["sort", "navigate", "navigate-parent", "select", "calc-dir-size", "delete"]);

const selectedIndex = ref(-1);
const entriesContainer = ref(null);
const pendingSelectName = ref(null);

// Reset selection when entries change, unless we have a pending selection from delete
watch(
  () => props.entries,
  () => {
    if (pendingSelectName.value) {
      const name = pendingSelectName.value;
      pendingSelectName.value = null;
      const idx = sortedEntries.value.findIndex((e) => e.name === name);
      if (idx >= 0) {
        selectRow(idx);
        scrollToRow(idx);
      } else {
        // File not found (e.g. folder became empty) — deselect
        selectedIndex.value = -1;
        emit("select", null);
      }
    } else {
      selectedIndex.value = -1;
      emit("select", null);
    }
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
      cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
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

function selectRow(index) {
  selectedIndex.value = index;
  const entry = sortedEntries.value[index];
  if (entry) emit("select", entry);
}

function scrollToRow(index, block = "nearest") {
  const container = entriesContainer.value;
  if (!container) return;
  // parent row (..) is the first .file-row when hasParent, so offset by 1
  const offset = props.hasParent ? 1 : 0;
  const row = container.querySelectorAll(".file-row")[offset + index];
  if (row) row.scrollIntoView({ block, behavior: "auto" });
}

function onDoubleClick(entry) {
  if (entry.is_dir) {
    emit("navigate", entry.name);
  }
}

function onKeydown(e) {
  const list = sortedEntries.value;
  if (list.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (selectedIndex.value < list.length - 1) {
      selectRow(selectedIndex.value + 1);
      scrollToRow(selectedIndex.value);
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (selectedIndex.value > -1) {
      selectRow(selectedIndex.value - 1);
      scrollToRow(selectedIndex.value);
    } else if (props.hasParent) {
      selectedIndex.value = -1;
    }
  } else if (e.key === "Home") {
    e.preventDefault();
    selectRow(0);
    scrollToRow(0, "start");
  } else if (e.key === "End") {
    e.preventDefault();
    selectRow(list.length - 1);
    scrollToRow(list.length - 1, "end");
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedIndex.value === -1) {
      emit("navigate-parent");
    } else {
      const entry = list[selectedIndex.value];
      if (entry && entry.is_dir) {
        emit("navigate", entry.name);
      }
    }
  } else if (e.key === "Backspace") {
    e.preventDefault();
    emit("navigate-parent");
  } else if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    if (selectedIndex.value >= 0) {
      const entry = list[selectedIndex.value];
      if (entry && entry.is_dir) {
        emit("calc-dir-size", entry.name);
      }
    }
  } else if (e.key === "Delete") {
    e.preventDefault();
    if (selectedIndex.value >= 0) {
      const entry = list[selectedIndex.value];
      if (entry) {
        // Determine which file to select after deletion
        if (selectedIndex.value < list.length - 1) {
          // Not the last: next file shifts into this position
          pendingSelectName.value = list[selectedIndex.value + 1].name;
        } else if (selectedIndex.value > 0) {
          // Last file: select the previous one (new last)
          pendingSelectName.value = list[selectedIndex.value - 1].name;
        } else {
          // Only file: nothing to select after deletion
          pendingSelectName.value = null;
        }
        emit("delete", entry);
      }
    }
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

function getFileIcon(ext) {
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
    ZIP: "🗜️",
    RAR: "🗜️",
    "7Z": "🗜️",
    GZ: "🗜️",
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
  };
  return icons[ext] || "📄";
}
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
