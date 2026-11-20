<template>
  <div class="notepad">
    <div class="notepad-header">
      <span class="notepad-icon">✎</span>
      <span class="notepad-title">记事本</span>
      <span class="notepad-badge">可编辑</span>
      <span class="save-status" :class="{ dirty: dirty, failed: !!error }">{{ statusText }}</span>
      <button class="close-btn" @click="$emit('close')" title="关闭记事本 (Esc / Ctrl+E)">✕</button>
    </div>
    <div class="notepad-body">
      <textarea
        ref="editorRef"
        v-model="text"
        class="notepad-editor"
        spellcheck="false"
        aria-label="记事本"
        @input="onInput"
      ></textarea>
    </div>
    <div class="notepad-footer">
      <span>{{ charCount }} 字符 · {{ lineCount }} 行</span>
      <span>每 {{ SAVE_INTERVAL_MS / 1000 }} 秒自动保存到 ~/.minitc/notepad.json</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { loadConfig, saveConfig } from "../api.js";

// The notepad is an editable, plain-text "preview". Its content lives in the
// SAME ~/.minitc directory as every other app setting, through the same
// atomic / per-name serialized save_config channel — so a crash during a
// scheduled write can never leave a half-written note behind.
const CONFIG_KEY = "notepad";
const SAVE_INTERVAL_MS = 1000;

defineEmits(["close"]);

const text = ref("");
const dirty = ref(false);
const saving = ref(false);
const error = ref("");
const editorRef = ref(null);

let saveTimer = null;
let disposed = false;

const charCount = computed(() => Array.from(text.value).length);
const lineCount = computed(() => text.value.split("\n").length);
const statusText = computed(() => {
  if (error.value) return "保存失败";
  if (saving.value) return "保存中…";
  return dirty.value ? "未保存" : "已保存";
});

function onInput() {
  dirty.value = true;
}

/// Write only when something actually changed. `dirty` is cleared BEFORE the
/// await: text typed while the IPC is in flight must leave the flag set for
/// the next tick, otherwise those last keystrokes are silently lost.
async function flush(force = false) {
  if (!dirty.value || (disposed && !force)) return;
  const body = text.value;
  dirty.value = false;
  saving.value = true;
  try {
    await saveConfig(CONFIG_KEY, body);
    if (!disposed) error.value = "";
  } catch (e) {
    console.error("Failed to save notepad:", e);
    dirty.value = true;
    if (!disposed) error.value = String(e?.message || e);
  } finally {
    saving.value = false;
  }
}

function onPageHide() {
  flush();
}

onMounted(async () => {
  try {
    const raw = await loadConfig(CONFIG_KEY);
    // A fast typist can start editing before the IPC read lands; never
    // overwrite keystrokes with the older on-disk snapshot.
    if (!disposed && !dirty.value) text.value = raw ?? "";
  } catch (e) {
    console.error("Failed to load notepad:", e);
    if (!disposed) error.value = String(e?.message || e);
  }
  // nextTick: the component is mounted into a panel that was just swapped in;
  // focus only after Vue has inserted the textarea, so Ctrl+E is immediately
  // followed by typing rather than by a lost keystroke.
  nextTick(() => editorRef.value?.focus());
  saveTimer = setInterval(flush, SAVE_INTERVAL_MS);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);
});

onBeforeUnmount(() => {
  disposed = true;
  clearInterval(saveTimer);
  saveTimer = null;
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("beforeunload", onPageHide);
  // Closing the notepad (Esc / Ctrl+E / Ctrl+Q / app exit) must not drop the
  // last second of typing. `force` bypasses the disposed guard set above.
  flush(true);
});
</script>

<style scoped>
.notepad {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--panel-bg);
  border: 1px solid var(--accent);
  overflow: hidden;
}

.notepad-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  min-height: 26px;
  user-select: none;
}

.notepad-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.notepad-title {
  color: var(--text);
  font-weight: 600;
}

.notepad-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--accent-dim);
  color: #fff;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.save-status {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}

.save-status.dirty {
  color: var(--warning, #e0a030);
}

.save-status.failed {
  color: var(--danger);
}

.close-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 3px;
  flex-shrink: 0;
}

.close-btn:hover {
  background: var(--accent-dim);
  color: var(--text);
}

.notepad-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.notepad-editor {
  flex: 1;
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  outline: none;
  padding: 8px 10px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
  tab-size: 4;
}

.notepad-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 8px;
  border-top: 1px solid var(--border);
  background: var(--header-bg);
  color: var(--text-dim);
  font-size: 10px;
  white-space: nowrap;
  user-select: none;
}
</style>
