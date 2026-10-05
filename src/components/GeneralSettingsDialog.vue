<template>
  <div class="gen-overlay" @click.self="$emit('close')">
    <div class="gen-dialog">
      <div class="gen-header">
        <span>通用设置</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="gen-body">
        <section class="gen-section" v-for="item in ITEMS" :key="item.key">
          <div class="section-title">
            <span>{{ item.title }}</span>
            <span class="section-hint">{{ item.hint }}</span>
          </div>
          <p class="section-desc" v-if="item.desc">{{ item.desc }}</p>

          <label class="switch-row" :title="item.title">
            <input
              type="checkbox"
              class="switch-input"
              :checked="local[item.key]"
              @change="setValue(item.key, $event.target.checked)"
            />
            <span class="switch-box" aria-hidden="true"></span>
            <span class="switch-text">{{ local[item.key] ? '已开启' : '已关闭' }}</span>
          </label>
        </section>
      </div>

      <div class="gen-footer">
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button class="btn-primary" @click="save">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, watch } from "vue";

// ── Declarative config schema ──
// Adding a future option is a one-line change: append an object here and it
// gets a rendered row, persistence and reset-to-default for free. Only the
// `toggle` type exists so far; add branches (and UI) when a new kind of option
// (number / select / text) is actually needed rather than speculating.
const ITEMS = [
  {
    key: "videoPreviewAlwaysOnTop",
    type: "toggle",
    title: "视频预览时窗口置顶",
    hint: "预览视频时，MiniTC 窗口保持在所有窗口之上",
    desc: "开启后，播放视频预览时整个 MiniTC 窗口会浮到其他程序窗口上方；关闭预览后自动还原。关闭视频预览或按 Esc 退出预览也会立即还原窗口层级。",
    default: false,
  },
];

// Built-in defaults, derived from the schema so ITEMS stays the single source
// of truth — adding an entry with a `default` is enough.
const DEFAULTS = Object.fromEntries(ITEMS.map((i) => [i.key, i.default]));

const props = defineProps({
  // Current values keyed by `ITEMS[].key`. Missing keys fall back to the
  // schema default, so an older saved config still opens cleanly.
  values: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["close", "save"]);

// Local editable copy so 取消 discards changes.
const local = reactive({ ...DEFAULTS });

// Reset local state whenever the dialog is (re)opened with fresh props.
watch(
  () => props.values,
  (v) => {
    for (const item of ITEMS) {
      const raw = v?.[item.key];
      local[item.key] = typeof raw === "boolean" ? raw : DEFAULTS[item.key];
    }
  },
  { immediate: true, deep: true }
);

function setValue(key, val) {
  local[key] = !!val;
}

function save() {
  emit("save", { ...local });
}
</script>

<style scoped>
.gen-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.gen-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 480px;
  max-width: 92vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.gen-header {
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

.gen-body {
  padding: 16px;
  overflow-y: auto;
}

.gen-section {
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

/* Toggle switch — the native checkbox is invisible but stays focusable, so
   keyboard operation and the `:checked` binding work without reimplementation. */
.switch-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.switch-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.switch-box {
  position: relative;
  width: 38px;
  height: 21px;
  border-radius: 11px;
  background: var(--hover-bg);
  border: 1px solid var(--border);
  transition: background 0.15s, border-color 0.15s;
  flex: none;
}

.switch-box::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.15s, background 0.15s;
}

.switch-input:checked + .switch-box {
  background: var(--accent);
  border-color: var(--accent);
}

.switch-input:checked + .switch-box::after {
  transform: translate(17px, -50%);
  background: #fff;
}

.switch-input:focus-visible + .switch-box {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.switch-text {
  font-size: 12px;
  color: var(--text-dim);
}

.gen-footer {
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
