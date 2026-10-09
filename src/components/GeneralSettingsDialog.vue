<template>
  <div class="gen-overlay" @click.self="$emit('close')">
    <div class="gen-dialog">
      <div class="gen-header">
        <span>通用设置</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="gen-body">
        <section class="gen-section" v-for="group in GROUPS" :key="group.title">
          <div class="section-title">
            <span>{{ group.title }}</span>
            <span class="section-hint">{{ group.hint }}</span>
          </div>
          <p class="section-desc" v-if="group.desc">{{ group.desc }}</p>

          <div class="gen-row" v-for="item in group.items" :key="item.key">
            <span class="row-label" :title="item.hint || item.title">{{ item.title }}</span>

            <!-- Toggle switch — the native checkbox is invisible but stays
                 focusable, so keyboard operation and the `:checked` binding
                 work without reimplementation. -->
            <label v-if="item.type === 'toggle'" class="switch-row" :title="item.title">
              <input
                type="checkbox"
                class="switch-input"
                :checked="local[item.key]"
                @change="setValue(item.key, $event.target.checked)"
              />
              <span class="switch-box" aria-hidden="true"></span>
              <span class="switch-text">{{ local[item.key] ? '已开启' : '已关闭' }}</span>
            </label>

            <select
              v-else-if="item.type === 'select'"
              class="gen-select"
              :value="local[item.key]"
              @change="setValue(item.key, $event.target.value)"
            >
              <option v-for="opt in item.options" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
            </select>
          </div>
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
import { SORT_COLUMNS, SORT_DIRECTIONS } from "../viewState.js";

// ── Declarative config schema ──
// Adding a future option is a small change: append an object to a group's
// `items` and it gets a rendered row, persistence and reset-to-default for
// free. Two row types exist (`toggle` / `select`); add branches (and UI) when a
// new kind of option (number / text / path) is actually needed rather than
// speculating.
//
// NOTE: rows are addressed by a FLAT key across all groups (not per-group), so
// a key must stay globally unique.
//
// The `view.*` rows are NOT persisted in ~/.minitc/app-config.json — App.vue
// routes them to viewState.js (~/.minitc/view-state.json), which owns them as
// live module state so the panels can react without an IPC round-trip. The
// split is by key prefix, see `VIEW_PREFIX` in App.vue.
const GROUPS = [
  {
    title: "预览",
    hint: "文件预览的窗口行为",
    items: [
      {
        key: "videoPreviewAlwaysOnTop",
        type: "toggle",
        title: "视频预览时窗口置顶",
        hint: "预览视频时，MiniTC 窗口保持在所有窗口之上",
        desc: "开启后，播放视频预览时整个 MiniTC 窗口会浮到其他程序窗口上方；关闭预览后自动还原。关闭视频预览或按 Esc 退出预览也会立即还原窗口层级。",
        default: false,
      },
    ],
  },
  {
    title: "视图",
    hint: "隐藏文件、列宽与默认排序",
    desc: "列宽可直接拖动列表表头右侧的分隔线调整（Name / Size / Type / Modified 四列都可调），双击分隔线恢复该列默认宽度。剩余空间留在右侧，不会把某一列拉长。",
    items: [
      {
        key: "view.showHiddenLeft",
        type: "toggle",
        title: "左栏显示隐藏文件",
        hint: "仅影响左栏（也可按 Ctrl+H 切换当前栏）",
        default: false,
      },
      {
        key: "view.showHiddenRight",
        type: "toggle",
        title: "右栏显示隐藏文件",
        hint: "仅影响右栏",
        default: false,
      },
      {
        key: "view.defaultSortColumn",
        type: "select",
        title: "新标签页按",
        hint: "新建标签页的默认排序列；已有标签页保持各自的排序不变",
        options: SORT_COLUMNS,
        default: "name",
      },
      {
        key: "view.defaultSortDirection",
        type: "select",
        title: "新标签页排序",
        hint: "新建标签页的默认排序方向",
        options: SORT_DIRECTIONS,
        default: "asc",
      },
    ],
  },
];

// Flat key → row, used to reset to defaults and to normalise incoming values.
const ITEMS = GROUPS.flatMap((g) => g.items);

// Built-in defaults, derived from the schema so GROUPS stays the single source
// of truth — adding an entry with a `default` is enough.
const DEFAULTS = Object.fromEntries(ITEMS.map((i) => [i.key, i.default]));

const props = defineProps({
  // Current values keyed by row `key`. Missing keys fall back to the schema
  // default, so an older saved config still opens cleanly.
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
      if (typeof raw === "boolean") {
        local[item.key] = raw;
      } else if (typeof raw === "string" && item.options?.some((o) => o.key === raw)) {
        local[item.key] = raw;
      } else {
        local[item.key] = DEFAULTS[item.key];
      }
    }
  },
  { immediate: true, deep: true }
);

function setValue(key, val) {
  local[key] = val;
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

/* Label + control on one line; the label keeps its own column width so the
   switches/dropdowns line up across rows of different label lengths. */
.gen-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.row-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
}

.gen-select {
  flex: none;
  min-width: 130px;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: none;
  cursor: pointer;
}

.gen-select:focus {
  border-color: var(--accent);
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
