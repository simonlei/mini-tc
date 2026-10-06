<template>
  <!--
    Recursive file search (Total Commander's Alt+F7). Hits stream in from the
    backend as `search-batch` events, so a long scan stays responsive and can
    be stopped at any point.
  -->
  <div class="search-overlay" @click.self="$emit('close')">
    <div class="search-dialog">
      <div class="search-header">
        <span>文件搜索</span>
        <span class="header-hint">Alt+F7 · Total Commander 风格</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="search-form">
        <div class="form-row">
          <label class="form-label">搜索目录</label>
          <input
            v-model="root"
            class="form-input"
            type="text"
            spellcheck="false"
            @keydown.enter.prevent="run"
          />
          <button class="btn-ghost" title="填入当前活动面板的目录" @click="$emit('use-current-dir')">
            当前目录
          </button>
        </div>
        <div class="form-row">
          <label class="form-label">文件名</label>
          <input
            ref="patternInput"
            v-model="pattern"
            class="form-input"
            type="text"
            spellcheck="false"
            placeholder="*.txt;*.md 或关键字；留空 = 全部"
            @keydown.enter.prevent="run"
          />
        </div>
        <div class="form-row">
          <label class="form-label">包含内容</label>
          <input
            v-model="content"
            class="form-input"
            type="text"
            spellcheck="false"
            placeholder="可选：文件内容里包含的文字（自动跳过二进制与 >8MB 文件）"
            @keydown.enter.prevent="run"
          />
        </div>
        <div class="form-row options-row">
          <label class="opt">
            <input type="checkbox" v-model="caseSensitive" /> 区分大小写
          </label>
          <label class="opt">
            <input type="checkbox" v-model="includeHidden" /> 包含隐藏文件
          </label>
          <span class="spacer"></span>
          <button v-if="!searching" class="btn-primary" @click="run">搜索</button>
          <button v-else class="btn-stop" @click="stop">停止</button>
        </div>
      </div>

      <div class="search-status">
        <span v-if="searching" class="busy">搜索中…</span>
        <span>已扫描 {{ scanned.toLocaleString() }} 项</span>
        <span>找到 {{ matched.toLocaleString() }} 个</span>
        <span v-if="elapsed > 0">用时 {{ elapsed.toFixed(1) }}s</span>
        <span v-if="doneInfo?.cancelled" class="warn">已取消</span>
        <span v-if="doneInfo?.truncated" class="warn">结果已达上限（{{ MAX_RESULTS }}）</span>
        <span class="spacer"></span>
        <span v-if="hits.length" class="dim">双击 / 回车跳转到文件</span>
      </div>
      <p v-if="error" class="search-error">{{ error }}</p>
      <ul v-if="scanErrors.length" class="scan-errors">
        <li v-for="(e, i) in scanErrors" :key="i">{{ e }}</li>
      </ul>

      <!-- Virtualised result list: a scan can easily return tens of thousands
           of rows, so only the visible window is rendered. -->
      <div
        ref="viewportRef"
        class="result-viewport"
        tabindex="0"
        @scroll="onScroll"
        @keydown="onListKeydown"
      >
        <div class="result-spacer" :style="{ height: totalHeight + 'px' }">
          <div class="result-rows" :style="{ transform: `translateY(${offsetY}px)` }">
            <div
              v-for="(h, i) in visible"
              :key="h.path"
              class="result-row"
              :class="{ active: activeIndex === start + i }"
              :style="{ height: ROW_H + 'px' }"
              @click="activeIndex = start + i"
              @dblclick="reveal(h)"
              @contextmenu.prevent="openCtx($event, h)"
            >
              <span class="col-icon">{{ iconOf(h) }}</span>
              <span class="col-name" :title="h.name">{{ h.name }}</span>
              <span class="col-dir" :title="h.dir">{{ h.dir }}</span>
              <span class="col-size">{{ h.is_dir ? "" : formatSize(h.size) }}</span>
              <span class="col-time">{{ formatDate(h.modified) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!hits.length" class="result-empty">
          <span v-if="!hasRun">输入条件后按「搜索」开始</span>
          <span v-else-if="searching">正在搜索…</span>
          <span v-else>未找到匹配项</span>
        </div>
      </div>

      <div class="search-footer">
        <span class="footer-hint">右键结果可复制路径 / 打开所在目录</span>
        <button class="btn-secondary" @click="$emit('close')">关闭</button>
      </div>
    </div>

    <ContextMenu
      :visible="ctx.visible"
      :x="ctx.x"
      :y="ctx.y"
      :items="ctx.items"
      @close="ctx.visible = false"
      @select="onCtxSelect"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startSearch, cancelSearch, openFile } from "../api.js";
import ContextMenu from "./ContextMenu.vue";

const props = defineProps({
  // Directory the dialog opens with (the active panel's current path).
  initialPath: { type: String, default: "" },
});

const emit = defineEmits(["close", "reveal", "use-current-dir", "open-dir"]);

// Hard cap handed to the backend: a bare `*` over a whole drive would
// otherwise build an unbounded result list.
const MAX_RESULTS = 5000;
// Must match the CSS row height — the virtual scroller computes offsets from it.
const ROW_H = 24;

const root = ref(props.initialPath);
const pattern = ref("");
const content = ref("");
const caseSensitive = ref(false);
const includeHidden = ref(false);

const hits = ref([]);
const searching = ref(false);
const hasRun = ref(false);
const scanned = ref(0);
const matched = ref(0);
const elapsed = ref(0);
const doneInfo = ref(null);
const scanErrors = ref([]);
const error = ref("");
const activeIndex = ref(-1);

const patternInput = ref(null);
const viewportRef = ref(null);

let searchId = 0;
let startedAt = 0;
let ticker = null;
let unlistenBatch = null;
let unlistenDone = null;

// The parent re-emits `initialPath` when the user hits 「当前目录」.
watch(
  () => props.initialPath,
  (v) => {
    if (v) root.value = v;
  }
);

// ── Virtual scrolling ──
const scrollTop = ref(0);
const viewportH = ref(320);
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - 8));
const visibleCount = computed(() => Math.ceil(viewportH.value / ROW_H) + 16);
const visible = computed(() => hits.value.slice(start.value, start.value + visibleCount.value));
const offsetY = computed(() => start.value * ROW_H);
const totalHeight = computed(() => hits.value.length * ROW_H);

function onScroll(e) {
  scrollTop.value = e.target.scrollTop;
}

function ensureVisible(i) {
  const vp = viewportRef.value;
  if (!vp) return;
  const top = i * ROW_H;
  const bottom = top + ROW_H;
  if (top < vp.scrollTop) vp.scrollTop = top;
  else if (bottom > vp.scrollTop + vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
}

function moveActive(delta) {
  const n = hits.value.length;
  if (!n) return;
  let i = activeIndex.value + delta;
  if (i < 0) i = 0;
  if (i > n - 1) i = n - 1;
  activeIndex.value = i;
  ensureVisible(i);
}

function onListKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "PageDown") {
    e.preventDefault();
    moveActive(Math.floor(viewportH.value / ROW_H));
  } else if (e.key === "PageUp") {
    e.preventDefault();
    moveActive(-Math.floor(viewportH.value / ROW_H));
  } else if (e.key === "Home") {
    e.preventDefault();
    activeIndex.value = 0;
    ensureVisible(0);
  } else if (e.key === "End") {
    e.preventDefault();
    activeIndex.value = hits.value.length - 1;
    ensureVisible(activeIndex.value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const h = hits.value[activeIndex.value];
    if (h) reveal(h);
  }
}

// ── Search lifecycle ──

function onBatch(payload) {
  if (!payload || payload.id !== searchId) return; // stale scan
  hits.value = hits.value.concat(payload.hits || []);
  if (activeIndex.value < 0 && hits.value.length) activeIndex.value = 0;
}

function onDone(payload) {
  if (!payload || payload.id !== searchId) return;
  searching.value = false;
  scanned.value = payload.scanned || 0;
  matched.value = payload.matched || 0;
  doneInfo.value = payload;
  scanErrors.value = payload.errors || [];
  stopTicker();
  elapsed.value = (Date.now() - startedAt) / 1000;
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function run() {
  if (searching.value) return;
  const dir = (root.value || "").trim();
  if (!dir) {
    error.value = "请先指定搜索目录";
    return;
  }
  error.value = "";
  hits.value = [];
  scanErrors.value = [];
  doneInfo.value = null;
  scanned.value = 0;
  matched.value = 0;
  elapsed.value = 0;
  activeIndex.value = -1;
  scrollTop.value = 0;
  if (viewportRef.value) viewportRef.value.scrollTop = 0;
  hasRun.value = true;
  searching.value = true;
  searchId += 1;
  startedAt = Date.now();
  ticker = setInterval(() => {
    elapsed.value = (Date.now() - startedAt) / 1000;
  }, 200);
  try {
    await startSearch(searchId, {
      root: dir,
      pattern: pattern.value || "",
      content: content.value || "",
      caseSensitive: caseSensitive.value,
      includeHidden: includeHidden.value,
      maxResults: MAX_RESULTS,
    });
  } catch (e) {
    searching.value = false;
    stopTicker();
    error.value = String(e);
  }
}

async function stop() {
  if (!searching.value) return;
  await cancelSearch().catch(() => {});
}

// ── Result actions ──

function reveal(hit) {
  emit("reveal", { dir: hit.dir, name: hit.name, path: hit.path });
}

async function copyPath(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for webviews where the async clipboard API is unavailable.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
}

const ctx = ref({ visible: false, x: 0, y: 0, items: [], hit: null });

function openCtx(e, hit) {
  activeIndex.value = hits.value.findIndex((h) => h.path === hit.path);
  ctx.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    hit,
    items: [
      { label: "跳转到该文件", action: "reveal" },
      { label: "打开所在目录", action: "open-dir" },
      { label: "复制完整路径", action: "copy-path" },
      { separator: true },
      { label: "用系统默认程序打开", action: "open-file", disabled: hit.is_dir },
    ],
  };
}

function onCtxSelect(item) {
  const hit = ctx.value.hit;
  ctx.value.visible = false;
  if (!item || !hit) return;
  if (item.action === "reveal") reveal(hit);
  else if (item.action === "open-dir") emit("open-dir", hit.dir);
  else if (item.action === "copy-path") copyPath(hit.path);
  else if (item.action === "open-file") openFile(hit.path).catch(() => {});
}

// ── Formatting ──

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return (i === 0 ? String(bytes) : v.toFixed(1)) + " " + units[i];
}

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ICONS = {
  image: "🖼",
  video: "🎬",
  audio: "🎵",
  archive: "📦",
  text: "📝",
  doc: "📘",
  pdf: "📕",
};
const EXT_ICON = {
  image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "heic", "heif", "svg", "ico", "tiff"],
  video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "rmvb", "rm", "ts", "mpg", "mpeg"],
  audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "ape"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  text: ["txt", "md", "json", "log", "csv", "xml", "yml", "yaml", "ini", "toml"],
  doc: ["doc", "docx", "xls", "xlsx", "ppt", "pptx"],
  pdf: ["pdf"],
};

function iconOf(hit) {
  if (hit.is_dir) return "📁";
  const ext = (hit.extension || "").toLowerCase();
  for (const kind of Object.keys(EXT_ICON)) {
    if (EXT_ICON[kind].includes(ext)) return ICONS[kind];
  }
  return "📄";
}

// ── Lifecycle ──

// Esc closes the dialog from anywhere inside it. Registered on the capture
// phase so it also wins over App.vue's "Esc closes the preview" handler while
// the search dialog is on top.
function onEscCapture(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  emit("close");
}

let resizeObs = null;

onMounted(async () => {
  unlistenBatch = await listen("search-batch", onBatch);
  unlistenDone = await listen("search-done", onDone);
  document.addEventListener("keydown", onEscCapture, true);
  await nextTick();
  patternInput.value?.focus();
  if (viewportRef.value) {
    viewportH.value = viewportRef.value.clientHeight || viewportH.value;
    if (window.ResizeObserver) {
      resizeObs = new window.ResizeObserver((entries) => {
        const h = entries[0]?.contentRect?.height;
        if (h) viewportH.value = h;
      });
      resizeObs.observe(viewportRef.value);
    }
  }
});

onBeforeUnmount(() => {
  // A search still running when the dialog closes would keep walking the disk
  // and pushing events nobody listens to any more.
  if (searching.value) cancelSearch().catch(() => {});
  stopTicker();
  unlistenBatch?.();
  unlistenDone?.();
  resizeObs?.disconnect();
  document.removeEventListener("keydown", onEscCapture, true);
});
</script>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.search-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 900px;
  max-width: 94vw;
  height: 640px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.search-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.header-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
}

.close-btn {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}

.close-btn:hover {
  background: var(--danger);
  color: #fff;
}

.search-form {
  padding: 12px 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label {
  width: 68px;
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.form-input {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}

.form-input:focus {
  border-color: var(--accent);
}

.btn-ghost {
  flex: none;
  padding: 5px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.btn-ghost:hover {
  background: var(--hover-bg);
}

.options-row {
  margin-top: 2px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.spacer {
  flex: 1;
}

.btn-primary {
  flex: none;
  padding: 5px 18px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-stop {
  flex: none;
  padding: 5px 18px;
  border: none;
  border-radius: 4px;
  background: var(--danger);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-stop:hover {
  opacity: 0.9;
}

.btn-secondary {
  flex: none;
  padding: 6px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--hover-bg);
}

.search-status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}

.search-status .busy {
  color: var(--accent);
}

.search-status .warn {
  color: var(--danger);
}

.search-status .dim {
  opacity: 0.7;
}

.search-error {
  margin: 6px 16px 0;
  font-size: 12px;
  color: var(--danger);
}

.scan-errors {
  margin: 6px 16px 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--danger);
  max-height: 44px;
  overflow-y: auto;
}

/* ── Result list (virtualised) ── */
.result-viewport {
  flex: 1;
  min-height: 0;
  margin: 8px 16px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  outline: none;
  position: relative;
}

.result-viewport:focus {
  border-color: var(--accent);
}

.result-spacer {
  position: relative;
  width: 100%;
}

.result-rows {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text);
  cursor: default;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}

.result-row:hover {
  background: var(--hover-bg);
}

.result-row.active {
  background: var(--accent);
  color: #fff;
}

.col-icon {
  flex: none;
  width: 18px;
  text-align: center;
}

.col-name {
  flex: 0 0 26%;
  max-width: 26%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-dim);
}

.result-row.active .col-dir {
  color: rgba(255, 255, 255, 0.85);
}

.col-size {
  flex: none;
  width: 78px;
  text-align: right;
}

.col-time {
  flex: none;
  width: 118px;
  text-align: right;
  color: var(--text-dim);
}

.result-row.active .col-time {
  color: rgba(255, 255, 255, 0.85);
}

.result-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
}

.search-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.footer-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}
</style>
