<template>
  <div class="app" @mousemove="onDrag" @mouseup="endDrag">
    <!-- Menu bar -->
    <div class="menu-bar">
      <div class="menu-item" @click="toggleThemeMenu">
        <span>视图</span>
        <span class="menu-arrow">▾</span>
        <div class="menu-dropdown" v-if="themeMenuOpen" @click.stop>
          <div class="menu-dropdown-label">主题风格</div>
          <div
            v-for="t in themes"
            :key="t.key"
            class="menu-option"
            :class="{ checked: currentTheme === t.key }"
            @click="setTheme(t.key); themeMenuOpen = false"
          >
            <span class="check-mark">{{ currentTheme === t.key ? '✓' : '' }}</span>
            <span>{{ t.name }}</span>
          </div>
        </div>
      </div>
      <div class="menu-item" @click="toggleHelpMenu">
        <span>帮助</span>
        <span class="menu-arrow">▾</span>
        <div class="menu-dropdown" v-if="helpMenuOpen" @click.stop>
          <div class="menu-option" @click="checkUpdate(); helpMenuOpen = false">
            <span class="check-mark"></span>
            <span>检查更新</span>
          </div>
          <div class="menu-option" @click="helpMenuOpen = false">
            <span class="check-mark"></span>
            <span>关于 MiniTC</span>
          </div>
        </div>
      </div>
      <span class="update-status" v-if="updateStatus">{{ updateStatus }}</span>
    </div>

    <!-- Click-outside overlay -->
    <div v-if="themeMenuOpen || helpMenuOpen" class="menu-overlay" @click="themeMenuOpen = false; helpMenuOpen = false"></div>

    <!-- Update dialog -->
    <div class="update-dialog-overlay" v-if="updateDialog.visible" @click="updateDialog.visible = false">
      <div class="update-dialog" @click.stop>
        <h3>{{ updateDialog.title }}</h3>
        <p>{{ updateDialog.body }}</p>
        <div class="update-dialog-actions">
          <button v-if="updateDialog.showDownload" class="btn-primary" @click="downloadUpdate">下载更新</button>
          <button class="btn-secondary" @click="updateDialog.visible = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Main content: two panels with a draggable separator -->
    <div class="main-content">
      <div class="left-panel-wrapper" :style="{ flex: leftFlex + ' 1 0%' }">
        <FilePreview
          v-if="previewVisible && previewPanel === 'left' && previewKind === 'file'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
        />
        <VideoPreview
          v-else-if="previewVisible && previewPanel === 'left' && previewKind === 'video'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
          @navigate-list="onNavigateList"
        />
        <div
          v-else-if="previewVisible && previewPanel === 'left' && previewKind === 'unsupported'"
          class="preview-placeholder"
        >
          <div class="preview-placeholder-title">暂不支持预览该格式</div>
          <div class="preview-placeholder-name" v-if="previewFileName">{{ previewFileName }}</div>
        </div>
        <FilePanel
          v-show="!(previewVisible && previewPanel === 'left')"
          ref="leftPanel"
          panel-id="left"
          :is-active="activePanel === 'left' && !(previewVisible && previewPanel === 'left')"
          @activate="onPanelActivate('left')"
          @open-video="openVideo"
        />
      </div>

      <div class="separator" @mousedown="startDrag">
        <div class="separator-line"></div>
      </div>

      <div class="right-panel-wrapper" :style="{ flex: rightFlex + ' 1 0%' }">
        <FilePreview
          v-if="previewVisible && previewPanel === 'right' && previewKind === 'file'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
        />
        <VideoPreview
          v-else-if="previewVisible && previewPanel === 'right' && previewKind === 'video'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
          @navigate-list="onNavigateList"
        />
        <div
          v-else-if="previewVisible && previewPanel === 'right' && previewKind === 'unsupported'"
          class="preview-placeholder"
        >
          <div class="preview-placeholder-title">暂不支持预览该格式</div>
          <div class="preview-placeholder-name" v-if="previewFileName">{{ previewFileName }}</div>
        </div>
        <FilePanel
          v-show="!(previewVisible && previewPanel === 'right')"
          ref="rightPanel"
          panel-id="right"
          :is-active="activePanel === 'right' && !(previewVisible && previewPanel === 'right')"
          @activate="onPanelActivate('right')"
          @open-video="openVideo"
        />
      </div>
    </div>
    <!-- Toast feedback (clipboard / copy / move results) -->
    <div class="toast" v-if="toast.visible" :class="'toast-' + toast.type">{{ toast.text }}</div>

    <!-- Copy / move progress bar (large files) -->
    <div class="progress-overlay" v-if="progress.visible">
      <div class="progress-card">
        <div class="progress-row">
          <span class="progress-title">正在{{ pasteOperation === 'cut' ? '移动' : '复制' }}</span>
          <span class="progress-pct">{{ progress.percent.toFixed(0) }}%</span>
        </div>
        <div class="progress-name" :title="progress.name">{{ progress.name }}</div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progress.percent + '%' }"></div>
        </div>
        <div class="progress-meta">
          {{ formatBytes(progress.copied) }} / {{ formatBytes(progress.total) }}
          <span v-if="progress.fileTotal > 1"> · 文件 {{ progress.fileIndex }}/{{ progress.fileTotal }}</span>
        </div>
      </div>
    </div>

    <!-- Confirm dialog (same-name conflict on paste) -->
    <div class="confirm-overlay" v-if="confirmDialog.visible" @click.self="onConfirmChoice('cancel')">
      <div class="confirm-dialog" @click.stop>
        <h3>{{ confirmDialog.title }}</h3>
        <p v-if="confirmDialog.body">{{ confirmDialog.body }}</p>
        <ul class="confirm-list" v-if="confirmDialog.items.length">
          <li v-for="(it, i) in confirmDialog.items.slice(0, 5)" :key="i">{{ it }}</li>
          <li v-if="confirmDialog.items.length > 5">…等 {{ confirmDialog.items.length }} 项</li>
        </ul>
        <div class="confirm-actions">
          <button
            v-for="opt in confirmDialog.options"
            :key="opt.value"
            :class="opt.primary ? 'btn-primary' : 'btn-secondary'"
            @click="onConfirmChoice(opt.value)"
          >{{ opt.label }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from "vue";
import FilePanel from "./components/FilePanel.vue";
import FilePreview from "./components/FilePreview.vue";
import VideoPreview from "./components/VideoPreview.vue";
import { joinPath, pathExists, copyItems, moveItems, loadConfig, saveConfig, setClipboardFiles, getClipboardFiles, clearClipboard } from "./api.js";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const activePanel = ref("left");

const themes = [
  { key: "graphite", name: "石墨工业", label: "石墨" },
  { key: "neon", name: "霓虹暗夜", label: "霓虹" },
  { key: "latte", name: "暖茶拿铁", label: "拿铁" },
  { key: "forest", name: "墨竹青翠", label: "墨竹" },
];
const currentTheme = ref("neon");
const themeMenuOpen = ref(false);
const helpMenuOpen = ref(false);
const updateStatus = ref("");

const updateDialog = ref({
  visible: false,
  title: "",
  body: "",
  showDownload: false,
});

let pendingUpdate = null;

function toggleThemeMenu() {
  helpMenuOpen.value = false;
  themeMenuOpen.value = !themeMenuOpen.value;
}

function toggleHelpMenu() {
  themeMenuOpen.value = false;
  helpMenuOpen.value = !helpMenuOpen.value;
}

const THEME_KEY = "theme";

function setTheme(key) {
  currentTheme.value = key;
  document.documentElement.setAttribute("data-theme", key);
  // Persist to ~/.minitc/theme.json via the generic backend config command.
  saveConfig(THEME_KEY, JSON.stringify(key)).catch((e) =>
    console.error("Failed to persist theme:", e)
  );
}

// Load the theme from the unified store, migrating any legacy localStorage value.
async function initTheme() {
  // 1) Unified ~/.minitc store.
  try {
    const raw = await loadConfig(THEME_KEY);
    if (raw) {
      const key = JSON.parse(raw);
      if (key) {
        setTheme(key);
        return;
      }
    }
  } catch {
    /* fall through to migration */
  }

  // 2) Migrate legacy localStorage, then remove it.
  try {
    const legacy = localStorage.getItem("mini-tc-theme");
    if (legacy) {
      localStorage.removeItem("mini-tc-theme");
      setTheme(legacy);
      return;
    }
  } catch {
    /* fall through */
  }
}

// ── Update checking ──

async function checkUpdate() {
  helpMenuOpen.value = false;
  updateStatus.value = "正在检查更新...";

  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      updateStatus.value = "";
      updateDialog.value = {
        visible: true,
        title: `发现新版本 v${update.version}`,
        body: update.body || `当前版本可升级到 ${update.version}。`,
        showDownload: true,
      };
    } else {
      updateStatus.value = "已是最新版本";
      setTimeout(() => { updateStatus.value = ""; }, 3000);
    }
  } catch (e) {
    updateStatus.value = "检查更新失败";
    console.error("Update check failed:", e);
    setTimeout(() => { updateStatus.value = ""; }, 3000);
  }
}

async function downloadUpdate() {
  if (!pendingUpdate) return;
  updateDialog.value.visible = false;
  updateStatus.value = "正在下载更新...";

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          updateStatus.value = "开始下载...";
          break;
        case "Progress":
          updateStatus.value = `下载中... ${Math.round((event.data?.downloaded || 0) / 1024)} KB`;
          break;
        case "Finished":
          updateStatus.value = "下载完成，即将重启...";
          break;
      }
    });
    await relaunch();
  } catch (e) {
    updateStatus.value = "更新失败";
    console.error("Update download failed:", e);
    setTimeout(() => { updateStatus.value = ""; }, 5000);
  }
}

onMounted(() => {
  initTheme();
});

// Panel split ratio
const leftFlex = ref(1);
const rightFlex = ref(1);
const dragging = ref(false);

const leftPanel = ref(null);
const rightPanel = ref(null);

function startDrag(e) {
  dragging.value = true;
  e.preventDefault();
}

function onDrag(e) {
  if (!dragging.value) return;
  const container = e.currentTarget;
  const rect = container.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  // Clamp between 20% and 80%
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  leftFlex.value = clamped;
  rightFlex.value = 1 - clamped;
}

function endDrag() {
  dragging.value = false;
}

// ── File Preview (Ctrl+Q) ──

const PREVIEWABLE_EXTENSIONS = ["txt", "md", "json", "log", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "ogg", "mov", "m4v", "3gp", "mkv", "avi", "flv", "wmv", "rm", "rmvb", "asf", "vob", "ts", "m2ts", "m3u8", "mpg", "mpeg", "divx", "f4v"];

const previewVisible = ref(false);
const previewPanel = ref(""); // which panel shows the preview
const previewFilePath = ref("");
const previewFileName = ref("");
const previewFileBytes = ref(0);

// ── Preview kind & source panel ──
// previewKind === 'video' 时对面栏渲染 VideoPreview，否则渲染 FilePreview（图片/文本）。
const previewKind = ref("");

function openVideo(payload) {
  const source = payload.panelId || payload.sourcePanel || activePanel.value;
  previewPanel.value = source === "left" ? "right" : "left";
  previewKind.value = "video";
  previewFilePath.value = payload.path;
  previewFileName.value = payload.name;
  previewFileBytes.value = payload.bytes || 0;
  previewVisible.value = true;
}

// Switch to another video within the SAME preview panel (↑/↓ navigation in VideoPreview).
// Unlike openVideo, this keeps previewPanel unchanged.
// ↑/↓ pressed inside the video preview: delegate to the file list paired with
// the preview (the opposite panel). This lets navigation span ALL file types in
// the directory and switch previews across types, and it does not wrap around.
function onNavigateList(delta) {
  const source = previewPanel.value === "left" ? "right" : "left";
  const panel = source === "left" ? leftPanel.value : rightPanel.value;
  panel?.moveSelection?.(delta);
}

function onPanelActivate(panelId) {
  // Don't activate a panel that's showing the preview
  if (previewVisible.value && previewPanel.value === panelId) return;
  activePanel.value = panelId;
}

function getActivePanelRef() {
  return activePanel.value === "left" ? leftPanel.value : rightPanel.value;
}

// ── Clipboard (Ctrl+C / Ctrl+X / Ctrl+V) ──
//
// The OS clipboard is the single source of truth — we never keep an in-app
// mirror, so a copy/cut made in Explorer / Finder / any app is always picked
// up on paste. `setClipboardFiles` writes a real file clipboard (CF_HDROP on
// Windows, the platform pasteboard elsewhere); `getClipboardFiles` reads it.

function setClipboard(operation) {
  const panel = getActivePanelRef();
  const entries = panel?.selectedEntries;
  const currentPath = panel?.currentPath;
  if (!entries || entries.length === 0 || !currentPath) {
    showToast("请先选中文件或文件夹", "error");
    return;
  }
  Promise.all(entries.map((e) => joinPath(currentPath, e.name))).then((paths) => {
    // Write a real file clipboard so Explorer / Finder / any app can paste
    // these paths. There is intentionally no in-app mirror buffer.
    setClipboardFiles(paths, operation === "cut").catch((e) =>
      console.warn("写入系统剪贴板失败:", e)
    );
    // Mark cut items in the source panel so they appear ghosted until pasted.
    if (operation === "cut") {
      panel.setCutNames(entries.map((e) => e.name));
    } else {
      panel.clearCut();
    }
    showToast(
      `${operation === "cut" ? "已剪切" : "已复制"} ${paths.length} 项`,
      "info"
    );
  });
}

// ── Copy / move progress bar ──
// Backend streams a `copy-progress` event (name + copied/total bytes) while a
// large copy runs. We mirror it into this reactive state to render a bar.
const progress = ref({
  visible: false,
  name: "",
  percent: 0,
  copied: 0,
  total: 0,
  fileIndex: 0,
  fileTotal: 0,
});

// Tracks the current paste operation ('copy' | 'cut') so the progress label
// reflects the actual operation — important now that the OS clipboard (not the
// internal buffer) is the source of truth, e.g. a cut made in Explorer.
const pasteOperation = ref("copy");

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return (i === 0 ? String(bytes) : v.toFixed(1)) + " " + units[i];
}

// ── Confirm dialog (e.g. same-name conflict on paste) ──
const confirmDialog = ref({
  visible: false,
  title: "",
  body: "",
  items: [],
  options: [],
});
let confirmResolve = null;

// Show a modal with the given options; resolves to the chosen option's `value`
// (or "cancel" if dismissed). `options` is an array of { label, value, primary }.
function showConfirm({ title, body, items = [], options }) {
  confirmDialog.value = { visible: true, title, body, items, options };
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function onConfirmChoice(value) {
  confirmDialog.value.visible = false;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

async function pasteFromClipboard() {
  // The OS clipboard is the single source of truth (no in-app mirror), so a
  // copy/cut made in Explorer / Finder / any app is always picked up here.
  // mini-tc's own Ctrl+C/X also writes a real file clipboard, so in-app
  // copies are covered too.
  let sys = null;
  try {
    sys = await getClipboardFiles();
  } catch (e) {
    sys = null;
  }
  if (!sys || !sys.paths || sys.paths.length === 0) {
    showToast("剪贴板为空", "info");
    return;
  }
  await doPaste(sys.cut ? "cut" : "copy", sys.paths);
}

// Core paste logic (used for both copy and cut pastes sourced from the OS
// clipboard). `operation` is 'copy' (keep source) or 'cut' (move, then
// consume the clipboard).
async function doPaste(operation, sources) {
  pasteOperation.value = operation;
  // Paste target = the currently active panel — i.e. the directory the user
  // is currently focused on ("selected"). Ctrl+V drops into whatever folder
  // the active panel is showing, so it lands in the directory you're looking
  // at (matching the common expectation, and fixing the earlier bug where it
  // went to the other panel's stale directory).
  const targetPanel = getActivePanelRef();
  const destDir = targetPanel?.currentPath;
  if (!destDir) {
    showToast("当前面板目录无效", "error");
    return;
  }

  // Pre-scan for same-named items in the destination (top-level only; nested
  // conflicts inside a copied directory are resolved by the backend using the
  // same overwrite policy). If any conflict exists, ask the user once.
  const conflicts = [];
  for (const src of sources) {
    const name = src.split(/[\\/]/).pop();
    if (!name) continue;
    const destPath = await joinPath(destDir, name);
    if (await pathExists(destPath)) conflicts.push(name);
  }

  let overwrite = false;
  if (conflicts.length > 0) {
    const choice = await showConfirm({
      title: "目标已存在同名文件",
      body: "以下项目在目标目录中已存在，如何处理？",
      items: conflicts,
      options: [
        { label: "跳过", value: "skip" },
        { label: "覆盖", value: "overwrite", primary: true },
      ],
    });
    if (choice === "cancel") {
      showToast("已取消粘贴", "info");
      return;
    }
    overwrite = choice === "overwrite";
  }

  // Listen for progress events emitted by the backend during the copy. The
  // listener must be registered BEFORE the invoke so we don't miss early
  // events. We unlisten once the operation finishes.
  let unlisten = null;
  try {
    unlisten = await listen("copy-progress", (event) => {
      const p = event.payload;
      progress.value = {
        visible: true,
        name: p.current_name,
        percent: p.total_bytes > 0 ? (p.copied_bytes / p.total_bytes) * 100 : 0,
        copied: p.copied_bytes,
        total: p.total_bytes,
        fileIndex: p.file_index,
        fileTotal: p.file_total,
      };
    });

    const res = operation === "cut"
      ? await moveItems(sources, destDir, overwrite)
      : await copyItems(sources, destDir, overwrite);

    // Refresh BOTH panels: on a cut/move the SOURCE panel just lost the files,
    // on both copy and move the DESTINATION gained them. The active panel is
    // the target, so the source panel must be refreshed too — otherwise a cut
    // leaves the moved files still shown in the origin list.
    leftPanel.value?.refresh?.();
    rightPanel.value?.refresh?.();

    const verb = operation === "cut" ? "移动" : "复制";
    if (res.errors && res.errors.length) {
      showToast(`${verb}部分失败：\n` + res.errors.join("\n"), "error");
    } else if (res.skipped > 0) {
      showToast(`${verb}完成，跳过 ${res.skipped} 个同名文件`, "success");
    } else {
      showToast(`${verb}完成`, "success");
    }

    if (operation === "cut") {
      // Consume the system clipboard so it isn't re-pasted (matches Explorer).
      clearClipboard().catch(() => {});
    }
    // Clear any cut-state ghosting (the moved items are gone after the op).
    leftPanel.value?.clearCut?.();
    rightPanel.value?.clearCut?.();
  } catch (e) {
    showToast("操作失败：\n" + String(e), "error");
  } finally {
    progress.value.visible = false;
    if (unlisten) unlisten();
  }
}

// ── Toast feedback (success / error / info) ──

const toast = ref({ visible: false, text: "", type: "info" });
let toastTimer = null;

function showToast(text, type = "info") {
  toast.value = { visible: true, text, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value.visible = false;
  }, 3200);
}

// Show a normal (image/text) preview on the opposite panel.
async function showFilePreview(entry, path) {
  const fullPath = await joinPath(path, entry.name);
  previewPanel.value = activePanel.value === "left" ? "right" : "left";
  previewKind.value = "file";
  previewFilePath.value = fullPath;
  previewFileName.value = entry.name;
  previewFileBytes.value = entry.size;
  previewVisible.value = true;
}

// Show a "format not supported" placeholder on the opposite panel.
function showUnsupportedPreview(entry) {
  previewPanel.value = activePanel.value === "left" ? "right" : "left";
  previewKind.value = "unsupported";
  previewFileName.value = entry.name;
  previewVisible.value = true;
}

async function togglePreview() {
  if (previewVisible.value) {
    closePreview();
    return;
  }

  const panel = getActivePanelRef();
  const entry = panel?.selectedEntry;
  if (!entry) return;
  if (entry.is_dir) {
    showUnsupportedPreview(entry);
    return;
  }

  const path = panel?.currentPath;
  if (!path) return;

  const ext = entry.extension.toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) {
    const fullPath = await joinPath(path, entry.name);
    openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
    return;
  }

  if (!PREVIEWABLE_EXTENSIONS.includes(ext)) {
    showUnsupportedPreview(entry);
    return;
  }

  await showFilePreview(entry, path);
}

function closePreview() {
  previewVisible.value = false;
  previewPanel.value = "";
  previewKind.value = "";
  previewFilePath.value = "";
  previewFileName.value = "";
  previewFileBytes.value = 0;
}

// Auto-update preview when the active panel's selection changes
watch(
  () => {
    const panel = getActivePanelRef();
    return panel?.selectedEntry;
  },
  async (entry) => {
    if (!previewVisible.value) return;
    if (!entry) return; // keep the current preview when nothing is selected (e.g. after navigating to another directory)
    if (entry.is_dir) {
      showUnsupportedPreview(entry);
      return;
    }

    const ext = entry.extension.toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext)) {
      const panel = getActivePanelRef();
      const path = panel?.currentPath;
      if (!path) return;
      const fullPath = await joinPath(path, entry.name);
      if (previewVisible.value && previewKind.value === "video") {
        // Already in video preview → just swap the source without remounting.
        previewFilePath.value = fullPath;
        previewFileName.value = entry.name;
        previewFileBytes.value = entry.size;
      } else {
        closePreview();
        openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
      }
      return;
    }
    if (!PREVIEWABLE_EXTENSIONS.includes(ext)) {
      showUnsupportedPreview(entry);
      return;
    }

    const panel = getActivePanelRef();
    const path = panel?.currentPath;
    if (!path) return;

    await showFilePreview(entry, path);
  }
);

// Also update preview when active panel switches
watch(activePanel, async () => {
  if (!previewVisible.value) return;

  const panel = getActivePanelRef();
  const entry = panel?.selectedEntry;
  if (!entry) return;
  if (entry.is_dir) {
    showUnsupportedPreview(entry);
    return;
  }

  const ext = entry.extension.toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) {
    const path = panel?.currentPath;
    if (!path) return;
    const fullPath = await joinPath(path, entry.name);
    if (previewVisible.value && previewKind.value === "video") {
      previewFilePath.value = fullPath;
      previewFileName.value = entry.name;
      previewFileBytes.value = entry.size;
    } else {
      closePreview();
      openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
    }
    return;
  }
  if (!PREVIEWABLE_EXTENSIONS.includes(ext)) {
    showUnsupportedPreview(entry);
    return;
  }

  const path = panel?.currentPath;
  if (!path) return;

  await showFilePreview(entry, path);
});

// Keyboard shortcuts
onMounted(() => {
  // When the window regains focus (e.g. the user cut files in mini-tc, pasted
  // them in File Explorer, then switched back), re-list both panels and clear
  // any stale cut-ghosting. Without this the source panel keeps showing files
  // that have already been moved away by another app.
  listen("tauri://focus", () => {
    leftPanel.value?.refresh?.();
    rightPanel.value?.refresh?.();
    leftPanel.value?.clearCut?.();
    rightPanel.value?.clearCut?.();
  });
  document.addEventListener("keydown", (e) => {
    // Ctrl+Q: Toggle file preview
    if (e.key === "q" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      togglePreview();
      return;
    }

    // Ctrl+A: select all entries in the active panel (skip when typing in a text input).
    if (e.key === "a" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const t = e.target;
      if (t && t.tagName === "INPUT") return; // let the filter input select its text
      e.preventDefault();
      getActivePanelRef()?.selectAll?.();
      return;
    }

    // Ctrl+C / Ctrl+X / Ctrl+V: clipboard copy / cut / paste.
    // Let the browser handle these normally when typing in a text input
    // (e.g. the filename filter) so text editing shortcuts still work.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setClipboard("copy");
        return;
      }
      if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        setClipboard("cut");
        return;
      }
      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
    }

    // Ctrl+Tab: Switch active panel (skip if target is showing preview)
    if (e.key === "Tab" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (previewVisible.value) {
        // Don't allow switching to the preview panel
        return;
      }
      activePanel.value = activePanel.value === "left" ? "right" : "left";
    }
  });
});
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
}

.menu-bar {
  display: flex;
  align-items: center;
  padding: 0 4px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  height: 26px;
  user-select: none;
}

.menu-item {
  position: relative;
  font-size: 12px;
  padding: 2px 8px;
  color: var(--text);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  gap: 3px;
}

.menu-item:hover {
  background: var(--accent);
  color: #fff;
}

.menu-arrow {
  font-size: 9px;
  opacity: 0.6;
}

.menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 2px;
  min-width: 150px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  padding: 4px 0;
}

.menu-dropdown-label {
  font-size: 10px;
  color: var(--text-dim);
  padding: 2px 10px 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.menu-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 10px;
  color: var(--text);
  cursor: pointer;
}

.menu-option:hover {
  background: var(--accent);
  color: #fff;
}

.check-mark {
  width: 14px;
  font-size: 12px;
  text-align: center;
}

.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
  padding: 4px;
  gap: 0;
}

.left-panel-wrapper,
.right-panel-wrapper {
  display: flex;
  min-width: 0;
  overflow: hidden;
}

.separator {
  width: 6px;
  cursor: col-resize;
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  background: var(--bg);
  position: relative;
  z-index: 10;
}

.separator:hover .separator-line,
.separator:active .separator-line {
  background: var(--accent);
}

.separator-line {
  width: 2px;
  margin: 0 auto;
  background: var(--border);
  transition: background 0.15s;
}

/* ── Update status ── */

.update-status {
  font-size: 11px;
  color: var(--accent);
  margin-left: auto;
  margin-right: 8px;
}

/* ── Update dialog ── */

.update-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.update-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.update-dialog h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--text);
}

.update-dialog p {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.5;
}

.update-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.btn-primary {
  padding: 6px 16px;
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

.btn-secondary {
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

/* ── Preview placeholder (unsupported format) ── */

.preview-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--panel-bg);
  color: var(--text-dim);
  user-select: none;
  text-align: center;
  padding: 16px;
}

.preview-placeholder-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.preview-placeholder-name {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Toast feedback ── */

.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-line;
  z-index: 300;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  text-align: center;
}

.toast-info {
  background: var(--panel-bg);
  color: var(--text);
  border: 1px solid var(--border);
}

.toast-success {
  background: #1f6f3f;
  color: #e8ffe8;
  border: 1px solid #2f9d5b;
}

.toast-error {
  background: #7a1f1f;
  color: #ffe8e8;
  border: 1px solid #c0392b;
}

/* ── Copy / move progress bar ── */

.progress-overlay {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  pointer-events: none;
}

.progress-card {
  min-width: 320px;
  max-width: 70%;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
}

.progress-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
  color: var(--text);
}

.progress-pct {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--accent);
}

.progress-name {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-dim);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-bar {
  margin-top: 8px;
  height: 8px;
  border-radius: 4px;
  background: var(--hover-bg);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.15s ease;
}

.progress-meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

/* ── Confirm dialog ── */

.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 400;
}

.confirm-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
  min-width: 280px;
  max-width: 420px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.confirm-dialog h3 {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--text);
}

.confirm-dialog p {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.5;
}

.confirm-list {
  margin: 0 0 14px;
  padding-left: 18px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 12px;
  color: var(--text);
}

.confirm-list li {
  margin: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
