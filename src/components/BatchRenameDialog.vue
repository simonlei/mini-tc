<template>
  <!--
    Batch rename (Ctrl+M). The left column is every selected item's CURRENT
    name, the right column the name the rules produce — recomputed on every
    keystroke, so illegal characters and collisions show up BEFORE anything is
    touched on disk. 「重命名」 stays disabled while any row is in error.
  -->
  <div class="rename-overlay" @click.self="requestClose">
    <div class="rename-dialog">
      <div class="rename-header">
        <span>批量重命名</span>
        <span class="header-hint">Ctrl+M · 共 {{ plan.length }} 项</span>
        <button class="close-btn" @click="requestClose" title="关闭">✕</button>
      </div>

      <div class="rename-body">
        <!-- ── Rule editor ── -->
        <div class="rules" ref="rulesEl">
          <section class="rule-block">
            <div class="rule-title">查找替换</div>
            <label class="rule-row">
              <span class="rule-label">查找</span>
              <input v-model="rules.find" class="rule-input" type="text" spellcheck="false" placeholder="留空 = 不替换" />
            </label>
            <label class="rule-row">
              <span class="rule-label">替换为</span>
              <input v-model="rules.replace" class="rule-input" type="text" spellcheck="false" placeholder="替换后的文字" />
            </label>
            <div class="rule-checks">
              <label class="opt"><input type="checkbox" v-model="rules.useRegex" /> 正则表达式</label>
              <label class="opt"><input type="checkbox" v-model="rules.caseSensitive" /> 区分大小写</label>
            </div>
          </section>

          <section class="rule-block">
            <div class="rule-title">序号</div>
            <label class="rule-row">
              <span class="rule-label">启用</span>
              <input type="checkbox" v-model="rules.numbering" />
            </label>
            <template v-if="rules.numbering">
              <label class="rule-row">
                <span class="rule-label">起始</span>
                <input v-model.number="rules.seqStart" class="rule-input num" type="number" min="0" />
                <span class="rule-label">步长</span>
                <input v-model.number="rules.seqStep" class="rule-input num" type="number" min="1" />
                <span class="rule-label">位数</span>
                <input v-model.number="rules.seqPad" class="rule-input num" type="number" min="0" max="10" />
              </label>
              <label class="rule-row">
                <span class="rule-label">位置</span>
                <select v-model="rules.seqMode" class="rule-input">
                  <option value="append">自动追加（名称_1）</option>
                  <option value="placeholder">使用 [N] 占位符</option>
                </select>
              </label>
              <p class="rule-hint">
                「使用 [N] 占位符」时，把 <code>[N]</code> 写进「替换为 / 前缀 / 后缀」即可放到任意位置。
              </p>
            </template>
          </section>

          <section class="rule-block">
            <div class="rule-title">名称修饰</div>
            <label class="rule-row">
              <span class="rule-label">前缀</span>
              <input v-model="rules.prefix" class="rule-input" type="text" spellcheck="false" placeholder="可含 [N]" />
            </label>
            <label class="rule-row">
              <span class="rule-label">后缀</span>
              <input v-model="rules.suffix" class="rule-input" type="text" spellcheck="false" placeholder="可含 [N]" />
            </label>
            <label class="rule-row">
              <span class="rule-label">大小写</span>
              <select v-model="rules.caseMode" class="rule-input">
                <option v-for="m in CASE_MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
              </select>
            </label>
          </section>

          <section class="rule-block">
            <div class="rule-title">扩展名</div>
            <label class="rule-row">
              <span class="rule-label">处理</span>
              <select v-model="rules.extMode" class="rule-input">
                <option v-for="m in EXT_MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
              </select>
            </label>
            <label v-if="rules.extMode === 'replace'" class="rule-row">
              <span class="rule-label">新扩展名</span>
              <input v-model="rules.newExt" class="rule-input" type="text" spellcheck="false" placeholder="jpg（可带或不带点）" />
            </label>
          </section>

          <div class="rule-actions">
            <button class="btn-ghost" @click="resetRules">恢复默认</button>
          </div>
        </div>

        <!-- ── Preview ── -->
        <div class="preview">
          <div class="preview-head">
            <span class="col-old">当前名称</span>
            <span class="col-arrow">→</span>
            <span class="col-new">新名称</span>
          </div>
          <div class="preview-list">
            <div
              v-for="row in plan"
              :key="row.path + '#' + row.index"
              class="preview-row"
              :class="row.status"
            >
              <span class="col-old" :title="row.name">{{ row.name }}</span>
              <span class="col-arrow">→</span>
              <span class="col-new" :title="row.error || row.newName">
                {{ row.newName }}
                <em v-if="row.status === 'error'" class="row-error">{{ row.error }}</em>
                <em v-else-if="row.status === 'unchanged'" class="row-same">不变</em>
              </span>
            </div>
            <div v-if="!plan.length" class="preview-empty">没有可重命名的项目</div>
          </div>
          <p v-if="result" class="preview-result" :class="result.type">{{ result.text }}</p>
        </div>
      </div>

      <div class="rename-footer">
        <span class="footer-hint" :class="{ bad: summary.errors > 0 }">
          将重命名 {{ summary.ok }} 项<template v-if="summary.unchanged"> · {{ summary.unchanged }} 项不变</template><template v-if="summary.errors"> · {{ summary.errors }} 项有误</template>
        </span>
        <button class="btn-secondary" @click="requestClose">取消</button>
        <button class="btn-primary" :disabled="!canApply" @click="apply">
          重命名{{ summary.ok ? ` (${summary.ok})` : "" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import {
  buildRenamePlan,
  summarizePlan,
  defaultRules,
  CASE_MODES,
  EXT_MODES,
} from "../renameRules.js";
import { runRenamePlan } from "../renameRunner.js";
import { renameFile } from "../api.js";

// `items`: [{ path, name }] in DISPLAY order — the sequence numbers follow this
// order, so the dialog must be handed the list as the user sees it.
// `existing`: Set of lower-cased names already in the target directory, or null
// when unknown (search-results tab).
const props = defineProps({
  items: { type: Array, default: () => [] },
  existing: { type: Set, default: null },
});

const emit = defineEmits(["close", "applied"]);

const rules = reactive(defaultRules());
const rulesEl = ref(null);
const result = ref(null);
const running = ref(false);

const plan = computed(() => buildRenamePlan(props.items, props.existing, rules));
const summary = computed(() => summarizePlan(plan.value));
const canApply = computed(() => !running.value && summary.value.ok > 0 && summary.value.errors === 0);

// A fresh rules object keeps the reset honest: mutating the shared default in
// place would leak one dialog's settings into the next.
function resetRules() {
  Object.assign(rules, defaultRules());
}

async function apply() {
  if (!canApply.value) return;
  running.value = true;
  result.value = null;
  // `renameFile(oldPath, newName)` matches the executor's `move(from, to)`
  // signature exactly — the sequencing (temp names, ordering, rollback) lives
  // in renameRunner, which is pure and unit-tested.
  const res = await runRenamePlan(plan.value, {
    existing: props.existing,
    move: renameFile,
  });
  running.value = false;
  if (res.ok) {
    // Hand back the concrete [oldPath, newName] pairs so the panel can update
    // its listing the right way for its kind of tab (re-list vs patch rows).
    emit("applied", {
      count: res.done.length,
      // `plan.value` is read here, not captured before the await: the rules
      // cannot change mid-run (the inputs are inert while `running`), and
      // reading it after keeps one source of truth for what was planned.
      pairs: plan.value
        .filter((r) => r.status === "ok")
        .map((r) => [r.path, r.newName]),
    });
    emit("close");
    return;
  }
  result.value = {
    type: "error",
    text:
      (res.rolledBack ? "重命名失败，已回滚全部改动。\n" : "重命名中断，部分项目可能未恢复。\n") +
      res.failed.join("\n"),
  };
}

function requestClose() {
  if (running.value) return;
  emit("close");
}

// Esc closes from anywhere inside. Capture phase so it also wins over App.vue's
// "Esc closes the preview" handler while this dialog is on top.
function onEscCapture(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  requestClose();
}

watch(rules, () => {
  // Any rule change invalidates the previous run's report.
  result.value = null;
}, { deep: true });

onMounted(async () => {
  document.addEventListener("keydown", onEscCapture, true);
  await nextTick();
  rulesEl.value?.querySelector("input")?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onEscCapture, true);
});
</script>

<style scoped>
.rename-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.rename-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 880px;
  max-width: 94vw;
  height: 560px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.rename-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.header-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
}

.close-btn {
  margin-left: auto;
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

.rename-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 12px 16px;
}

/* ── Rule editor ── */

.rules {
  flex: 0 0 320px;
  overflow-y: auto;
  padding-right: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rule-block {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px 10px;
}

.rule-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.4px;
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 12px;
  color: var(--text);
}

.rule-label {
  flex: none;
  width: 46px;
  color: var(--text-dim);
}

.rule-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}

.rule-input:focus {
  border-color: var(--accent);
}

.rule-input.num {
  flex: 0 0 52px;
}

.rule-checks {
  display: flex;
  gap: 14px;
  margin-top: 2px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.rule-hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
}

.rule-hint code {
  font-family: Consolas, monospace;
  background: var(--hover-bg);
  padding: 0 3px;
  border-radius: 2px;
}

.rule-actions {
  display: flex;
  gap: 8px;
}

.btn-ghost {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.btn-ghost:hover {
  background: var(--hover-bg);
}

/* ── Preview ── */

.preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.preview-head,
.preview-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.preview-head {
  font-size: 11px;
  color: var(--text-dim);
  padding: 0 8px 6px;
}

.col-old {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-arrow {
  flex: none;
  width: 14px;
  text-align: center;
  opacity: 0.6;
}

.col-new {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
}

.preview-row {
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  cursor: default;
}

.preview-row:last-child {
  border-bottom: none;
}

.preview-row:hover {
  background: var(--hover-bg);
}

/* A row whose new name is illegal (or collides) is the whole point of the
   live preview — mark it loudly rather than only greying out the button. */
.preview-row.error {
  background: rgba(192, 57, 43, 0.16);
  color: var(--danger);
}

.preview-row.error .col-new {
  text-decoration: line-through;
  opacity: 0.75;
}

.preview-row.unchanged {
  color: var(--text-dim);
}

.preview-row.unchanged .col-new {
  opacity: 0.6;
}

.row-error {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: var(--danger);
  white-space: normal;
  text-decoration: none;
  opacity: 1;
}

.row-same {
  font-style: normal;
  font-size: 11px;
  margin-left: 6px;
  opacity: 0.7;
}

.preview-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}

.preview-result {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-line;
  color: var(--danger);
}

.rename-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.footer-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}

.footer-hint.bad {
  color: var(--danger);
}

.btn-secondary {
  flex: none;
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

.btn-primary {
  flex: none;
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
