<template>
  <div class="settings-overlay" @click.self="$emit('close')">
    <div class="settings-dialog">
      <div class="settings-header">
        <span>设置</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="settings-body">
        <!--
          Settings are organised as independent <section> blocks so future
          config items (e.g. max preview size, default sort, video autoplay
          toggle) can be added here without touching the surrounding shell.
        -->

        <!-- ── Section: text-preview extensions ── -->
        <section class="settings-section">
          <div class="section-title">
            <span>文本预览后缀</span>
            <span class="section-hint">以内置文本方式预览的文件后缀</span>
          </div>
          <p class="section-desc">
            勾选的后缀将以内置文本方式预览（如 <code>.txt</code> / <code>.md</code> /
            <code>.json</code> / <code>.log</code>）。取消勾选则不再以文本预览；未加入此列表
            的后缀选中后将显示「暂不支持预览该格式」。
          </p>

          <div class="ext-list">
            <div
              v-for="item in displayList"
              :key="item.ext"
              class="ext-chip"
              :class="{ disabled: !isEnabled(item.ext), builtin: item.builtin }"
              :title="isEnabled(item.ext) ? '点击取消文本预览' : '点击启用文本预览'"
              @click="toggleExt(item.ext)"
            >
              <span class="ext-name">{{ item.ext === '' ? '(无后缀)' : '.' + item.ext }}</span>
              <span v-if="item.builtin" class="ext-tag">内置</span>
              <span class="ext-state">{{ isEnabled(item.ext) ? '✓' : '+' }}</span>
            </div>
          </div>

          <div class="ext-add">
            <input
              v-model="newExt"
              class="ext-input"
              type="text"
              placeholder="添加后缀，如 csv"
              @keydown.enter.prevent="addExt"
            />
            <button class="btn-add" @click="addExt">添加</button>
            <button class="btn-reset" @click="resetDefaults">恢复默认</button>
          </div>
          <p class="ext-error" v-if="extError">{{ extError }}</p>
        </section>

        <!-- Future sections go here. -->
      </div>

      <div class="settings-footer">
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button class="btn-primary" @click="save">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";

const props = defineProps({
  // Currently enabled text-preview extensions (array of lowercase ext strings).
  extensions: { type: Array, default: () => [] },
  // Built-in text extensions that ship enabled by default.
  builtins: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "save"]);

// Local editable copy so cancelling discards changes.
const localExts = ref([...props.extensions]);
const newExt = ref("");
const extError = ref("");

// Reset local state whenever the dialog is (re)opened with fresh props.
watch(
  () => props.extensions,
  (v) => {
    localExts.value = [...v];
    newExt.value = "";
    extError.value = "";
  },
  { immediate: true }
);

// Everything that should be visible: enabled exts plus built-ins (so a
// disabled built-in can still be re-enabled). Sorted for a stable layout.
const displayList = computed(() => {
  const set = new Set([...localExts.value, ...props.builtins]);
  return [...set]
    .map((ext) => ({ ext, builtin: props.builtins.includes(ext) }))
    .sort((a, b) => a.ext.localeCompare(b.ext));
});

function isEnabled(ext) {
  return localExts.value.includes(ext);
}

function toggleExt(ext) {
  if (isEnabled(ext)) {
    localExts.value = localExts.value.filter((e) => e !== ext);
  } else {
    localExts.value = [...localExts.value, ext];
  }
}

// Normalise user input: lowercase, drop leading dots, keep only [a-z0-9].
function normalizeExt(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function addExt() {
  extError.value = "";
  const ext = normalizeExt(newExt.value);
  if (!ext) {
    extError.value = "请输入有效的后缀（字母或数字）";
    return;
  }
  if (localExts.value.includes(ext)) {
    extError.value = `后缀 .${ext} 已在列表中`;
    newExt.value = "";
    return;
  }
  localExts.value = [...localExts.value, ext];
  newExt.value = "";
}

function resetDefaults() {
  localExts.value = [...props.builtins];
  extError.value = "";
}

function save() {
  emit("save", [...localExts.value]);
}
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.settings-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 460px;
  max-width: 92vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.close-btn {
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

.settings-body {
  padding: 16px;
  overflow-y: auto;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.section-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
}

.section-desc {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}

.section-desc code {
  font-family: "Cascadia Code", "Consolas", monospace;
  background: var(--hover-bg);
  padding: 0 3px;
  border-radius: 3px;
  color: var(--text);
}

.ext-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.ext-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 14px;
  background: var(--accent-dim, rgba(80, 130, 200, 0.18));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition: opacity 0.15s, background 0.15s;
}

.ext-chip:hover {
  background: var(--accent);
  color: #fff;
}

.ext-chip.disabled {
  border-color: var(--border);
  background: transparent;
  color: var(--text-dim);
  opacity: 0.7;
}

.ext-chip.disabled:hover {
  background: var(--hover-bg);
  color: var(--text);
  opacity: 1;
}

.ext-chip.builtin .ext-tag {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  color: inherit;
}

.ext-state {
  font-size: 12px;
  width: 12px;
  text-align: center;
}

.ext-add {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ext-input {
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

.ext-input:focus {
  border-color: var(--accent);
}

.btn-add,
.btn-reset {
  padding: 5px 14px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.btn-add {
  border: none;
  background: var(--accent);
  color: #fff;
}

.btn-add:hover {
  opacity: 0.9;
}

.btn-reset {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
}

.btn-reset:hover {
  background: var(--hover-bg);
}

.ext-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger);
}

.settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
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
