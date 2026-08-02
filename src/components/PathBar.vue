<template>
  <div class="path-bar">
    <!-- Drive selector -->
    <select
      class="drive-select"
      :value="currentDrive"
      @change="onDriveChange($event.target.value)"
      title="Switch drive"
    >
      <option v-for="d in drives" :key="d" :value="d">{{ driveLabel(d) }}</option>
    </select>

    <button class="path-btn" @click="$emit('refresh')" title="Refresh">↻</button>

    <div class="path-display">
      <!-- Breadcrumb mode (default) -->
      <div
        v-if="!editing"
        class="breadcrumb"
        :title="path"
        @dblclick="startEdit"
      >
        <template v-for="(seg, i) in segments" :key="i">
          <span class="sep" v-if="i > 0">›</span>
          <span
            class="crumb"
            :class="{ current: i === segments.length - 1 }"
            @click.stop="onCrumbClick(seg.path)"
            @dblclick.stop
          >{{ seg.label }}</span>
        </template>
      </div>

      <!-- Edit mode (only when explicitly requested) -->
      <div v-else class="path-input-wrapper">
        <input
          ref="inputRef"
          class="path-input"
          v-model="displayValue"
          @focus="onFocus"
          @blur="onBlur"
          @keydown.enter="onEnter"
          @keydown.esc="onEscape"
          spellcheck="false"
          :class="{ invalid: invalid }"
        />
      </div>
    </div>

    <button v-if="!editing" class="path-btn" @click="startEdit" title="Edit path">✎</button>

    <button class="path-btn" @click="copyPath" :title="copied ? 'Copied!' : 'Copy path'">
      {{ copied ? "✓" : "📋" }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { pathExists, expandPath } from "../api.js";

const props = defineProps({
  path: { type: String, default: "" },
  drives: { type: Array, default: () => [] },
});

const emit = defineEmits(["navigate", "refresh"]);

const inputRef = ref(null);
const editing = ref(false);
const invalid = ref(false);
const copied = ref(false);
const displayValue = ref(props.path);

// ── Breadcrumb parsing ──
// Split the (already-expanded) path into clickable segments. Each segment maps
// back to the full path of that level, so clicking a parent navigates up.
const segments = computed(() => {
  const raw = props.path;
  if (!raw) return [];
  const segs = [];

  // UNC: \\server\share\...
  if (raw.startsWith("\\\\")) {
    const m = raw.match(/^\\\\([^\\]+)\\([^\\]+)/);
    if (m) {
      const root = `\\${m[1]}\\${m[2]}`;
      segs.push({ label: root, path: root });
      let acc = root;
      const parts = raw.slice(root.length).split("\\").filter(Boolean);
      for (const p of parts) {
        acc += "\\" + p;
        segs.push({ label: p, path: acc });
      }
    }
  } else {
    const dm = raw.match(/^([A-Za-z]:)([\\/]?)([\s\S]*)$/);
    if (dm) {
      // Drive-rooted path: C:\Users\simon
      const drive = dm[1];
      segs.push({ label: drive, path: drive + "\\" });
      let acc = drive + "\\";
      const parts = dm[3].split(/[\\/]/).filter(Boolean);
      for (const p of parts) {
        acc += p + "\\";
        segs.push({ label: p, path: acc });
      }
    } else {
      // Relative / POSIX-style path
      const sep = raw.includes("\\") ? "\\" : "/";
      let acc = "";
      const parts = raw.split(/[\\/]/).filter(Boolean);
      for (const p of parts) {
        acc += (acc ? sep : "") + p;
        segs.push({ label: p, path: acc });
      }
    }
  }

  // Pin the final segment to the exact original path so trailing-slash
  // differences never cause an unexpected extra navigation.
  if (segs.length) segs[segs.length - 1].path = raw;
  return segs;
});

watch(
  () => props.path,
  (newPath) => {
    if (!editing.value) displayValue.value = newPath;
  }
);

const currentDrive = computed(() => {
  if (!props.path) return "";
  const p = props.path.replace(/[\\/:]/g, "").toLowerCase();
  for (const d of props.drives) {
    if (p.startsWith(d.replace(/[\\/:]/g, "").toLowerCase())) return d;
  }
  return "";
});

function driveLabel(d) {
  // On Windows, strip trailing backslash for display
  return d.replace(/[\\/:]+$/, "");
}

// ── Navigation ──

function onCrumbClick(target) {
  emit("navigate", target);
}

function onDriveChange(drive) {
  if (drive && drive !== currentDrive.value) {
    emit("navigate", drive);
  }
}

// ── Edit mode ──

function startEdit() {
  editing.value = true;
  displayValue.value = props.path;
  invalid.value = false;
  nextTick(() => {
    if (inputRef.value) {
      inputRef.value.focus();
      inputRef.value.select();
    }
  });
}

function onFocus() {
  editing.value = true;
  displayValue.value = props.path;
  setTimeout(() => {
    if (inputRef.value) inputRef.value.select();
  }, 0);
}

function onBlur() {
  editing.value = false;
  invalid.value = false;
  displayValue.value = props.path;
}

function onEnter() {
  const newPath = displayValue.value.trim();
  if (!newPath || newPath === props.path) {
    editing.value = false;
    if (inputRef.value) inputRef.value.blur();
    return;
  }
  expandPath(newPath).then((resolved) => {
    if (!resolved) {
      invalid.value = true;
      return;
    }
    pathExists(resolved).then((exists) => {
      if (exists) {
        invalid.value = false;
        emit("navigate", resolved);
        editing.value = false;
        if (inputRef.value) inputRef.value.blur();
      } else {
        invalid.value = true;
      }
    });
  });
}

function onEscape() {
  editing.value = false;
  invalid.value = false;
  displayValue.value = props.path;
  if (inputRef.value) inputRef.value.blur();
}

async function copyPath() {
  try {
    await navigator.clipboard.writeText(props.path);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    if (inputRef.value) {
      inputRef.value.focus();
      inputRef.value.select();
    }
  }
}
</script>

<style scoped>
.path-bar {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 4px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
}

.drive-select {
  padding: 2px 4px;
  font-size: 12px;
  font-family: var(--font-mono), "Consolas", monospace;
  background: var(--tab-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
  min-width: 48px;
}

.drive-select:focus {
  border-color: var(--accent);
}

.path-btn {
  padding: 2px 6px;
  font-size: 13px;
  background: var(--tab-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  min-width: 26px;
  text-align: center;
  cursor: pointer;
  color: var(--text);
}

.path-btn:hover {
  background: var(--hover);
}

.path-display {
  flex: 1;
  min-width: 0;
  display: flex;
}

.breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-family: "Consolas", "Cascadia Code", monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow-x: auto;
  cursor: text;
  scrollbar-width: thin;
}

.breadcrumb::-webkit-scrollbar {
  height: 6px;
}

.breadcrumb::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.crumb {
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 2px;
  border-radius: 2px;
  user-select: none;
}

.crumb:hover {
  color: var(--text);
  background: var(--hover);
  text-decoration: underline;
}

.crumb.current {
  color: var(--text);
  font-weight: 600;
  cursor: default;
}

.crumb.current:hover {
  background: transparent;
  text-decoration: none;
}

.sep {
  color: var(--text-dim);
  opacity: 0.6;
  user-select: none;
}

.path-input-wrapper {
  flex: 1;
  min-width: 0;
}

.path-input {
  width: 100%;
  padding: 2px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  outline: none;
  font-family: "Consolas", "Cascadia Code", monospace;
  font-size: 12px;
}

.path-input:focus {
  border-color: var(--accent);
}

.path-input.invalid {
  border-color: var(--danger);
}
</style>
