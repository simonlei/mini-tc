<template>
  <div class="app" @mousemove="onDrag" @mouseup="endDrag">
    <!-- Menu bar -->
    <div class="menu-bar">
      <div class="menu-item" @click="toggleConfigMenu">
        <span>配置</span>
        <span class="menu-arrow">▾</span>
        <div class="menu-dropdown" v-if="configMenuOpen" @click.stop>
          <div class="menu-option submenu-trigger"
            @mouseenter="themeSubmenuOpen = true"
            @mouseleave="themeSubmenuOpen = false">
            <span class="check-mark"></span>
            <span>主题风格</span>
            <span class="submenu-arrow">▸</span>
            <div class="submenu-dropdown" v-if="themeSubmenuOpen" @mouseenter="themeSubmenuOpen = true" @mouseleave="themeSubmenuOpen = false">
              <div
                v-for="t in themes"
                :key="t.key"
                class="menu-option"
                :class="{ checked: currentTheme === t.key }"
                @click="setTheme(t.key); themeSubmenuOpen = false; configMenuOpen = false">
                <span class="check-mark">{{ currentTheme === t.key ? '✓' : '' }}</span>
                <span>{{ t.name }}</span>
              </div>
            </div>
          </div>
          <div class="menu-separator"></div>
          <div class="menu-option" @click="openGeneralSettings(); configMenuOpen = false">
            <span class="check-mark"></span>
            <span>通用设置</span>
          </div>
          <div class="menu-option" @click="openSettings(); configMenuOpen = false">
            <span class="check-mark"></span>
            <span>文件预览设置</span>
          </div>
          <div class="menu-option" @click="openShortcuts(); configMenuOpen = false">
            <span class="check-mark"></span>
            <span>快捷键设置</span>
          </div>
        </div>
      </div>
      <div class="menu-item" @click="openSearch">
        <span>搜索</span>
      </div>
      <div class="menu-item" @click="toggleHelpMenu">
        <span>帮助</span>
        <span class="menu-arrow">▾</span>
        <div class="menu-dropdown" v-if="helpMenuOpen" @click.stop>
          <div class="menu-option" @click="checkUpdate(); helpMenuOpen = false">
            <span class="check-mark"></span>
            <span>检查更新</span>
          </div>
          <div class="menu-option" @click="showAbout(); helpMenuOpen = false">
            <span class="check-mark"></span>
            <span>关于 MiniTC</span>
          </div>
        </div>
      </div>
      <span class="update-status" v-if="updateStatus">{{ updateStatus }}</span>
    </div>

    <!-- Click-outside overlay -->
    <div v-if="configMenuOpen || helpMenuOpen" class="menu-overlay" @click="configMenuOpen = false; helpMenuOpen = false"></div>

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

    <!-- About dialog -->
    <div class="update-dialog-overlay" v-if="aboutVisible" @click="aboutVisible = false">
      <div class="update-dialog" @click.stop>
        <h3>关于 MiniTC</h3>
        <p>版本：v{{ appVersion }}</p>
        <p class="about-desc">一款轻量级跨平台双栏文件管理器，灵感来源于 Total Commander。</p>
        <div class="update-dialog-actions">
          <button class="btn-secondary" @click="aboutVisible = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- General settings dialog (app-wide options, own page). `values` merges
         the app-config blob with live viewState, because the dialog's schema
         addresses every row by a flat key and the `view.*` rows are owned by
         viewState.js rather than by app-config.json. -->
    <GeneralSettingsDialog
      v-if="generalSettingsVisible"
      :values="generalSettingsValues"
      @close="onGeneralSettingsClose"
      @save="onGeneralSettingsSave"
    />

    <!-- Settings dialog -->
    <SettingsDialog
      v-if="settingsVisible"
      :extensions="textPreviewExtensions"
      :builtins="BUILTIN_TEXT_EXTENSIONS"
      @close="onSettingsClose"
      @save="onSettingsSave"
    />

    <!-- Keyboard-shortcut settings dialog (own page, not part of 设置) -->
    <ShortcutsDialog
      v-if="shortcutsVisible"
      @close="onShortcutsClose"
      @save="onShortcutsSave"
    />

    <!-- Recursive file search (Total Commander's Alt+F7) -->
    <SearchDialog
      v-if="searchVisible"
      :initial-path="searchRoot"
      @close="closeSearch"
      @use-current-dir="onSearchUseCurrentDir"
      @reveal="onSearchReveal"
      @open-dir="onSearchOpenDir"
      @send-to-panel="onSearchSendToPanel"
    />

    <!-- Batch rename (Ctrl+M) -->
    <BatchRenameDialog
      v-if="batchRenameVisible"
      :items="batchRenameItems"
      :existing="batchRenameExisting"
      @close="closeBatchRename"
      @applied="onBatchRenameApplied"
    />

    <!-- Main content: two panels with a draggable separator -->
    <div class="main-content">
      <div class="left-panel-wrapper" :style="{ flex: leftFlex + ' 1 0%' }">
        <FilePreview
          v-if="previewVisible && previewPanel === 'left' && previewKind === 'file'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          :as-text="previewAsText"
          @close="closePreview"
        />
        <VideoPreview
          v-else-if="previewVisible && previewPanel === 'left' && previewKind === 'video'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
          @navigate-list="onNavigateList"
          @open-next="playNextVideo"
        />
        <UnsupportedPreview
          v-else-if="previewVisible && previewPanel === 'left' && previewKind === 'unsupported'"
          :file-name="previewFileName"
          :is-dir="previewUnsupportedIsDir"
          @preview-as-text="onPreviewAsText"
        />
        <FilePanel
          v-show="!(previewVisible && previewPanel === 'left')"
          ref="leftPanel"
          panel-id="left"
          :is-active="activePanel === 'left' && !(previewVisible && previewPanel === 'left')"
          @activate="onPanelActivate('left')"
          @open-video="openVideo"
          @deleted="onPanelDeleted"
          @batch-rename="onPanelBatchRename"
        />
      </div>

      <div class="separator" @mousedown="startDrag" @dblclick="onSeparatorDblclick">
        <div class="separator-line"></div>
      </div>

      <div class="right-panel-wrapper" :style="{ flex: rightFlex + ' 1 0%' }">
        <FilePreview
          v-if="previewVisible && previewPanel === 'right' && previewKind === 'file'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          :as-text="previewAsText"
          @close="closePreview"
        />
        <VideoPreview
          v-else-if="previewVisible && previewPanel === 'right' && previewKind === 'video'"
          :file-path="previewFilePath"
          :file-name="previewFileName"
          :file-bytes="previewFileBytes"
          @close="closePreview"
          @navigate-list="onNavigateList"
          @open-next="playNextVideo"
        />
        <UnsupportedPreview
          v-else-if="previewVisible && previewPanel === 'right' && previewKind === 'unsupported'"
          :file-name="previewFileName"
          :is-dir="previewUnsupportedIsDir"
          @preview-as-text="onPreviewAsText"
        />
        <FilePanel
          v-show="!(previewVisible && previewPanel === 'right')"
          ref="rightPanel"
          panel-id="right"
          :is-active="activePanel === 'right' && !(previewVisible && previewPanel === 'right')"
          @activate="onPanelActivate('right')"
          @open-video="openVideo"
          @deleted="onPanelDeleted"
          @batch-rename="onPanelBatchRename"
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
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import FilePanel from "./components/FilePanel.vue";
import FilePreview from "./components/FilePreview.vue";
import VideoPreview from "./components/VideoPreview.vue";
import UnsupportedPreview from "./components/UnsupportedPreview.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import GeneralSettingsDialog from "./components/GeneralSettingsDialog.vue";
import ShortcutsDialog from "./components/ShortcutsDialog.vue";
import SearchDialog from "./components/SearchDialog.vue";
import BatchRenameDialog from "./components/BatchRenameDialog.vue";
import { joinPath, pathExists, copyItems, moveItems, loadConfig, saveConfig, setClipboardFiles, getClipboardFiles, clearClipboard, getParentDir } from "./api.js";
import { entryPath, parentDirOf, normDir, isSearchPath } from "./paths.js";
import { loadShortcuts, saveShortcuts, matches, markHandled, isHandled, eventCombo } from "./shortcuts.js";
import { loadBookmarks, findBookmark, addBookmark, removeBookmark } from "./bookmarks.js";
import {
  loadViewState,
  applyViewState,
  toggleHidden as toggleHiddenForPanel,
  setPreviewRestore,
  consumePreviewRestore,
  snapshot as viewStateSnapshot,
} from "./viewState.js";
import * as alwaysOnTop from "./alwaysOnTop.js";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { mark, track } from "./bootLog.js";

const activePanel = ref("left");

const themes = [
  { key: "graphite", name: "石墨工业", label: "石墨" },
  { key: "neon", name: "霓虹暗夜", label: "霓虹" },
  { key: "latte", name: "暖茶拿铁", label: "拿铁" },
  { key: "forest", name: "墨竹青翠", label: "墨竹" },
];
const currentTheme = ref("neon");
const configMenuOpen = ref(false);
const themeSubmenuOpen = ref(false);
const helpMenuOpen = ref(false);
const updateStatus = ref("");

// ── Settings dialog ──
const settingsVisible = ref(false);

function openSettings() {
  helpMenuOpen.value = false;
  configMenuOpen.value = false;
  settingsVisible.value = true;
}

function onSettingsSave(exts) {
  textPreviewExtensions.value = [
    ...new Set(exts.map((e) => String(e).toLowerCase()).filter(Boolean)),
  ];
  settingsVisible.value = false;
  saveTextPreviewConfig();
}

function onSettingsClose() {
  settingsVisible.value = false;
}

// ── General settings dialog (app-wide options) ──
// A dedicated page, separate from 文件预览设置 (which is all about how a single
// file is rendered) and 快捷键设置. The row list lives in the component as a
// declarative schema; this side only owns persistence and the live effects.
//
// Persisted to ~/.minitc/app-config.json.
const APP_CONFIG = "app-config";
const generalSettingsVisible = ref(false);
// Default MUST mirror the schema default in GeneralSettingsDialog.vue — that
// component is the single source of truth for the row list, but it can only
// apply its defaults once it receives values, so the pre-load state here needs
// a matching starting value (otherwise the window would briefly act as if the
// option were off).
const appConfig = ref({ videoPreviewAlwaysOnTop: false });

// Rows whose keys start with this prefix belong to viewState.js
// (~/.minitc/view-state.json), everything else to app-config.json. Keeping the
// split key-driven means the dialog's schema stays declarative — it doesn't
// need to know which store a row lives in.
const VIEW_PREFIX = "view.";

function openGeneralSettings() {
  helpMenuOpen.value = false;
  configMenuOpen.value = false;
  generalSettingsVisible.value = true;
}

function onGeneralSettingsClose() {
  generalSettingsVisible.value = false;
}

// Flat map handed to the dialog: app-config rows verbatim, view-state rows
// flattened onto their `view.*` keys. Rebuilt on open (and after each save) so
// the dialog always sees current values — including changes the user made
// outside it (Ctrl+H toggles showHidden behind its back).
const generalSettingsValues = computed(() => {
  const v = viewStateSnapshot();
  return {
    ...appConfig.value,
    "view.showHiddenLeft": v.showHidden.left,
    "view.showHiddenRight": v.showHidden.right,
    "view.defaultSortColumn": v.defaultSortColumn,
    "view.defaultSortDirection": v.defaultSortDirection,
  };
});

function onGeneralSettingsSave(values) {
  generalSettingsVisible.value = false;

  // Split the flat result back into its two stores.
  const app = {};
  const view = {};
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith(VIEW_PREFIX)) view[k.slice(VIEW_PREFIX.length)] = v;
    else app[k] = v;
  }

  appConfig.value = { ...app };
  applyViewState({
    showHidden: {
      left: view.showHiddenLeft === true,
      right: view.showHiddenRight === true,
    },
    defaultSortColumn: view.defaultSortColumn,
    defaultSortDirection: view.defaultSortDirection,
  });
  saveAppConfig();

  // Apply the window pin preference immediately rather than waiting for the
  // next preview state change, so turning the option off un-pins a
  // currently-open preview.
  alwaysOnTop.setEnabled(appConfig.value.videoPreviewAlwaysOnTop);
  alwaysOnTop.sync(previewVisible.value && previewKind.value === "video");
}

async function loadAppConfig() {
  try {
    const raw = await loadConfig(APP_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        appConfig.value = { ...appConfig.value, ...parsed };
      }
    }
  } catch (e) {
    console.error("Failed to load app config:", e);
    // Keep defaults on failure.
  }
  alwaysOnTop.setEnabled(appConfig.value.videoPreviewAlwaysOnTop);
  // Replay the current state: the preference is only known after this async
  // load resolves, and a video preview may already be open (the watch fired
  // with the default `false` and correctly did nothing). Sync again so the
  // window matches the real preference.
  alwaysOnTop.sync(previewVisible.value && previewKind.value === "video");
}

async function saveAppConfig() {
  await saveConfig(APP_CONFIG, JSON.stringify(appConfig.value)).catch((e) =>
    console.error("Failed to persist app config:", e)
  );
}

// ── Shortcut-settings dialog ──
// A dedicated page (separate from 文件预览设置) listing every command, grouped
// by scope, with rebinding / conflict detection handled inside the component.
const shortcutsVisible = ref(false);

function openShortcuts() {
  helpMenuOpen.value = false;
  configMenuOpen.value = false;
  shortcutsVisible.value = true;
}

function onShortcutsClose() {
  shortcutsVisible.value = false;
}

async function onShortcutsSave() {
  await saveShortcuts();
  shortcutsVisible.value = false;
}

// ── Recursive file search (Alt+F7 / Ctrl+F) ──
// The dialog owns the whole flow (backend thread + streamed events); this side
// only decides WHERE a hit should be revealed: the panel the user was last
// working in, i.e. the active one.
const searchVisible = ref(false);
// Root directory the dialog starts from — refreshed from the active panel each
// time it is opened, and on demand via 「当前目录」 while it is open.
const searchRoot = ref("");
// Panel and focused element to hand the keyboard back to on close.
let searchReturnPanel = "left";
let searchReturnFocus = null;

function currentPanelPath() {
  return getActivePanelRef()?.currentPath || "";
}

function openSearch() {
  configMenuOpen.value = false;
  helpMenuOpen.value = false;
  // Remember where focus came from: the panel we search from, and the exact
  // element that had it (the file list itself, the path bar or the filter
  // input). Closing the dialog puts focus back where it was, so Esc doesn't
  // dump the user on a dead <body> with no keyboard at all.
  searchReturnPanel = activePanel.value;
  searchReturnFocus = document.activeElement;
  searchRoot.value = currentPanelPath();
  searchVisible.value = true;
}

function closeSearch() {
  searchVisible.value = false;
  const target = searchReturnFocus;
  const panel = searchReturnPanel === "left" ? leftPanel.value : rightPanel.value;
  nextTick(() => {
    // Restoring the previous element is the precise answer — it is the file
    // list, the path bar or the filter input the user was actually typing in.
    // Fall back to the list when that element is gone (panel re-created) or
    // focus was nowhere to begin with.
    if (target && target !== document.body && target.isConnected) {
      target.focus();
      if (document.activeElement === target) return;
    }
    panel?.focusList?.();
  });
}

function onSearchUseCurrentDir() {
  searchRoot.value = currentPanelPath();
}

// Jump to a hit: close the dialog, then navigate the active panel to the hit's
// directory and select the file. If that panel is currently showing a preview,
// close the preview first (the panel is hidden behind it and can't be seen).
function onSearchReveal({ dir, name } = {}) {
  searchVisible.value = false;
  if (!dir) return;
  if (previewVisible.value && previewPanel.value === activePanel.value) closePreview();
  const panel = getActivePanelRef();
  panel?.revealFile?.(dir, name);
  // The dialog took the keyboard; hand it back so the revealed file can be
  // navigated (and Enter/Tab used) right away.
  nextTick(() => panel?.focusList?.());
}

// "打开所在目录": go to the directory without selecting anything inside it.
function onSearchOpenDir(dir) {
  searchVisible.value = false;
  if (!dir) return;
  if (previewVisible.value && previewPanel.value === activePanel.value) closePreview();
  const panel = getActivePanelRef();
  panel?.goTo?.(dir);
  nextTick(() => panel?.focusList?.());
}

// "送到面板": turn the hits into an ordinary file list inside one of the two
// panels. Total Commander's equivalent is sending the find-results to a panel
// so you can work on them (rename, delete, F5 to the other side, drag out)
// instead of only jumping to them one at a time.
//
// The dialog closes but a still-running scan is NOT cancelled: the panel takes
// over the event stream and keeps appending batches, so the user can start
// working on the first results immediately.
function onSearchSendToPanel({ panel: which, ...payload } = {}) {
  const panel = which === "right" ? rightPanel.value : leftPanel.value;
  if (!panel) return;
  // A preview occupies one panel; results would land invisible behind it.
  if (previewVisible.value && previewPanel.value === which) closePreview();
  panel.openSearchResults?.(payload);
  searchVisible.value = false;
  // Make the destination panel active so the rows are visible and keyboard
  // focus follows them.
  activePanel.value = which;
  nextTick(() => panel.focusList?.());
  showToast(
    payload.live
      ? `已在${which === "right" ? "右" : "左"}栏打开搜索结果，扫描仍在继续…`
      : `${which === "right" ? "右" : "左"}栏已载入 ${payload.hits?.length || 0} 个搜索结果`,
    "success"
  );
}

// ── Batch rename (Ctrl+M) ──
// The dialog owns the rules and the preview; this side only decides WHICH
// items go in (the active panel's selection, as absolute paths — a rename must
// not depend on a list index staying valid) and cleans up afterwards.
const batchRenameVisible = ref(false);
const batchRenameItems = ref([]);
// Lower-cased names already present in the target directory, so the plan can
// flag "目标已存在同名项" BEFORE anything is renamed. Null for a
// search-results tab — its rows span many folders, so there is no single set.
const batchRenameExisting = ref(null);
// Panel + focused element to hand the keyboard back to on close, mirroring the
// search dialog (otherwise Esc leaves focus stranded on <body>).
let batchRenameReturnPanel = "left";
let batchRenameReturnFocus = null;
let batchRenamePanelId = "";

// Open the dialog over `panelId`'s selection (defaults to the active panel).
// The panel id is a parameter rather than a read of `activePanel` because the
// context-menu entry fires from a panel that may not be the active one — the
// user right-clicked there, and that row is what they mean to rename.
async function openBatchRename(panelIdArg) {
  configMenuOpen.value = false;
  helpMenuOpen.value = false;
  if (batchRenameVisible.value) return;

  const panelId = panelIdArg || activePanel.value;
  const panel = panelId === "left" ? leftPanel.value : rightPanel.value;
  const entries = panel?.selectedEntries;
  const dir = panel?.currentPath;
  if (!entries || entries.length === 0 || !dir) {
    showToast("请先选中文件或文件夹", "error");
    return;
  }

  // Absolute paths, resolved once — the dialog re-reads them on every keystroke
  // while the list underneath may re-sort or filter.
  const items = await Promise.all(
    entries.map(async (e) => ({ path: await entryPath(e, dir), name: e.name }))
  );

  batchRenamePanelId = panelId;
  batchRenameReturnPanel = panelId;
  batchRenameReturnFocus = document.activeElement;
  batchRenameItems.value = items;
  batchRenameExisting.value = panel?.isVirtual?.()
    ? null
    : new Set((panel?.entryNames || []).map((n) => String(n).toLowerCase()));
  batchRenameVisible.value = true;
}

// Context-menu "批量重命名…" on a panel. Make that panel the active one first
// so the dialog, the refresh afterwards and the restored keyboard focus all
// agree on which side is being worked on.
function onPanelBatchRename({ panelId } = {}) {
  if (previewVisible.value && previewPanel.value === panelId) return;
  activePanel.value = panelId;
  openBatchRename(panelId);
}

function closeBatchRename() {
  batchRenameVisible.value = false;
  const target = batchRenameReturnFocus;
  const panel = batchRenameReturnPanel === "left" ? leftPanel.value : rightPanel.value;
  nextTick(() => {
    if (target && target !== document.body && target.isConnected) {
      target.focus();
      if (document.activeElement === target) return;
    }
    panel?.focusList?.();
  });
}

// The renames already happened (the dialog ran them); hand the [oldPath,
// newName] pairs to the panel so it updates its listing the right way for its
// kind of tab, and report what changed.
function onBatchRenameApplied({ count, pairs } = {}) {
  const panel = batchRenamePanelId === "left" ? leftPanel.value : rightPanel.value;
  panel?.applyRenames?.(pairs);
  nextTick(() => panel?.focusList?.());
  showToast(`已重命名 ${count || 0} 项`, "success");
}

const updateDialog = ref({
  visible: false,
  title: "",
  body: "",
  showDownload: false,
});

let pendingUpdate = null;

// ── About dialog ──
const aboutVisible = ref(false);
const appVersion = ref("0.1.0");

function showAbout() {
  aboutVisible.value = true;
  // Fetch version from Tauri (resolves instantly, cached by the runtime).
  getVersion().then((v) => { appVersion.value = v; }).catch(() => {});
}

function toggleConfigMenu() {
  helpMenuOpen.value = false;
  configMenuOpen.value = !configMenuOpen.value;
}

function toggleHelpMenu() {
  configMenuOpen.value = false;
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
  mark("app:onMounted");
  // Each of these is an independent IPC round-trip fired in parallel; `track`
  // records how long each one actually took so slow ones are visible.
  track("cfg:theme", initTheme());
  track("cfg:text-preview", loadTextPreviewConfig());
  track("cfg:app", loadAppConfig());
  // Load ~/.minitc/shortcuts.json before the first keystroke can arrive; until
  // it resolves every command simply falls back to its built-in defaults.
  track("cfg:shortcuts", loadShortcuts());
  // ~/.minitc/bookmarks.json. Loaded here (not in FilePanel) so BOTH panels see
  // a populated list from their first render — the store is a module singleton,
  // so whichever dropdown opens later already reads the same data.
  track("cfg:bookmarks", loadBookmarks());
  track("cfg:panel-split", loadPanelSplit());
  // ~/.minitc/view-state.json — hidden-file visibility, column widths, default
  // sort. Module singleton, so the panels read the same live values once this
  // resolves; until then they fall back to the built-in defaults.
  track("cfg:view-state", loadViewState());
  // Restore the previous session's preview once both panels have content.
  track("app:restorePreview", restorePreview());
  // Only needed by the About dialog — measured to confirm it's free.
  track(
    "app:getVersion",
    getVersion().then((v) => { appVersion.value = v; }).catch(() => {})
  );
});

// Panel split ratio
//
// Persisted to ~/.minitc/panel-split.json. We store the ratio (left flex-grow
// factor) rather than a pixel width: both wrappers are flex children with
// `flex-basis: 0`, so the grow ratio alone fully determines the split and
// stays meaningful after a window resize or on a different monitor.
const PANEL_SPLIT_CONFIG = "panel-split";
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

const leftFlex = ref(1);
const rightFlex = ref(1);
const dragging = ref(false);

// Set once the user actually moves the separator, so the async config load
// can't clobber a drag that happened while it was still in flight.
let splitTouched = false;

function applySplit(ratio) {
  leftFlex.value = ratio;
  rightFlex.value = 1 - ratio;
}

const leftPanel = ref(null);
const rightPanel = ref(null);

function startDrag(e) {
  dragging.value = true;
  splitTouched = true;
  e.preventDefault();
}

function onDrag(e) {
  if (!dragging.value) return;
  const container = e.currentTarget;
  const rect = container.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  // Clamp so neither side can be squashed flat
  applySplit(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, ratio)));
  scheduleSplitSave();
}

// Persist on the trailing edge: a drag fires mousemove every few ms, and the
// final mousemove must be saved even if `mouseup` never lands (pointer released
// outside the window), so the drag path schedules too — the debounce collapses
// both into a single write.
let splitSaveTimer = null;

function scheduleSplitSave() {
  if (splitSaveTimer) clearTimeout(splitSaveTimer);
  splitSaveTimer = setTimeout(() => {
    splitSaveTimer = null;
    savePanelSplit();
  }, 300);
}

function endDrag() {
  if (!dragging.value) return;
  dragging.value = false;
  scheduleSplitSave();
}

// Double-click the separator to snap back to an even split.
function onSeparatorDblclick() {
  splitTouched = true;
  applySplit(0.5);
  scheduleSplitSave();
}

async function loadPanelSplit() {
  // Bail before applying anything: the user may have grabbed the separator
  // while this IPC was in flight, and their split is the newer truth. Any
  // pending save timer was armed by that drag and will write it out.
  if (splitTouched) return;
  try {
    const raw = await loadConfig(PANEL_SPLIT_CONFIG);
    if (raw) {
      // Tolerate both `{left}` and a bare number, so a hand-edited file that
      // drops the wrapper still restores instead of silently resetting.
      const parsed = JSON.parse(raw);
      const left = Number(typeof parsed === "object" ? parsed?.left : parsed);
      // Ignore anything non-finite (corrupt/hand-edited file) and re-clamp, so
      // a bad value can't collapse one panel to nothing.
      if (Number.isFinite(left)) {
        applySplit(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, left)));
      }
    }
  } catch (e) {
    console.error("Failed to load panel split:", e);
    // Keep the default 50/50 split.
  }
}

async function savePanelSplit() {
  await saveConfig(PANEL_SPLIT_CONFIG, JSON.stringify({ left: leftFlex.value })).catch((e) =>
    console.error("Failed to persist panel split:", e)
  );
}

// ── File Preview (Ctrl+Q) ──

const PREVIEWABLE_EXTENSIONS = ["pdf", "doc", "docx", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", "hif", "avci"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "ogg", "mov", "m4v", "3gp", "mkv", "avi", "flv", "wmv", "rm", "rmvb", "asf", "vob", "ts", "m2ts", "m3u8", "mpg", "mpeg", "divx", "f4v"];

// Built-in plain-text formats. These are deliberately NOT part of
// PREVIEWABLE_EXTENSIONS — whether they are previewed as text is governed
// entirely by the user-editable `textPreviewExtensions` set below (which
// defaults to these). That lets the Settings dialog toggle even built-in text
// types on/off without special-casing them.
const BUILTIN_TEXT_EXTENSIONS = ["txt", "md", "json", "log"];

// Extensions the user wants previewed as plain text. Defaults to the built-ins
// above; can be extended (and individual entries disabled) from the Settings
// dialog, and is persisted to ~/.minitc/text-preview-extensions.json. The
// "按文本预览" button on an unsupported file also adds to this set.
const TEXT_PREVIEW_CONFIG = "text-preview-extensions";
const textPreviewExtensions = ref([...BUILTIN_TEXT_EXTENSIONS]);
// Whether the current "unsupported" placeholder is for a directory (in which
// case the "按文本预览" button is hidden — directories can't be text-previewed).
const previewUnsupportedIsDir = ref(false);
// Flag passed to FilePreview: force a plain-text read for the current file
// when its extension is in the user-editable `textPreviewExtensions` set.
const previewAsText = ref(false);

async function loadTextPreviewConfig() {
  try {
    const raw = await loadConfig(TEXT_PREVIEW_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Legacy delta format (user-added only) — merge with built-ins so they
        // stay enabled, then migrate to the object format on next save.
        textPreviewExtensions.value = [
          ...new Set([
            ...BUILTIN_TEXT_EXTENSIONS,
            ...parsed.map((e) => String(e).toLowerCase()).filter(Boolean),
          ]),
        ];
      } else if (parsed && typeof parsed === "object") {
        // Current format: { ext: bool }. Respect disabled built-ins.
        const arr = [];
        for (const [k, v] of Object.entries(parsed)) {
          if (v) arr.push(String(k).toLowerCase());
        }
        textPreviewExtensions.value = arr;
      }
    }
  } catch (e) {
    console.error("Failed to load text-preview extensions:", e);
    // Keep built-in defaults on failure.
    textPreviewExtensions.value = [...BUILTIN_TEXT_EXTENSIONS];
  }
}

async function saveTextPreviewConfig() {
  // Persist as an object { ext: bool } so a disabled built-in stays disabled
  // across restarts (a bare array can't represent "off").
  const obj = {};
  for (const b of BUILTIN_TEXT_EXTENSIONS) {
    obj[b] = textPreviewExtensions.value.includes(b);
  }
  for (const e of textPreviewExtensions.value) {
    if (!BUILTIN_TEXT_EXTENSIONS.includes(e)) obj[e] = true;
  }
  await saveConfig(TEXT_PREVIEW_CONFIG, JSON.stringify(obj)).catch((e) =>
    console.error("Failed to persist text-preview extensions:", e)
  );
}

// True when the extension can be previewed at all (built-in OR user-added text).
function isPreviewableExt(ext) {
  return PREVIEWABLE_EXTENSIONS.includes(ext) || textPreviewExtensions.value.includes(ext);
}

// True only for user-added text-preview extensions (forces a text read).
function isTextPreviewExt(ext) {
  return textPreviewExtensions.value.includes(ext);
}

const previewVisible = ref(false);
const previewPanel = ref(""); // which panel shows the preview
const previewFilePath = ref("");
const previewFileName = ref("");
const previewFileBytes = ref(0);

// ── Preview kind & source panel ──
// previewKind === 'video' 时对面栏渲染 VideoPreview，否则渲染 FilePreview（图片/文本）。
const previewKind = ref("");

// Keep the window's z-order in sync with "a video preview is showing".
// Watching the two primitives (rather than hooking every open/close call site)
// means the ↑/↓ clip navigation, panel switches, autoplay advance and Esc all
// funnel through here, so there's no path that can leave the window wrongly
// pinned. `sync` no-ops when the desired state is unchanged.
watch(
  () => previewVisible.value && previewKind.value === "video",
  (isVideo) => alwaysOnTop.sync(isVideo)
);

function openVideo(payload) {
  const source = payload.panelId || payload.sourcePanel || activePanel.value;
  previewPanel.value = source === "left" ? "right" : "left";
  previewKind.value = "video";
  previewFilePath.value = payload.path;
  previewFileName.value = payload.name;
  previewFileBytes.value = payload.bytes || 0;
  // Reset flags owned by the file/unsupported previews — openVideo is now also
  // reached by a direct kind switch from those previews, and they must not leak
  // into the video preview.
  previewAsText.value = false;
  previewUnsupportedIsDir.value = false;
  previewVisible.value = true;
}

// Autoplay the next video (triggered by VideoPreview's `open-next` on `ended`).
// The "which clip is next" decision is delegated to the SOURCE panel's file list
// via getNextVideoEntry(), so the autoplay order follows the list's CURRENT sort
// (natural numeric name order / size / modified — whatever the user set) instead
// of an independent directory re-sort in VideoPreview. The file-list highlight
// moves to the next clip too, so it tracks what's playing.
async function playNextVideo(payload) {
  if (!previewVisible.value || previewKind.value !== "video") return;
  const source = previewPanel.value === "left" ? "right" : "left";
  const panel = source === "left" ? leftPanel.value : rightPanel.value;
  const currentName = payload?.name;
  if (!currentName) return;
  const next = panel?.getNextVideoEntry?.(currentName);
  if (!next) return; // last video in the list → stop, no loop
  const dir = panel?.currentPath;
  if (!dir) return;
  const p = await entryPath(next, dir);
  previewFilePath.value = p;
  previewFileName.value = next.name;
  previewFileBytes.value = next.size || 0;
  panel?.selectName?.(next.name);
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

// The panel FOCUS is not on — i.e. the destination for "copy/move to the other
// panel" (Total Commander's F5 / Shift+F5).
function getInactivePanelRef() {
  return activePanel.value === "left" ? rightPanel.value : leftPanel.value;
}

// ── Clipboard (Ctrl+C / Ctrl+X / Ctrl+V) ──
//
// The OS clipboard is the single source of truth — we never keep an in-app
// mirror, so a copy/cut made in Explorer / Finder / any app is always picked
// up on paste. `setClipboardFiles` writes a real file clipboard (CF_HDROP on
// Windows, the platform pasteboard elsewhere); `getClipboardFiles` reads it.

// Returns true when the current selection is non-empty AND anchored inside a
// file-preview text area (.preview-text). Used so Ctrl+C / Ctrl+X inside a
// preview copies the selected text instead of triggering a file clipboard op.
function hasPreviewTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const text = sel.toString();
  if (!text || !text.trim()) return false;
  let node = sel.anchorNode;
  if (!node) return false;
  const el = node.nodeType === 3 ? node.parentElement : node;
  return !!(el && el.closest && (el.closest(".preview-text") || el.closest(".preview-doc")));
}

// 判断当前焦点是否落在 PDF 预览的 <iframe> 上（跨源 iframe 无法读取内部选区，
// 但浏览器会将 iframe 元素本身设为 activeElement，据此放行原生 Ctrl+C）。
// 双重校验：class 名 + src 以 asset:// 开头，增强判定抗干扰性。
function isPdfIframeFocused() {
  const el = document.activeElement;
  if (!el || el.tagName !== "IFRAME") return false;
  if (!el.classList.contains("preview-pdf-frame")) return false;
  const src = el.getAttribute("src") || "";
  return src.startsWith("asset://");
}

function setClipboard(operation) {
  const panel = getActivePanelRef();
  const entries = panel?.selectedEntries;
  const currentPath = panel?.currentPath;
  if (!entries || entries.length === 0 || !currentPath) {
    showToast("请先选中文件或文件夹", "error");
    return;
  }
  Promise.all(entries.map((e) => entryPath(e, currentPath))).then((paths) => {
    // Write a real file clipboard so Explorer / Finder / any app can paste
    // these paths. There is intentionally no in-app mirror buffer.
    setClipboardFiles(paths, operation === "cut").catch((e) =>
      console.warn("写入系统剪贴板失败:", e)
    );
    // Mark cut items in the source panel so they appear ghosted until pasted.
    // In a search-results tab the entries come from many directories, so ghost
    // them by absolute path — a name would light up unrelated same-named rows.
    if (operation === "cut") {
      panel.setCutNames(
        isSearchPath(currentPath)
          ? entries.map((e) => e.path)
          : entries.map((e) => e.name)
      );
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

// ── F5 / Shift+F5: copy / move the selection into the OTHER panel ──
//
// Total Commander's F5 ("copy to other panel") and Shift+F5 ("move to other
// panel"). The destination is the opposite panel's CURRENT directory — not a
// file picked there, and not the clipboard — so this bypasses the clipboard
// round-trip entirely and hands the paths straight to doPaste().
async function transferToOtherPanel(operation) {
  const src = getActivePanelRef();
  const entries = src?.selectedEntries;
  const srcDir = src?.currentPath;
  const destDir = getInactivePanelRef()?.currentPath;

  if (!entries || entries.length === 0 || !srcDir) {
    showToast("请先选中文件或文件夹", "error");
    return;
  }
  if (!destDir) {
    showToast("对面栏没有有效的当前目录", "error");
    return;
  }
  // Both panels sitting in the same directory: copying a file onto itself is a
  // no-op at best and a "copy a file into itself" error at worst. Say so
  // instead of letting the backend silently skip N items. Skipped when the
  // SOURCE is a search-results tab: its "directory" is a sentinel that can
  // never equal a real one, and its rows legitimately span many folders.
  if (normDir(destDir) === normDir(srcDir) && !isSearchPath(srcDir)) {
    showToast("对面栏与当前栏在同一目录", "error");
    return;
  }

  const paths = await Promise.all(entries.map((e) => entryPath(e, srcDir)));
  // Same filter the drag-drop path uses: an item already sitting DIRECTLY in
  // the destination can't be moved into it (and copying it would just make a
  // same-name conflict we can't meaningfully resolve).
  const normDest = normDir(destDir);
  const filtered = paths.filter((p) => parentDirOf(p) !== normDest);
  if (filtered.length === 0) {
    showToast("所选项目已在对面栏目录中", "info");
    return;
  }

  await doPaste(operation === "cut" ? "cut" : "copy", filtered, destDir);
}

// Core paste logic (used for both copy and cut pastes sourced from the OS
// clipboard). `operation` is 'copy' (keep source) or 'cut' (move, then
// consume the clipboard). `destDirOverride` lets a drag-and-drop move supply an
// explicit destination (not necessarily the active panel).
async function doPaste(operation, sources, destDirOverride) {
  pasteOperation.value = operation;
  // Paste target = the currently active panel (Ctrl+V) — i.e. the directory the
  // user is currently focused on. A drag-drop move passes an explicit destDir.
  const destDir = destDirOverride || getActivePanelRef()?.currentPath;
  if (!destDir) {
    showToast("目标目录无效", "error");
    return;
  }
  // A search-results tab is not a real directory — pasting there would ask the
  // OS to create `minitc://search/1\thing`. Say so plainly instead. (Dropping
  // onto a directory ROW inside such a tab still works: destDirForPanel
  // resolves that to the row's genuine path.)
  if (!destDirOverride && isSearchPath(destDir)) {
    showToast("搜索结果列表无法作为粘贴目标，请先跳转到实际目录", "error");
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

// ── Native drag-and-drop (OS-owned via tauri-plugin-drag) ──
//
// All webview drag-and-drop is handled by the OS (dragDropEnabled: true). When
// the user drags OUT of mini-tc, the OS shows file icons (CF_HDROP on Windows,
// NSFilenamesPboardType on macOS) and the receiving app sees real files.
// When the user drags INTO mini-tc — from Explorer / Finder / any app — the
// OS fires `tauri://drag-drop` with the absolute file paths and a physical
// cursor position; we resolve that position to a panel + drop target
// (directory row / ".." / empty area / file row) via `elementFromPoint`.
//
// We distinguish "this drop was caused by our own drag-out" from "external
// drag-in" via `consumeDragOut`: a self-out uses move semantics (cut), an
// external drag-in uses copy semantics.

import { consumeDragOut } from "./dragOutTracker.js";

// Look up which FilePanel the element belongs to by walking up to the
// nearest .file-panel container and matching the panel's exposed ref.
function panelForElement(el) {
  if (!el) return null;
  const panelEl = el.closest && el.closest(".file-panel");
  if (!panelEl) return null;
  // Each panel has `data-panel-id="left"|"right"` (set on its root); we use
  // that to pick the matching ref.
  const id = panelEl.getAttribute("data-panel-id");
  if (id === "left") return leftPanel.value;
  if (id === "right") return rightPanel.value;
  return null;
}

// Resolve where a drop would land from the DOM element under the cursor:
//   { type: "dir",     name, index } → a directory row (move INTO it)
//   { type: "parent" }                → the ".." row (move INTO parent dir)
//   { type: "current" }               → empty list area (move INTO current dir)
//   null                              → a file row (not a valid target → ignore)
function resolveDropTarget(el) {
  const rowEl = el && el.closest ? el.closest(".file-row") : null;
  if (!rowEl) return { type: "current" };
  const rt = rowEl.getAttribute("data-row-type");
  if (rt === "parent") return { type: "parent" };
  if (rt === "entry") {
    if (rowEl.getAttribute("data-is-dir") === "true") {
      return {
        type: "dir",
        name: rowEl.getAttribute("data-name"),
        // The row's own absolute path. Needed because in a search results tab
        // the rows' parent directories have nothing to do with the tab's own
        // (sentinel) path.
        path: rowEl.getAttribute("data-path") || "",
        index: Number(rowEl.getAttribute("data-index")),
      };
    }
    return null;
  }
  return { type: "current" };
}

// Highlight the panel + target under the cursor; clears highlight on the
// OTHER panel so only one row is ever lit up at a time.
function setHighlight(targetEl) {
  const target = resolveDropTarget(targetEl);
  const panel = panelForElement(targetEl);
  for (const p of [leftPanel.value, rightPanel.value]) {
    if (!p) continue;
    if (p === panel) {
      p.setDragHighlight(target);
    } else {
      p.setDragHighlight(null);
    }
  }
}

function clearAllHighlights() {
  leftPanel.value?.setDragHighlight(null);
  rightPanel.value?.setDragHighlight(null);
}

async function destDirForPanel(target, panel) {
  if (!panel) return null;
  const basePath = panel.currentPath;
  if (!basePath) return null;
  // Dropping onto a directory ROW always works, including inside a search
  // results tab: that folder is a genuine path, and `target.path` carries it
  // (joining a bare name against the sentinel `minitc://search/…` path would
  // produce nonsense).
  if (target.type === "dir") {
    return target.path || (await joinPath(basePath, target.name));
  }
  // Everything else resolves against "the directory the panel is showing",
  // which a search results tab doesn't have — so refuse rather than let the
  // backend try to create `minitc://search/1\whatever`.
  if (isSearchPath(basePath)) return null;
  if (target.type === "parent") return await getParentDir(basePath);
  return basePath;
}

async function handleNativeDrop(targetEl, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const target = resolveDropTarget(targetEl);
  if (!target) return; // dropped on a file row → ignore
  const panel = panelForElement(targetEl);
  const destDir = await destDirForPanel(target, panel);
  if (!destDir) return;

  // Skip no-op moves where a source already sits directly inside the destination
  // directory — moving `C:\dir\foo.txt` onto itself via rename is invalid and
  // silently fails at the OS layer. Without this filter the user would see a
  // confusing "移动完成，跳过 N 项" toast for a drag that visually did nothing.
  const normDest = destDir.replace(/\\/g, "/");
  const filtered = paths.filter((s) => parentDirOf(s) !== normDest);
  if (filtered.length === 0) return;

  // Self drag-out = move (cut); external drag-in = copy.
  const isSelfOut = consumeDragOut(filtered);
  const operation = isSelfOut ? "cut" : "copy";
  await doPaste(operation, filtered, destDir);
}

let unlistenDragEnter = null;
let unlistenDragOver = null;
let unlistenDragDrop = null;
let unlistenDragLeave = null;
// NOTE: `appUnmounted` is declared further below (near onMounted); the drag
// listeners below can safely reference it since setupNativeDragListeners() is
// only invoked from onMounted, long after the whole script scope has run.

// tauri://drag-* events report the cursor in PHYSICAL pixels (device pixels),
// while elementFromPoint expects CSS (logical) pixels. On displays scaled to
// 125% / 150% these differ — convert via devicePixelRatio (1 at 100% scaling).
function elFromTauriPosition(pos) {
  const dpr = window.devicePixelRatio || 1;
  return document.elementFromPoint(pos.x / dpr, pos.y / dpr);
}

function setupNativeDragListeners() {
  listen("tauri://drag-enter", (event) => {
    if (!event.payload || !event.payload.position) return;
    setHighlight(elFromTauriPosition(event.payload.position));
  }).then((fn) => { if (appUnmounted) fn(); else unlistenDragEnter = fn; });

  listen("tauri://drag-over", (event) => {
    if (!event.payload || !event.payload.position) return;
    setHighlight(elFromTauriPosition(event.payload.position));
  }).then((fn) => { if (appUnmounted) fn(); else unlistenDragOver = fn; });

  listen("tauri://drag-leave", () => {
    clearAllHighlights();
  }).then((fn) => { if (appUnmounted) fn(); else unlistenDragLeave = fn; });

  listen("tauri://drag-drop", (event) => {
    clearAllHighlights();
    if (!event.payload || !event.payload.position) return;
    handleNativeDrop(elFromTauriPosition(event.payload.position), event.payload.paths || []);
  }).then((fn) => { if (appUnmounted) fn(); else unlistenDragDrop = fn; });
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
// `asText = true` forces a plain-text read (used for user-added text-preview
// extensions that aren't built-in text types).
async function showFilePreview(entry, path, asText = false) {
  const fullPath = await entryPath(entry, path);
  previewPanel.value = activePanel.value === "left" ? "right" : "left";
  previewKind.value = "file";
  previewFilePath.value = fullPath;
  previewFileName.value = entry.name;
  previewFileBytes.value = entry.size;
  previewAsText.value = asText;
  previewVisible.value = true;
}

// Show a "format not supported" placeholder on the opposite panel.
function showUnsupportedPreview(entry) {
  previewPanel.value = activePanel.value === "left" ? "right" : "left";
  previewKind.value = "unsupported";
  previewFileName.value = entry.name;
  previewUnsupportedIsDir.value = !!entry.is_dir;
  previewVisible.value = true;
}

// User clicked "按文本预览" on an unsupported file: remember this extension as
// a text-preview extension (persisted) and immediately show it as text.
async function onPreviewAsText() {
  const name = previewFileName.value;
  // No-extension files yield ""; we store that as a sentinel so ALL
  // extension-less files are later previewed as text.
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!textPreviewExtensions.value.includes(ext)) {
    textPreviewExtensions.value = [...textPreviewExtensions.value, ext];
    await saveTextPreviewConfig();
  }
  const panel = getActivePanelRef();
  const entry = panel?.selectedEntry;
  const path = panel?.currentPath;
  if (!entry || !path) return;
  await showFilePreview(entry, path, true);
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
    const fullPath = await entryPath(entry, path);
    openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
    return;
  }

  if (!isPreviewableExt(ext)) {
    showUnsupportedPreview(entry);
    return;
  }

  await showFilePreview(entry, path, isTextPreviewExt(ext));
}

function closePreview() {
  // Remember which panel sourced the preview (the opposite of where the preview
  // was shown) and the name of the file that was being previewed, so we can
  // restore the file-list selection to it after closing.
  const sourcePanel = previewPanel.value === "left" ? "right" : "left";
  const fileName = previewFileName.value;

  previewVisible.value = false;
  previewPanel.value = "";
  previewKind.value = "";
  previewFilePath.value = "";
  previewFileName.value = "";
  previewFileBytes.value = 0;
  previewAsText.value = false;
  previewUnsupportedIsDir.value = false;

  // After leaving preview, make the SOURCE file list (the panel where the
  // previewed file lives — always the visible one, since the preview occupies
  // the opposite panel) re-select that file. Without this the list can be left
  // with no selection after Esc / Ctrl+Q. `restoreByNames` only (re)applies a
  // selection when the name is still present and never clears an existing one,
  // so it's safe even if the file list was reloaded during preview.
  if (fileName) {
    const panel = sourcePanel === "left" ? leftPanel.value : rightPanel.value;
    // Bring the source panel to the foreground so the re-selected file is the
    // focal list the user sees after the preview closes.
    activePanel.value = sourcePanel;
    nextTick(() => {
      panel?.restoreByNames?.([fileName]);
      panel?.focusList?.();
    });
  }
}

// ── Preview persistence ──
//
// Watch the primitives (not the open/close call sites) so every path that
// changes the preview — Ctrl+Q, ↑/↓ clip navigation, autoplay advance, Esc,
// panel switches, the selection-follow watcher — funnels through here and
// ~/.minitc/view-state.json can never drift out of sync with what's on screen.
watch(
  () => ({
    visible: previewVisible.value,
    panel: previewPanel.value,
    kind: previewKind.value,
    path: previewFilePath.value,
    name: previewFileName.value,
    bytes: previewFileBytes.value,
    asText: previewAsText.value,
  }),
  (s) => {
    // `unsupported` is a placeholder with nothing to render, so it's not worth
    // restoring — record "no preview" for it rather than the path.
    setPreviewRestore(
      s.visible && (s.kind === "file" || s.kind === "video")
        ? { ...s }
        : null
    );
  },
  { deep: true }
);

// Re-open the preview that was on screen when the app last exited.
//
// Runs after view-state has loaded AND both panels have listed (otherwise the
// preview would cover an empty panel, and the file list behind it wouldn't have
// the previewed file selected). A file deleted while the app was closed simply
// means the restore is skipped — `showFilePreview`-equivalent state is applied
// directly rather than going through togglePreview(), because there is no
// selection to derive it from yet.
async function restorePreview() {
  // Must wait for the load itself, not just for App.onMounted to have kicked it
  // off — `consumePreviewRestore()` reads the value that loadViewState fills in.
  await loadViewState();
  const p = consumePreviewRestore();
  if (!p) return;
  // Wait for both panels' first listing (each fires once; the listener is
  // removed as soon as both have arrived).
  await new Promise((resolve) => {
    let seen = 0;
    const onListed = () => {
      seen += 1;
      if (seen >= 2) {
        window.removeEventListener("minitc:panel-listed", onListed);
        resolve();
      }
    };
    window.addEventListener("minitc:panel-listed", onListed);
    // Safety net: if a panel somehow never reports (error path already fires
    // it, but a panic before that would hang us), restore anyway.
    setTimeout(() => {
      window.removeEventListener("minitc:panel-listed", onListed);
      resolve();
    }, 3000);
  });

  if (!(await pathExists(p.path))) return;

  previewPanel.value = p.panel;
  previewKind.value = p.kind;
  previewFilePath.value = p.path;
  previewFileName.value = p.name;
  previewFileBytes.value = p.bytes;
  previewAsText.value = p.kind === "file" && p.asText === true;
  previewVisible.value = true;

  // The preview occupies the opposite panel, so the source list is the one the
  // user was looking at — make it active and re-select the file so Esc /
  // Ctrl+Q behave exactly as if the preview had never been closed.
  const source = p.panel === "left" ? "right" : "left";
  activePanel.value = source;
  const panel = source === "left" ? leftPanel.value : rightPanel.value;
  if (p.name) panel?.restoreByNames?.([p.name]);
  panel?.focusList?.();
}

// When entries are deleted in a panel, check whether the whole directory got
// emptied. The preview always shows a file from the OPPOSITE panel (the source
// panel), so if that source panel is now empty there is nothing left to
// preview — exit the preview state. Triggered by FilePanel's `deleted` event.
function onPanelDeleted({ panelId, remainingCount }) {
  if (!previewVisible.value) return;
  const source = previewPanel.value === "left" ? "right" : "left";
  if (panelId !== source) return;
  if (remainingCount === 0) closePreview();
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
      const fullPath = await entryPath(entry, path);
      if (previewVisible.value && previewKind.value === "video") {
        // Already in video preview → just swap the source without remounting.
        previewFilePath.value = fullPath;
        previewFileName.value = entry.name;
        previewFileBytes.value = entry.size;
      } else {
        // Switching from an image/text/unsupported preview to a video: call
        // openVideo() directly — do NOT closePreview() first. closePreview()
        // restores the previously previewed file's selection in the source
        // panel via a nextTick, which re-fires this watch and clobbers the
        // just-opened video preview (the old image snaps back). The preview
        // panel is always the opposite of the source panel, so openVideo keeps
        // it on the same side and we only need to swap the kind.
        openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
      }
      return;
    }
    if (!isPreviewableExt(ext)) {
      showUnsupportedPreview(entry);
      return;
    }

    const panel = getActivePanelRef();
    const path = panel?.currentPath;
    if (!path) return;

    await showFilePreview(entry, path, isTextPreviewExt(ext));
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
    const fullPath = await entryPath(entry, path);
    if (previewVisible.value && previewKind.value === "video") {
      previewFilePath.value = fullPath;
      previewFileName.value = entry.name;
      previewFileBytes.value = entry.size;
    } else {
      // Switch from image/text/unsupported to video without closePreview()
      // (see the selection-watch branch for why — closePreview's nextTick
      // re-selects the old file and clobbers the new video preview).
      openVideo({ path: fullPath, name: entry.name, bytes: entry.size, sourcePanel: activePanel.value });
    }
    return;
  }
  if (!isPreviewableExt(ext)) {
    showUnsupportedPreview(entry);
    return;
  }

  const path = panel?.currentPath;
  if (!path) return;

  await showFilePreview(entry, path, isTextPreviewExt(ext));
});

// ── Window focus regain ──
// Typical case: right-click an archive → extract with 7-Zip → the external
// window opens, does its work and closes → the user comes back to mini-tc.
// On regain we re-list both panels (another app may have moved/deleted files),
// drop stale cut-ghosting, refresh the free-space readouts, and — the point of
// this handler — hand keyboard focus back to the active file list. Without the
// focus restore the caret is stranded outside the webview: the list sits there
// with nothing focused and arrow keys / Enter do nothing until the user clicks
// a row by hand.
let lastRegainAt = 0;
let unlistenTauriFocus = null;
let appUnmounted = false;

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

// Put keyboard focus back on the active panel's file list. Skipped while the
// user is typing somewhere (address bar, filename filter, inline rename) or is
// inside a preview surface, so we never yank focus out of a live interaction.
function restoreActiveListFocus() {
  const el = document.activeElement;
  if (isTypingTarget(el)) return;
  if (el && el.closest && el.closest(".file-preview, iframe, video")) return;
  const panel = activePanel.value === "left" ? leftPanel.value : rightPanel.value;
  panel?.focusList?.();
}

async function onWindowFocusRegain() {
  // `tauri://focus` and the DOM `focus` event both fire for one regain (and
  // some paths fire them a few times); debounce so we don't re-list repeatedly.
  const now = Date.now();
  if (now - lastRegainAt < 500) return;
  lastRegainAt = now;

  await Promise.all([leftPanel.value?.refresh?.(), rightPanel.value?.refresh?.()]);
  // Refresh the drive free-space figures in both PathBar dropdowns too, so
  // the remaining-capacity readouts stay current after the user has been
  // doing work outside mini-tc (copying files, etc.).
  leftPanel.value?.refreshDrives?.();
  rightPanel.value?.refreshDrives?.();
  leftPanel.value?.clearCut?.();
  rightPanel.value?.clearCut?.();
  restoreActiveListFocus();
}

function onVisibilityRegain() {
  if (!document.hidden) onWindowFocusRegain();
}

// Keyboard shortcuts
onMounted(() => {
  // Native OS drag-and-drop listeners (dragDropEnabled: true makes Tauri own
  // all webview drag events). tauri://drag-over gives us a continuous stream
  // of cursor positions while a drag is in flight; we resolve each to a
  // highlight target via elementFromPoint.
  setupNativeDragListeners();

  // Window regained focus (the handler above owns the refresh + focus restore).
  listen("tauri://focus", onWindowFocusRegain).then((fn) => {
    // If the component is already gone by the time the promise settles, drop
    // the listener right away instead of leaking it.
    if (appUnmounted) fn();
    else unlistenTauriFocus = fn;
  });
  // DOM-level fallbacks: when an external 7-Zip window closes and hands focus
  // straight back, `tauri://focus` is not always emitted, and a minimized /
  // occluded window restore only shows up here.
  window.addEventListener("focus", onWindowFocusRegain);
  document.addEventListener("visibilitychange", onVisibilityRegain);

  document.addEventListener("keydown", (e) => {
    // Skip keys already consumed by a more specific scope (the file list runs
    // first because it listens on the element, the video preview runs first
    // because it listens on the capture phase).
    if (isHandled(e)) return;

    // The search dialog is modal and owns the keyboard: Esc is caught in its
    // capture phase, Enter lives on its inputs. Everything else must be let
    // go — otherwise typing a pattern also drives the panels underneath
    // (Backspace walks up a directory, Delete removes files, arrows move the
    // cursor behind the overlay).
    if (searchVisible.value) return;

    // Same for the batch-rename dialog: it owns Esc (capture phase) and its
    // rule inputs. Ctrl+M itself is re-checked below so it isn't swallowed.
    if (batchRenameVisible.value) return;

    // Esc: close the current preview (image / text / pdf / video / unsupported)
    // and return the source file list to the file that was just previewed. When
    // no preview is open, this is a no-op — Esc no longer cancels selection on
    // the file grid, so we only act while a preview is visible.
    // If focus is inside a text input (the source panel's filename filter or
    // address bar, which stay interactive during preview), let that input handle
    // Esc on its own (e.g. cancel the filter) instead of closing the preview.
    if (matches("preview.close", e) && previewVisible.value) {
      const t = e.target;
      const inEditable =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!inEditable) {
        e.preventDefault();
        markHandled(e);
        closePreview();
        return;
      }
    }

    // Ctrl+Q: Toggle file preview
    if (matches("preview.toggle", e)) {
      e.preventDefault();
      markHandled(e);
      togglePreview();
      return;
    }

    // Alt+F7 / Ctrl+F: recursive file search. Plain function-ish keys with no
    // webview meaning of their own, so they're consumed even while an input has
    // focus — except inside the search dialog itself (the dialog owns its own
    // Enter/Esc handling and the user may be typing a pattern).
    if (matches("search.open", e)) {
      if (searchVisible.value) return;
      e.preventDefault();
      markHandled(e);
      openSearch();
      return;
    }

    // Ctrl+A: select all entries in the active panel (skip when typing in a text input).
    if (matches("edit.selectAll", e)) {
      const t = e.target;
      if (t && t.tagName === "INPUT") return; // let the filter input select its text
      e.preventDefault();
      markHandled(e);
      getActivePanelRef()?.selectAll?.();
      return;
    }

    // Ctrl+C / Ctrl+X / Ctrl+V: clipboard copy / cut / paste.
    // When focus is in a text input (the address bar or the filename filter),
    // let the browser handle these natively — e.g. pasting a copied path
    // string into the address bar. The file-clipboard handler below only makes
    // sense on the file grid, and intercepting here would preventDefault the
    // native text paste (and then wrongly report "剪贴板为空" when the
    // clipboard holds plain text, not a file list).
    const isCopy = matches("edit.copy", e);
    const isCut = matches("edit.cut", e);
    const isPaste = matches("edit.paste", e);
    if (isCopy || isCut || isPaste) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return; // let the browser do native text copy/cut/paste
      }
      if (isCopy || isCut) {
        // If the user has selected text inside a preview pane, let the browser
        // copy that text natively instead of treating it as a file clipboard op
        // (file-list selection → copy file; preview text selection → copy text).
        if (hasPreviewTextSelection()) return;
        // PDF 预览聚焦时放行 Ctrl+C（复制 PDF 内文本），交由 WebView 原生处理。
        // Ctrl+X 不放行（PDF 只读，无剪切内容语义，仍按文件剪切逻辑处理）。
        if (isCopy && isPdfIframeFocused()) return;
      }
      e.preventDefault();
      markHandled(e);
      if (isCopy) setClipboard("copy");
      else if (isCut) setClipboard("cut");
      else pasteFromClipboard();
      return;
    }

    // F5 / Shift+F5: copy / move the selection into the OTHER panel's current
    // directory (Total Commander keys). Deliberately NOT part of the clipboard
    // branch above: these never touch the system clipboard, they go straight
    // from the active panel's selection to the inactive panel's path.
    //
    // Both are plain function keys with no webview-native meaning, so they are
    // consumed even while the address bar or the filename filter has focus
    // (same reasoning as Ctrl+T below) — the one exception is a rename box,
    // which is a text field where a stray F5 clearly means "not for me".
    if (matches("edit.copyToOther", e) || matches("edit.moveToOther", e)) {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.classList.contains("rename-input")) return;
      // Resolve BOTH bindings before consuming: markHandled() makes every
      // later matches() on the same event return false.
      const isMove = matches("edit.moveToOther", e);
      e.preventDefault();
      markHandled(e);
      transferToOtherPanel(isMove ? "cut" : "copy");
      // Focus stays on the SOURCE panel (like TC): the user usually wants to
      // keep working through the same selection. doPaste refreshes both panels.
      return;
    }

    // Ctrl+M: batch rename the active panel's selection. Plain Ctrl combo with
    // no webview-native meaning, so it is consumed even while an input has
    // focus — except in a rename box, which is a text field where Ctrl+M
    // clearly means "insert a newline", not "rename files".
    if (matches("list.batchRename", e)) {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.classList.contains("rename-input")) return;
      // Already open: let the key reach the dialog's own inputs rather than
      // reopening (and resetting) it.
      if (batchRenameVisible.value) return;
      e.preventDefault();
      markHandled(e);
      openBatchRename();
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: rotate to the next / previous tab of the
    // ACTIVE panel (Total Commander keys). Checked BEFORE panel.switch so
    // these two combos can never be claimed by the bare-Tab handler, which
    // still owns plain `Tab`. Both are plain Ctrl combos with no webview-native
    // meaning, so they are always consumed — even while the filename filter or
    // the address bar has focus.
    if (matches("tab.next", e) || matches("tab.prev", e)) {
      // Resolve BOTH bindings before consuming the event: `markHandled` makes
      // every later `matches()` on the same event return false.
      const delta = matches("tab.next", e) ? 1 : -1;
      e.preventDefault();
      markHandled(e);
      const panel = getActivePanelRef();
      const tab = panel?.cycleTab?.(delta);
      // Only one tab open → nothing moved; stay quiet instead of a toast that
      // repeats the same text on every keypress.
      if (tab) showToast(`已切换到标签页：${tab.path}`, "info");
      // Keep the DOM focus on the file grid so the arrow keys immediately
      // drive the newly active tab.
      getActivePanelRef()?.focusList?.();
      return;
    }

    // Ctrl+T / Ctrl+W: new / close a tab in the ACTIVE panel (Total Commander
    // keys). Both are plain Ctrl combos with no webview-native meaning, so we
    // always consume them — even while the filename filter or the address bar
    // has focus, which is where a new tab is most often wanted.
    if (matches("tab.new", e) || matches("tab.close", e)) {
      // Resolve BOTH bindings before consuming the event: `markHandled` makes
      // every later `matches()` on the same event return false.
      const isNew = matches("tab.new", e);
      e.preventDefault();
      markHandled(e);
      const panel = getActivePanelRef();
      if (isNew) panel?.addTab?.();
      else panel?.closeActiveTab?.();
      // Keep the DOM focus on the file grid so the arrow keys immediately
      // drive the (new) active tab.
      getActivePanelRef()?.focusList?.();
      return;
    }

    // Ctrl+Shift+L / Ctrl+Y: lock / unlock the active panel's current tab, and
    // jump it back to its locked dir (Total Commander's "lock tab, directory
    // changes allowed"). Locking only records an anchor — the tab keeps
    // navigating freely, exactly like TC.
    if (matches("tab.lock", e) || matches("tab.jumpLocked", e)) {
      // Resolve both before markHandled() (which makes later matches() false).
      const isLock = matches("tab.lock", e);
      e.preventDefault();
      markHandled(e);
      const panel = getActivePanelRef();
      if (isLock) {
        const res = panel?.toggleLock?.();
        if (res?.locked) showToast(`已锁定当前标签页：${res.tab.path}`, "info");
        else if (res) showToast("已解除标签页锁定", "info");
      } else {
        const res = panel?.jumpToLocked?.();
        if (res?.ok) showToast(`已回到锁定位置：${res.path}`, "info");
        else if (res?.reason === "unlocked") showToast("当前标签页未锁定", "info");
        // reason === "same" / "none": already there (or no panel) — stay quiet.
      }
      // Keep DOM focus on the file grid so navigation continues from here.
      getActivePanelRef()?.focusList?.();
      return;
    }

    // Alt+← / Alt+→: walk the active tab's own directory history (browser
    // style). Each tab keeps an independent stack, persisted with it, so a
    // restart can still walk back. Alt+ArrowLeft/Right have no webview-native
    // meaning of their own (the browser's back/forward is plain Alt+← only on
    // some builds and never fires inside a Tauri webview), so they're always
    // consumed — same reasoning as Ctrl+T above.
    if (matches("nav.back", e) || matches("nav.forward", e)) {
      // Resolve both before markHandled() (which makes later matches() false).
      const isBack = matches("nav.back", e);
      const panel = getActivePanelRef();
      // Don't consume the key when this panel has nowhere to go: letting it
      // fall through keeps the combo available to the webview, and the
      // PathBar's ← / → buttons already show the state as disabled.
      if (!(isBack ? panel?.canGoBack?.() : panel?.canGoForward?.())) return;
      e.preventDefault();
      markHandled(e);
      const res = isBack ? panel.goBack() : panel.goForward();
      // `stepHistory` awaits a pathExists() probe per skipped entry, so it
      // settles asynchronously even on the fast path.
      Promise.resolve(res).then((r) => {
        if (r?.ok && r.dropped) {
          showToast(`已跳过 ${r.dropped} 个已不存在的目录`, "info");
        }
        getActivePanelRef()?.focusList?.();
      });
      return;
    }

    // Ctrl+D: add the active panel's current directory to the global bookmark
    // list (~/.minitc/bookmarks.json), or remove it when it's already there.
    // A search-results tab has no real directory to bookmark, so it's rejected
    // rather than storing the `minitc://search/…` sentinel.
    if (matches("bookmark.toggle", e)) {
      // A text input owns its own keys: while renaming a bookmark the ⭐
      // dropdown has a focused `.bm-input`, and toggling the bookmark out from
      // under the user's cursor would be a nasty surprise.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const panel = getActivePanelRef();
      const cur = panel?.currentPath;
      // No panel at all, or one parked on a search-results tab → let the key
      // fall through to the webview instead of consuming it for nothing.
      if (!cur || panel?.isVirtual?.()) return;
      e.preventDefault();
      markHandled(e);
      const existing = findBookmark(cur);
      if (existing) {
        removeBookmark(existing.id);
        showToast(`已移除书签：${existing.name}`, "info");
      } else {
        const res = addBookmark(cur);
        if (res.ok) showToast(`已添加书签：${res.bookmark.name}`, "success");
      }
      getActivePanelRef()?.focusList?.();
      return;
    }

    // Ctrl+H: show / hide hidden entries (dotfiles, hidden & system attributes)
    // in the ACTIVE panel. The two panels keep independent state, so this
    // never touches the other side. Filtering is purely front-end (the backend
    // always returns the full listing), so the toggle is instant even in a
    // directory with thousands of entries — no re-listing.
    if (matches("view.toggleHidden", e)) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const panelId = activePanel.value;
      const now = toggleHiddenForPanel(panelId);
      e.preventDefault();
      markHandled(e);
      showToast(
        `${now ? "已显示" : "已隐藏"}隐藏文件（${panelId === "left" ? "左" : "右"}栏）`,
        "info"
      );
      // The row set changed under the cursor, so put keyboard focus back on
      // the list rather than leaving it on <body>.
      getActivePanelRef()?.focusList?.();
      return;
    }

    // Tab / Ctrl+Tab: Switch active panel (skip if target is showing preview)
    if (matches("panel.switch", e)) {
      // A bare Tab is a real browser key (focus traversal), so it only means
      // "switch panel" when a file list actually owns the focus — the Total
      // Commander behaviour. Anywhere else (address bar, filename filter,
      // inline rename, dialog buttons, right-click menu) we must fall through
      // and let the webview move focus natively, otherwise keyboard users can't
      // leave a text field or reach a dialog button.
      // Only a bare `Tab` is bound now — Ctrl+Tab belongs to tab.next above —
      // but the guard stays on the combo so a user rebinding can't reintroduce
      // a Ctrl combo that would then hijack the filter input's focus exit.
      const bareTab = eventCombo(e) === "Tab";
      if (bareTab) {
        const t = e.target;
        if (isTypingTarget(t)) return;
        // Reject anything outside the file grids (menus, dialogs, preview
        // surfaces) — only `.file-list` containers opt in.
        if (!t || !t.closest || !t.closest(".file-list")) return;
      }
      if (previewVisible.value) {
        // Don't allow switching to the preview panel. Fall through WITHOUT
        // consuming the key so a bare Tab still traverses focus natively.
        return;
      }
      e.preventDefault();
      markHandled(e);
      activePanel.value = activePanel.value === "left" ? "right" : "left";
      // Hand the DOM keyboard focus to the newly active panel so the arrow
      // keys that follow drive THAT list, not the one we just left.
      getActivePanelRef()?.focusList?.();
    }
  });
});

onUnmounted(() => {
  appUnmounted = true;
  if (unlistenTauriFocus) unlistenTauriFocus();
  if (unlistenDragEnter) unlistenDragEnter();
  if (unlistenDragOver) unlistenDragOver();
  if (unlistenDragDrop) unlistenDragDrop();
  if (unlistenDragLeave) unlistenDragLeave();
  window.removeEventListener("focus", onWindowFocusRegain);
  document.removeEventListener("visibilitychange", onVisibilityRegain);
  // Never leave the window pinned above other apps on the way out.
  alwaysOnTop.reset();
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

.menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}

.check-mark {
  width: 14px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}

/* ── Cascading sub-menu ── */

.submenu-trigger {
  position: relative;
}

.submenu-arrow {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.6;
}

.submenu-dropdown {
  position: absolute;
  top: -4px;
  left: 100%;
  min-width: 140px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 101;
  padding: 4px 0;
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
