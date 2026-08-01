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
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from "vue";
import FilePanel from "./components/FilePanel.vue";
import FilePreview from "./components/FilePreview.vue";
import VideoPreview from "./components/VideoPreview.vue";
import { joinPath } from "./api.js";
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

function setTheme(key) {
  currentTheme.value = key;
  document.documentElement.setAttribute("data-theme", key);
  localStorage.setItem("mini-tc-theme", key);
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
  const saved = localStorage.getItem("mini-tc-theme");
  if (saved) setTheme(saved);
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

const PREVIEWABLE_EXTENSIONS = ["txt", "md", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"];
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
  document.addEventListener("keydown", (e) => {
    // Ctrl+Q: Toggle file preview
    if (e.key === "q" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      togglePreview();
      return;
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
</style>
