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
      <div class="menu-item" @click="checkUpdate">
        <span>帮助</span>
        <span class="menu-arrow">▾</span>
        <div class="menu-dropdown" v-if="helpMenuOpen" @click.stop>
          <div class="menu-option" @click="checkUpdate; helpMenuOpen = false">
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
        <FilePanel
          ref="leftPanel"
          panel-id="left"
          :is-active="activePanel === 'left'"
          @activate="activePanel = 'left'"
        />
      </div>

      <div class="separator" @mousedown="startDrag">
        <div class="separator-line"></div>
      </div>

      <div class="right-panel-wrapper" :style="{ flex: rightFlex + ' 1 0%' }">
        <FilePanel
          ref="rightPanel"
          panel-id="right"
          :is-active="activePanel === 'right'"
          @activate="activePanel = 'right'"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import FilePanel from "./components/FilePanel.vue";
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

// Keyboard shortcuts for switching active panel
onMounted(() => {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
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
</style>
