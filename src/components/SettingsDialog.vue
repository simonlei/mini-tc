<template>
  <div class="settings-overlay" @click.self="$emit('close')">
    <div class="settings-dialog">
      <div class="settings-header">
        <span>文件预览设置</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="settings-body">
        <p class="settings-intro">
          按预览方式管理后缀：点已启用的后缀移除，点灰色的内置后缀重新启用。
          同一个后缀只能属于一种预览方式，添加时若已被其它方式占用会给出提示。
        </p>

        <section class="settings-section" v-for="type in types" :key="type.key">
          <div class="section-title">
            <span class="section-name">{{ type.label }}</span>
            <span class="section-count">{{ enabledCount(type.key) }}</span>
            <span class="section-hint">{{ type.hint }}</span>
            <button class="btn-reset-mini" @click="resetType(type.key)" title="恢复该类型的默认后缀">重置</button>
          </div>

          <div class="ext-list">
            <div
              v-for="item in displayList(type.key)"
              :key="item.ext"
              class="ext-chip"
              :class="{ disabled: !item.enabled, builtin: item.builtin }"
              :title="item.enabled ? '点击移除该后缀' : '点击启用该后缀'"
              @click="toggleExt(type.key, item.ext)"
            >
              <span class="ext-name">{{ label(item.ext) }}</span>
              <span v-if="item.builtin" class="ext-tag">内置</span>
              <span class="ext-state">{{ item.enabled ? '×' : '+' }}</span>
            </div>
          </div>

          <div class="ext-add">
            <input
              v-model="inputs[type.key]"
              class="ext-input"
              type="text"
              placeholder="添加后缀（不带点），如 csv"
              @input="errors[type.key] = ''"
              @keydown.enter="onExtInputEnter(type.key, $event)"
            />
            <button class="btn-add" @click="addExt(type.key)">添加</button>
          </div>
          <p class="ext-error" v-if="errors[type.key]">{{ errors[type.key] }}</p>
        </section>
      </div>

      <p class="save-error" v-if="saveError">{{ saveError }}</p>

      <div class="settings-footer">
        <button class="btn-secondary" @click="resetAll">全部恢复默认</button>
        <span class="footer-spacer"></span>
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button class="btn-primary" @click="save">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch } from "vue";
import {
  PREVIEW_TYPES,
  defaultsFor,
  defaultMapping,
  extLabel,
  findConflicts,
  normalizeMapping,
  addExtToType,
  removeExtFromType,
} from "../previewExtensions.js";
import { isImeKeydown } from "../keyboardText.js";

const props = defineProps({
  // The live mapping: { text: [...], image: [...], video: [...], pdf: [...], doc: [...] }
  mapping: { type: Object, required: true },
});
const emit = defineEmits(["close", "save"]);

const types = PREVIEW_TYPES;

// Local editable copy, so 取消 discards everything. Keyed by preview type.
const drafts = reactive({});
const inputs = reactive({});
const errors = reactive({});
const saveError = ref("");

function resetDraft() {
  const clean = normalizeMapping(props.mapping);
  for (const t of types) {
    drafts[t.key] = [...clean[t.key]];
    inputs[t.key] = "";
    errors[t.key] = "";
  }
  saveError.value = "";
}

// The dialog is mounted fresh via v-if on each open. Watching the serialised
// snapshot (rather than the object identity) keeps the draft in sync if the
// store changes underneath us.
watch(() => JSON.stringify(props.mapping), resetDraft, { immediate: true });

function enabledCount(key) {
  return (drafts[key] || []).length;
}

function label(ext) {
  return extLabel(ext);
}

// Visible chips = enabled exts ∪ that type's defaults, so a disabled built-in
// can still be re-enabled. Sorted for a stable layout.
function displayList(key) {
  const enabled = drafts[key] || [];
  const builtin = defaultsFor(key);
  return [...new Set([...enabled, ...builtin])]
    .map((ext) => ({
      ext,
      builtin: builtin.includes(ext),
      enabled: enabled.includes(ext),
    }))
    .sort((a, b) => a.ext.localeCompare(b.ext));
}

function toggleExt(key, ext) {
  errors[key] = "";
  saveError.value = "";
  const enabled = drafts[key] || [];
  const result = enabled.includes(ext)
    ? { mapping: removeExtFromType(drafts, key, ext), error: "" }
    : addExtToType(drafts, key, ext);
  if (result.error) {
    errors[key] = result.error;
    return;
  }
  Object.assign(drafts, result.mapping);
}

function addExt(key) {
  const result = addExtToType(drafts, key, inputs[key] || "");
  if (result.error) {
    errors[key] = result.error;
    return;
  }
  Object.assign(drafts, result.mapping);
  inputs[key] = "";
  errors[key] = "";
  saveError.value = "";
}

// Restore one type to its defaults. Any of those suffixes assigned to another
// type are taken back, so a reset can never leave a duplicate behind.
// Enter inside the suffix box adds the suffix — but NOT while an IME is
// composing (Enter is the "pick this candidate" key then). Do not use Vue's
// `.prevent` modifier here: it would preventDefault() unconditionally and
// swallow the candidate selection.
function onExtInputEnter(key, e) {
  if (isImeKeydown(e)) return;
  e.preventDefault();
  addExt(key);
}

function resetType(key) {
  const wanted = defaultsFor(key);
  const next = {};
  for (const t of types) {
    next[t.key] =
      t.key === key
        ? [...wanted]
        : (drafts[t.key] || []).filter((ext) => !wanted.includes(ext));
  }
  Object.assign(drafts, next);
  inputs[key] = "";
  errors[key] = "";
  saveError.value = "";
}

function resetAll() {
  Object.assign(drafts, defaultMapping());
  for (const t of types) {
    inputs[t.key] = "";
    errors[t.key] = "";
  }
  saveError.value = "";
}

function save() {
  // Last line of defence: the shared rules already refuse cross-type adds,
  // but never emit a snapshot that could give one suffix two renderers.
  const conflicts = findConflicts(drafts);
  if (conflicts.length) {
    saveError.value = `后缀 ${extLabel(conflicts[0].ext)} 同时属于多种预览方式，请先移除重复项`;
    return;
  }
  emit("save", normalizeMapping(drafts));
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
  width: 560px;
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

.settings-intro {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

.settings-section {
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.settings-section:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--text);
}

.section-name {
  font-weight: 600;
}

.section-count {
  font-size: 11px;
  color: var(--accent);
}

.section-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}

.btn-reset-mini {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.btn-reset-mini:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.ext-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.ext-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
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

.btn-add {
  padding: 5px 14px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  border: none;
  background: var(--accent);
  color: #fff;
}

.btn-add:hover {
  opacity: 0.9;
}

.ext-error,
.save-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger);
}

.save-error {
  margin: 0;
  padding: 0 16px 8px;
}

.settings-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.footer-spacer {
  flex: 1;
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
