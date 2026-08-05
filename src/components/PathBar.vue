<template>
  <div class="path-bar">
    <!-- Drive selector (Windows only — macOS/Linux have a single root "/") -->
    <select
      v-if="showDriveSelector"
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
        ref="breadcrumbRef"
        :class="{ expanded }"
        :title="path"
        @dblclick="startEdit"
      >
        <div class="crumbs-row" :class="{ collapsed }">
          <!-- Collapsed: first › … › last (middle hidden behind ellipsis) -->
          <template v-if="collapsed && segments.length > 2">
            <span
              class="crumb"
              :title="segments[0].label"
              @click.stop="onCrumbClick(segments[0].path)"
            >{{ segments[0].label }}</span>
            <span class="sep">›</span>
            <button
              class="crumb-ellipsis"
              :title="expanded ? '收起中间目录' : '展开中间目录'"
              @click.stop="expanded = !expanded"
            >…</button>
            <span class="sep">›</span>
            <span
              class="crumb current"
              :title="segments[segments.length - 1].label"
              @click.stop="onCrumbClick(segments[segments.length - 1].path)"
            >{{ segments[segments.length - 1].label }}</span>
          </template>

          <!-- Expanded / short: full breadcrumb -->
          <template v-else>
            <button
              v-if="needsCollapse && expanded"
              class="crumb-ellipsis"
              title="收起中间目录"
              @click.stop="expanded = false"
            >‹</button>
            <template v-for="(seg, i) in segments" :key="i">
              <span class="sep" v-if="i > 0">›</span>
              <span
                class="crumb"
                :class="{ current: i === segments.length - 1, middle: i !== 0 && i !== segments.length - 1 }"
                :title="seg.label"
                @click.stop="onCrumbClick(seg.path)"
                @dblclick.stop
              >{{ seg.label }}</span>
            </template>
          </template>
        </div>

        <!-- Hidden measurement proxy: full path width, used to detect overflow -->
        <div class="crumbs-measure" ref="measureRef" aria-hidden="true">
          <span v-for="(seg, i) in segments" :key="i">
            <span class="m-sep" v-if="i > 0">›</span><span class="m-crumb">{{ seg.label }}</span>
          </span>
        </div>
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
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
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

// ── Breadcrumb overflow handling ──
// Long paths are collapsed (first › … › last) to avoid a horizontal scrollbar.
// `needsCollapse` is measured against a hidden full-width proxy; `expanded`
// is the user's temporary "show everything" toggle.
const breadcrumbRef = ref(null);
const measureRef = ref(null);
const needsCollapse = ref(false);
const expanded = ref(false);

const collapsed = computed(() => needsCollapse.value && !expanded.value);

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
      // Relative / POSIX-style path (macOS/Linux: /Users/simon/…)
      const sep = "/";
      // Absolute POSIX path starts with "/" — show root as first crumb.
      if (raw.startsWith("/")) {
        segs.push({ label: "/", path: "/" });
      }
      let acc = "";
      const parts = raw.split("/").filter(Boolean);
      for (const p of parts) {
        acc += sep + p;
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
    // Reset the expand toggle and re-measure on navigation.
    expanded.value = false;
    nextTick(measure);
  }
);

// Measure the full (un-collapsed) breadcrumb width against the visible
// container. The hidden `.crumbs-measure` proxy holds every segment, so its
// offsetWidth reflects the natural width regardless of the collapsed state.
function measure() {
  const container = breadcrumbRef.value;
  const proxy = measureRef.value;
  if (!container || !proxy) return;
  // +4px tolerance for border/padding rounding
  needsCollapse.value = proxy.offsetWidth > container.clientWidth + 4;
}

let resizeObserver = null;
let winResizeHandler = null;
let rafPending = false;

// Re-measure on resize, debounced via rAF to avoid layout thrash during a
// continuous window drag.
function scheduleMeasure() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    measure();
  });
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined" && breadcrumbRef.value) {
    resizeObserver = new ResizeObserver(() => scheduleMeasure());
    resizeObserver.observe(breadcrumbRef.value);
  }
  // Always also listen for window resize. In some webview/embedding setups a
  // flex child's ResizeObserver does not fire reliably on host-window resize,
  // so this guarantees the breadcrumb re-measures and reflows with the window.
  winResizeHandler = () => scheduleMeasure();
  window.addEventListener("resize", winResizeHandler);
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (winResizeHandler) {
    window.removeEventListener("resize", winResizeHandler);
    winResizeHandler = null;
  }
});

// Only show the drive-letter dropdown on Windows. On macOS/Linux the backend
// returns ["/"], so there's nothing to switch between — hide it entirely.
const showDriveSelector = computed(() =>
  props.drives.some((d) => /^[A-Za-z]:\\?$/.test(d))
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
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 2px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-family: "Consolas", "Cascadia Code", monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  cursor: text;
}

/* The breadcrumb never scrolls horizontally — overflow is always clipped.
   Expanding the "…" reveals the middle segments inline (each individually
   truncated with an ellipsis) instead of enabling a scrollbar. */
.crumbs-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.crumb {
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 2px;
  border-radius: 2px;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
  min-width: 0;
  /* Size to content (flex-basis auto) and never grow, so segments pack left at
     their natural character width instead of stretching to equal widths. Shrink
     is still allowed so long segments truncate with their own ellipsis. */
  flex: 0 1 auto;
}

.crumb.current {
  color: var(--text);
  font-weight: 600;
  cursor: default;
  flex-shrink: 0;
}

/* The drive letter / root should never shrink or get truncated. */
.crumb:first-child {
  flex-shrink: 0;
}

/* In collapsed mode, lock the first and current segments to their natural
   width so the drive letter (e.g. D:\) stays tiny and the long current folder
   is never pushed off-screen. In expanded/full mode every segment is
   content-sized (flex: 0 1 auto) and packed left, so a path like
   "C:\Users\simon\WorkBuddy\" shows four narrow, character-length segments with
   the spare space left-aligned on the right instead of being stretched to equal
   widths. */
.crumbs-row.collapsed .crumb:first-child,
.crumbs-row.collapsed .crumb.current {
  flex: 0 0 auto;
}

.crumb:hover {
  color: var(--text);
  background: var(--hover);
  text-decoration: underline;
}

.crumb.current:hover {
  background: transparent;
  text-decoration: none;
}

.crumb-ellipsis {
  flex: 0 0 auto;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
  font-family: inherit;
  border-radius: 2px;
}

.crumb-ellipsis:hover {
  color: var(--text);
  background: var(--hover);
}

.sep {
  color: var(--text-dim);
  opacity: 0.6;
  user-select: none;
  flex: 0 0 auto;
}

/* Hidden proxy used only to measure the full natural width of the path */
.crumbs-measure {
  position: absolute;
  left: 0;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
  font-family: "Consolas", "Cascadia Code", monospace;
  font-size: 12px;
  padding: 2px 8px;
}

.crumbs-measure .m-crumb {
  padding: 0 2px;
}

.crumbs-measure .m-sep {
  padding: 0 2px;
  opacity: 0.6;
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
