<template>
  <div class="kc-overlay" @click.self="$emit('close')">
    <div class="kc-dialog">
      <div class="kc-header">
        <span>快捷键设置</span>
        <button class="close-btn" @click="$emit('close')" title="关闭">✕</button>
      </div>

      <div class="kc-toolbar">
        <div class="kc-search">
          <span class="kc-search-icon">🔍</span>
          <input
            v-model="query"
            class="kc-search-input"
            type="text"
            placeholder="搜索命令名称或快捷键，如「粘贴」/ Ctrl+V"
            spellcheck="false"
          />
          <button v-if="query" class="kc-search-clear" @click="query = ''" title="清空">×</button>
        </div>
        <button class="btn-reset" @click="resetAll" title="所有快捷键恢复为内置默认值">全部恢复默认</button>
      </div>

      <div class="kc-warn" v-if="conflictCount">
        ⚠ 检测到 {{ conflictCount }} 处快捷键冲突（同一作用域内重复），冲突项已用红色标出
      </div>
      <div class="kc-msg" v-if="msg">{{ msg }}</div>

      <div class="kc-body">
        <section v-for="scope in visibleScopes" :key="scope.key" class="kc-scope">
          <div class="kc-scope-head" @click="toggleScope(scope.key)">
            <span class="kc-caret">{{ isCollapsed(scope.key) ? "▸" : "▾" }}</span>
            <span class="kc-scope-name">{{ scope.label }}</span>
            <span class="kc-scope-count">{{ filtered[scope.key].length }}</span>
            <span class="kc-scope-hint">{{ scope.hint }}</span>
          </div>

          <div v-if="!isCollapsed(scope.key)" class="kc-rows">
            <div
              v-for="cmd in filtered[scope.key]"
              :key="cmd.id"
              class="kc-row"
              :class="{ 'kc-row-conflict': errorsOf(cmd.id).length > 0, 'kc-row-recording': recording.id === cmd.id }"
            >
              <div class="kc-row-main">
                <div class="kc-labels">
                  <span class="kc-name">{{ cmd.label }}</span>
                  <span class="kc-desc" v-if="cmd.desc">{{ cmd.desc }}</span>
                </div>

                <div class="kc-keys">
                  <!-- Clicking a chip re-records it IN PLACE; only the × removes it. -->
                  <span
                    v-for="(combo, i) in draft[cmd.id]"
                    :key="i"
                    class="kc-chip"
                    :class="{
                      'kc-chip-bad': comboHasError(cmd.id, combo),
                      'kc-chip-editing': recording.id === cmd.id && recording.index === i,
                    }"
                    :title="`点击重新录制 ${displayCombo(combo)}`"
                    @click="startRecord(cmd.id, i)"
                  >
                    {{ displayCombo(combo) }}
                    <button class="kc-chip-x" @click.stop="removeBinding(cmd.id, combo)" title="移除该快捷键">×</button>
                  </span>
                  <span v-if="!draft[cmd.id] || !draft[cmd.id].length" class="kc-none">未绑定</span>

                  <button
                    v-if="recording.id !== cmd.id"
                    class="kc-add"
                    @click="startRecord(cmd.id, null)"
                    title="添加一个快捷键"
                  >+</button>
                  <span v-else class="kc-recording" :ref="setRecorder" tabindex="-1">{{ recordingPrompt }}</span>

                  <button
                    v-if="isModified(cmd.id)"
                    class="kc-undo"
                    @click="resetCmd(cmd.id)"
                    title="恢复为默认快捷键"
                  >↺</button>
                </div>
              </div>

              <div class="kc-error" v-for="(c, i) in errorsOf(cmd.id)" :key="'e' + i">
                冲突：{{ displayCombo(c.combo) }} 已被「{{ commandLabels(c.others) }}」使用
              </div>
              <div class="kc-hint" v-for="(c, i) in hintsOf(cmd.id)" :key="'h' + i">
                提示：{{ displayCombo(c.combo) }} 也被「{{ commandLabels(c.others) }}」使用；作用域更具体的命令优先生效，本命令在其作用域内不会触发
              </div>
            </div>
          </div>
        </section>

        <div v-if="!visibleScopes.length" class="kc-empty">没有匹配的命令</div>
      </div>

      <div class="kc-footer">
        <span class="kc-footer-hint">支持 Ctrl / Alt / Shift / {{ metaLabel }} 任意组合，一个命令可绑定多个快捷键</span>
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button class="btn-primary" @click="save">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  COMMAND_MAP,
  COMMANDS,
  META_LABEL,
  SCOPES,
  applyBindingTo,
  bindingsOf,
  commandLabels,
  computeConflicts,
  displayCombo,
  eventCombo,
  filterCommands,
  setBindings,
  shortcutsEditing,
} from "../shortcuts.js";

const metaLabel = META_LABEL;

const emit = defineEmits(["close", "save"]);

// ── Draft state ──
// Editable copy of every command's bindings. Only written back to the store
// (and persisted) when the user presses 确定, so 取消 discards everything.
const draft = ref({});
const query = ref("");
const msg = ref("");
const collapsed = ref({});
// Which row is capturing a keystroke. `index === null` means "append a new
// binding"; a number means "re-record the chip at that position in place".
const recording = ref({ id: null, index: null });
const recordingPrompt = computed(() =>
  recording.value.index === null
    ? "请按下快捷键…（Esc 取消）"
    : "请按下新的快捷键…（Esc 保留原值）"
);
let recorderEl = null;

function setRecorder(el) {
  recorderEl = el;
}

function initDraft() {
  const next = {};
  for (const c of COMMANDS) next[c.id] = [...bindingsOf(c.id)];
  draft.value = next;
  query.value = "";
  msg.value = "";
  stopRecord();
}

// Seed the draft synchronously during setup — NOT in onMounted. The first
// render happens before onMounted, so seeding there would paint every row as
// "未绑定" for one frame (and leaves the whole dialog dependent on mount
// timing before any binding is visible).
initDraft();

// Suppress every app shortcut while the dialog is open so recorded keys (and
// plain typing) never fire a command in the background. Raised in setup so it
// is exactly symmetric with onBeforeUnmount — mounting must never be able to
// fail halfway and leave the flag stuck on, which would silently kill every
// shortcut in the app.
shortcutsEditing.value = true;

onMounted(() => {
  document.addEventListener("keydown", onDialogKeydown, true);
});

onBeforeUnmount(() => {
  shortcutsEditing.value = false;
  document.removeEventListener("keydown", onDialogKeydown, true);
  document.removeEventListener("keydown", onRecordKeydown, true);
});

// Esc closes the dialog (while recording, the recorder owns Esc instead).
function onDialogKeydown(e) {
  if (recording.value.id) return;
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
  }
}

// ── Filtering & grouping ──

const filtered = computed(() => filterCommands(query.value, (id) => draft.value[id] || []));

const visibleScopes = computed(() => SCOPES.filter((s) => filtered.value[s.key].length > 0));

function isCollapsed(key) {
  // Searching always expands everything, otherwise the matches would be hidden.
  if (query.value.trim()) return false;
  return !!collapsed.value[key];
}

function toggleScope(key) {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
}

// ── Conflicts (computed from the draft, not the live store) ──

const conflicts = computed(() => computeConflicts((id) => draft.value[id] || []));

const conflictCount = computed(() => {
  let n = 0;
  for (const entry of conflicts.value.values()) n += entry.errors.length;
  return n;
});

function entryOf(id) {
  return conflicts.value.get(id) || { errors: [], hints: [] };
}
function errorsOf(id) {
  return entryOf(id).errors;
}
function hintsOf(id) {
  return entryOf(id).hints;
}
function comboHasError(id, combo) {
  return errorsOf(id).some((c) => c.combo === combo);
}

// ── Editing ──

// Whether the DRAFT differs from the built-in defaults (drives the ↺ button).
function isModified(id) {
  const cur = draft.value[id] || [];
  const def = COMMAND_MAP[id]?.defaults || [];
  return cur.length !== def.length || cur.some((c, i) => c !== def[i]);
}

// `index === null` → append; otherwise overwrite the chip at that position
// (clicking an existing chip re-records it in place).
function applyBinding(id, combo, index) {
  const { list, duplicate } = applyBindingTo(draft.value[id], combo, index);
  if (duplicate) {
    msg.value = `「${displayCombo(combo)}」已经绑定在「${labelOf(id)}」上了`;
    return;
  }
  draft.value = { ...draft.value, [id]: list };
  msg.value = "";
}

function removeBinding(id, combo) {
  draft.value = { ...draft.value, [id]: (draft.value[id] || []).filter((c) => c !== combo) };
  msg.value = "";
}

function resetCmd(id) {
  draft.value = { ...draft.value, [id]: [...(COMMAND_MAP[id]?.defaults || [])] };
  msg.value = "";
}

function resetAll() {
  const next = {};
  for (const c of COMMANDS) next[c.id] = [...c.defaults];
  draft.value = next;
  stopRecord();
  msg.value = "";
}

function labelOf(id) {
  return COMMANDS.find((c) => c.id === id)?.label || id;
}

// ── Key recording ──
// A capture-phase document listener guarantees we see the keystroke first
// (before any app handler and before Vue's own dialog shortcuts).

function startRecord(id, index = null) {
  stopRecord();
  recording.value = { id, index };
  msg.value = "";
  document.addEventListener("keydown", onRecordKeydown, true);
  nextTick(() => recorderEl?.focus?.());
}

function stopRecord() {
  if (recording.value.id === null) return;
  recording.value = { id: null, index: null };
  document.removeEventListener("keydown", onRecordKeydown, true);
}

function onRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;

  // Bare Esc cancels the recording instead of being bound.
  if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    stopRecord();
    return;
  }
  const combo = eventCombo(e);
  if (!combo) return; // modifier-only press → keep waiting for a real key
  const { id, index } = recording.value;
  if (!id) return;
  stopRecord();
  applyBinding(id, combo, index);
}

// ── Commit ──

function save() {
  for (const c of COMMANDS) setBindings(c.id, draft.value[c.id] || []);
  stopRecord();
  emit("save");
}
</script>

<style scoped>
.kc-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 250;
}

.kc-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 760px;
  max-width: 94vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.kc-header {
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

/* ── Toolbar ── */

.kc-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.kc-search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
}

.kc-search:focus-within {
  border-color: var(--accent);
}

.kc-search-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.kc-search-input {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text);
  outline: none;
}

.kc-search-clear {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}

.kc-search-clear:hover {
  color: var(--danger);
}

.btn-reset {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.btn-reset:hover {
  background: var(--hover-bg);
}

/* ── Banners ── */

.kc-warn {
  padding: 7px 16px;
  font-size: 12px;
  color: #ffd7d7;
  background: rgba(192, 57, 43, 0.22);
  border-bottom: 1px solid rgba(192, 57, 43, 0.5);
}

.kc-msg {
  padding: 7px 16px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--hover-bg);
  border-bottom: 1px solid var(--border);
}

/* ── Body ── */

.kc-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 8px;
}

.kc-scope {
  margin-top: 4px;
}

.kc-scope-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: var(--header-bg);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  position: sticky;
  top: 0;
  z-index: 1;
}

.kc-caret {
  width: 10px;
  font-size: 10px;
  color: var(--text-dim);
}

.kc-scope-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.kc-scope-count {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: #fff;
}

.kc-scope-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

.kc-row {
  padding: 7px 16px 7px 32px;
  border-bottom: 1px solid var(--border);
}

.kc-row:hover {
  background: var(--row-hover);
}

.kc-row-conflict {
  background: rgba(192, 57, 43, 0.12);
}

.kc-row-recording {
  background: var(--accent-dim);
}

.kc-row-main {
  display: flex;
  align-items: center;
  gap: 12px;
}

.kc-labels {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.kc-name {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
}

.kc-desc {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kc-keys {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.kc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-size: 11px;
  font-family: "Cascadia Code", "Consolas", monospace;
  white-space: nowrap;
  /* Clicking the chip body re-records it in place (only × removes it). */
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.kc-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.kc-chip-bad {
  border-color: var(--danger);
  color: var(--danger);
}

.kc-chip-bad:hover {
  border-color: var(--danger);
  color: var(--danger);
}

/* The chip currently being re-recorded. */
.kc-chip-editing {
  border-style: dashed;
  border-color: var(--accent);
  color: var(--accent);
}

.kc-chip-x {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 2px;
}

.kc-chip-x:hover {
  background: var(--danger);
  color: #fff;
}

.kc-none {
  font-size: 11px;
  color: var(--text-muted, var(--text-dim));
  padding: 0 4px;
}

.kc-add,
.kc-undo {
  min-width: 22px;
  height: 20px;
  padding: 0 5px;
  border: 1px dashed var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.kc-add:hover,
.kc-undo:hover {
  border-color: var(--accent);
  border-style: solid;
  color: var(--accent);
}

.kc-recording {
  padding: 2px 8px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  white-space: nowrap;
  outline: none;
}

.kc-error {
  margin-top: 4px;
  font-size: 11px;
  color: var(--danger);
}

.kc-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}

.kc-empty {
  padding: 32px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}

/* ── Footer ── */

.kc-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.kc-footer-hint {
  font-size: 11px;
  color: var(--text-dim);
  margin-right: auto;
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
