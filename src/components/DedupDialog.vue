<template>
  <!--
    Duplicate file finder. The backend only ever REPORTS groups; nothing is
    deleted until the user presses 删除所选, and even then each file is
    re-checked against its scan-time size/mtime before it goes to the recycle
    bin (see `dedup_delete`).

    The keeper/delete decisions live in `../dedupRules.js` — pure functions,
    unit-tested — so this file is only rendering plus the event plumbing.
  -->
  <div class="dedup-overlay" @click.self="requestClose">
    <div class="dedup-dialog">
      <div class="dedup-header">
        <span>重复文件</span>
        <span class="header-hint">按内容比对，非文件名</span>
        <button class="close-btn" @click="requestClose" title="关闭">✕</button>
      </div>

      <div class="dedup-form">
        <div class="form-row">
          <label class="form-label">扫描目录</label>
          <input
            v-model="root"
            class="form-input"
            type="text"
            spellcheck="false"
            @keydown.enter.prevent="run"
          />
          <button class="btn-ghost" @click="$emit('use-current-dir')">当前目录</button>
        </div>
        <div class="form-row options-row">
          <label class="opt">
            <input type="checkbox" v-model="recursive" /> 包含子目录
          </label>
          <label class="opt">
            <input type="checkbox" v-model="includeHidden" /> 包含隐藏文件
          </label>
          <span class="spacer"></span>
          <!-- ⚠️ Deliberately NOT `:disabled="hasRun"`. That made the button
               permanently unusable after one scan — the user had to close and
               reopen the dialog to look again. Re-scanning is a normal thing to
               do (the folder changed; you toggled 包含子目录; you just deleted
               files), and `run()` already refuses to start a second scan while
               one is in flight — as does `v-if="!scanning"` swapping this
               button for 停止. Deleting is the state that must block it. -->
          <button v-if="!scanning && !deleting" class="btn-primary" @click="run">
            {{ hasRun ? "重新扫描" : "扫描" }}
          </button>
          <button v-else-if="scanning" class="btn-stop" @click="stop">停止</button>
        </div>
      </div>

      <div class="dedup-status">
        <span v-if="scanning" class="busy">{{ phaseLabel }}…</span>
        <span v-if="deleting" class="busy">正在移入回收站…</span>
        <span v-else-if="scanning">已扫描 {{ scanned.toLocaleString() }} 项</span>
        <span v-if="hasRun && !scanning">找到 {{ groups.length }} 组重复</span>
        <span v-if="summary.redundantCount && !deleting">
          将删除 {{ summary.redundantCount }} 个 · 释放 {{ formatBytes(summary.redundantBytes) }}
        </span>
        <span v-if="elapsed > 0">用时 {{ elapsed.toFixed(1) }}s</span>
        <span v-if="doneInfo?.cancelled" class="warn">已取消</span>
        <span class="spacer"></span>
        <span v-if="scanning && currentDir" class="dim cur-dir" :title="currentDir">
          正在扫描：{{ currentDirShort }}
        </span>
      </div>

      <!-- Delete progress. Trashing a file on Windows is a cross-volume move
           (hundreds of ms each), so a batch of a few hundred takes long enough
           that a bare "删除中…" reads as a hang. The bar advances on FILES
           DELETED, not on files processed: a skipped (changed) or failed file
           never reaches the bin, and a bar that counted them would promise
           deletions that did not happen. -->
      <div v-if="deleting" class="delete-progress">
        <div class="progress-head">
          <span>已移入回收站 {{ deleteProgress.deleted }} / {{ deleteProgress.total }}</span>
          <span v-if="deleteProgress.current" class="dim" :title="deleteProgress.current">
            {{ deleteFileName(deleteProgress.current) }}
          </span>
        </div>
        <div
          class="progress-track"
          role="progressbar"
          :aria-valuenow="deleteProgress.deleted"
          :aria-valuemax="deleteProgress.total"
        >
          <div
            class="progress-fill"
            :style="{ width: deletePercent + '%' }"
          ></div>
        </div>
      </div>

      <p v-if="notice && !error" class="dedup-notice">{{ notice }}</p>
      <p v-if="error" class="dedup-error">{{ error }}</p>
      <ul v-if="scanErrors.length" class="scan-errors">
        <li v-for="(e, i) in scanErrors" :key="i">{{ e }}</li>
      </ul>

      <div class="groups-viewport">
        <!-- ⚠️ The list is hidden while a delete runs even though `groups` is
             only cleared once it FINISHES. Part-way through, some rows are
             already in the bin — showing them invites a second click on files
             that no longer exist, and their checkboxes would still be armed. -->
        <div v-if="groups.length && !deleting" class="group-list">
          <section v-for="(g, gi) in groups" :key="gi" class="group">
            <header class="group-head">
              <span class="group-title">{{ g.files.length }} 个相同文件</span>
              <span class="group-size">每个 {{ formatBytes(g.size) }}</span>
              <span class="spacer"></span>
              <button class="btn-mini" @click="checkGroupAll(gi)">本组全选</button>
            </header>
            <div
              v-for="(f, fi) in g.files"
              :key="f.path"
              class="group-row"
              :class="{ keeper: fi === keeperIndex(gi) }"
            >
              <!-- Keeper: exactly one per group, the copy that SURVIVES. -->
              <label class="cell-keeper" :title="fi === keeperIndex(gi) ? '保留这一份' : '保留这一份（其它转入待删除）'">
                <input
                  type="radio"
                  :name="'keeper-' + gi"
                  :checked="fi === keeperIndex(gi)"
                  @change="setKeeper(gi, fi)"
                />
              </label>
              <!-- Delete: only offered for non-keepers. -->
              <label class="cell-check">
                <input
                  type="checkbox"
                  :checked="isChecked(gi, fi)"
                  :disabled="fi === keeperIndex(gi)"
                  @change="toggleCheck(gi, fi)"
                />
              </label>
              <span class="col-name" :title="f.name">{{ f.name }}</span>
              <span class="col-dir" :title="f.dir">{{ f.dir }}</span>
              <span class="col-time">{{ formatDate(f.modified) }}</span>
              <span v-if="fi === keeperIndex(gi)" class="badge-keep">保留</span>
            </div>
          </section>
        </div>
<div v-else-if="deleting" class="groups-empty">
        <span>正在删除，以下列表已失效…</span>
      </div>
      <div v-else class="groups-empty">
        <span v-if="!hasRun">选择目录后点「扫描」开始查找</span>
        <span v-else>没有找到内容相同的文件</span>
      </div>
      </div>

      <div class="dedup-footer">
        <span class="footer-hint">
          删除的文件进入回收站，可用 Ctrl+Z 一次撤销整批
        </span>
        <button
          class="btn-danger"
          :disabled="!summary.redundantCount || deleting"
          @click="confirmDelete"
        >
          {{ deleting ? "删除中…" : `删除所选${summary.redundantCount ? `（${summary.redundantCount}）` : ""}` }}
        </button>
        <button class="btn-secondary" @click="requestClose">关闭</button>
      </div>
    </div>

    <!-- Second confirmation. The checklist above is the primary confirmation
         (every row individually checkable); this states the totals before
         anything is handed to the backend. `window.confirm` cannot show the
         list, and a bare OK/Cancel would be weaker than what came before. -->
    <div v-if="confirmBox.visible" class="confirm-overlay" @click.self="answerConfirm('cancel')">
      <div class="confirm-box" @click.stop>
        <h3>{{ confirmBox.title }}</h3>
        <p>{{ confirmBox.body }}</p>
        <ul v-if="confirmBox.items.length" class="confirm-list">
          <li v-for="(it, i) in confirmBox.items" :key="i" :title="it">{{ it }}</li>
        </ul>
        <div class="confirm-actions">
          <button class="btn-danger" @click="answerConfirm('ok')">确认删除</button>
          <button class="btn-secondary" @click="answerConfirm('cancel')">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startDedup, cancelDedup, dedupDelete } from "../api.js";
import { formatBytes } from "../format.js";
import {
  defaultKeepers,
  redundantFiles,
  summarize,
  switchKeeper,
  fileChecked,
  toggleChecked,
  checkAllInGroup,
  buildDeletePayload,
  deletePercent as deletePercentRule,
} from "../dedupRules.js";

const props = defineProps({
  // Directory the dialog opens with (the active panel's current path).
  initialPath: { type: String, default: "" },
});

const emit = defineEmits(["close", "use-current-dir", "deleted"]);

const root = ref(props.initialPath);
const recursive = ref(false);
const includeHidden = ref(false);

const groups = ref([]);
const scanning = ref(false);
const hasRun = ref(false);
const scanned = ref(0);
const elapsed = ref(0);
const phase = ref("collect");
const currentDir = ref("");
const doneInfo = ref(null);
const scanErrors = ref([]);
const error = ref("");
const deleting = ref(false);
// Live progress of the confirmed delete. The backend drives it through
// `dedup-delete-progress` because the delete is ONE IPC call (that is what
// keeps the recycle-bin bracket — and therefore one Ctrl+Z for the whole
// batch — intact), so the frontend cannot chunk it and count chunks itself.
const deleteProgress = ref({ processed: 0, total: 0, deleted: 0, current: "" });

// Which file survives each group (index into that group's `files`), and which
// files the user has explicitly opted out of deleting. Both keyed off data, not
// off component state, so they survive a re-scan.
const keepers = ref(new Map());
const checked = ref(new Map());

const summary = computed(() => summarize(groups.value, keepers.value, checked.value));
const redundant = computed(() => redundantFiles(groups.value, keepers.value, checked.value));

const phaseLabel = computed(() => (phase.value === "compare" ? "比对内容" : "扫描中"));

/// Fill fraction of the delete bar. Lives in `dedupRules.js` because it is a
/// judgement about what the number MEANS (deleted, not processed) — not a
/// formatting detail.
const deletePercent = computed(() =>
  deletePercentRule(deleteProgress.value.deleted, deleteProgress.value.total)
);

/// Last one or two path segments of the file being deleted — the full path in
/// the tooltip. Same treatment as the scan's `currentDirShort`.
function deleteFileName(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? "…\\" + parts.slice(-2).join("\\") : path;
}

// Tail of the path being walked — the head is rarely informative and would eat
// the status row. Full path stays in the tooltip.
const currentDirShort = computed(() => {
  const p = currentDir.value;
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 2 ? "…\\" + parts.slice(-2).join("\\") : p;
});

// The parent re-emits `initialPath` when the user hits 「当前目录」.
watch(
  () => props.initialPath,
  (v) => {
    if (v) root.value = v;
  }
);

let dedupId = 0;
let startedAt = 0;
let ticker = null;
let unlistenDone = null;
let unlistenProgress = null;
let unlistenDeleteProgress = null;
let stopFallback = null;

function keeperIndex(gi) {
  const k = keepers.value;
  return k.has(gi) ? k.get(gi) : 0;
}

function isChecked(gi, fi) {
  return fileChecked(groups.value[gi]?.files, keepers.value, checked.value, gi, fi);
}

function setKeeper(gi, fi) {
  keepers.value = switchKeeper(groups.value, keepers.value, checked.value, gi, fi);
}

function toggleCheck(gi, fi) {
  checked.value = toggleChecked(groups.value, keepers.value, checked.value, gi, fi);
}

function checkGroupAll(gi) {
  checked.value = checkAllInGroup(groups.value, gi, keepers.value, checked.value);
}

// ── Backend events ──
//
// 🚨 `listen` hands the callback an *Event wrapper* `{ event, id, payload }`.
// `Event.id` is a GLOBAL event sequence number, so comparing it to our scan id
// would never match and every event would be silently dropped — the dialog
// would spin forever. Always unwrap `.payload` and compare THAT.
function unwrap(event, name) {
  const p = event?.payload;
  if (!p || typeof p !== "object") {
    console.warn(`[dedup] ${name}: event carried no payload`, event);
    return null;
  }
  return p;
}

function onProgress(event) {
  const payload = unwrap(event, "dedup-progress");
  if (!payload || payload.id !== dedupId) return;
  scanned.value = payload.scanned || 0;
  // The backend reports the comparison count as the `phase` string during the
  // compare stage (there is no meaningful path to show there).
  if (payload.phase === "collect") {
    phase.value = "collect";
    currentDir.value = payload.current || "";
  } else {
    phase.value = "compare";
    currentDir.value = "";
  }
}

function onDone(event) {
  const payload = unwrap(event, "dedup-done");
  clearTimeout(stopFallback);
  if (!payload || payload.id !== dedupId) return;
  scanning.value = false;
  phase.value = "collect";
  currentDir.value = "";
  scanned.value = payload.scanned || 0;
  doneInfo.value = payload;
  scanErrors.value = payload.errors || [];
  groups.value = payload.groups || [];
  // Default keeper = newest copy. Any opt-outs from the previous run are
  // dropped: they referred to a different result set.
  keepers.value = defaultKeepers(groups.value);
  checked.value = new Map();
  stopTicker();
  elapsed.value = (Date.now() - startedAt) / 1000;
}

// Delete progress. Unlike the scan events this one carries NO scan id: the
// delete is a separate, single IPC call that cannot overlap with a scan (the
// dialog disables scanning while deleting), so there is nothing to
// disambiguate. It is still ignored unless a delete is actually in flight —
// a stray event must never move the bar of an idle dialog.
function onDeleteProgress(event) {
  const payload = unwrap(event, "dedup-delete-progress");
  if (!payload || !deleting.value) return;
  deleteProgress.value = {
    processed: payload.processed || 0,
    total: payload.total || 0,
    deleted: payload.deleted || 0,
    current: payload.current || "",
  };
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function run() {
  if (scanning.value) return;
  const dir = (root.value || "").trim();
  if (!dir) {
    error.value = "请先指定扫描目录";
    return;
  }
  error.value = "";
  notice.value = "";
  resetResults();
  hasRun.value = true;
  scanning.value = true;
  dedupId += 1;
  startedAt = Date.now();
  ticker = setInterval(() => {
    elapsed.value = (Date.now() - startedAt) / 1000;
  }, 200);
  try {
    await startDedup(dedupId, {
      root: dir,
      recursive: recursive.value,
      includeHidden: includeHidden.value,
      // 0-byte files are excluded by default: a folder full of empty files is
      // not a folder full of copies.
      includeEmpty: false,
    });
  } catch (e) {
    scanning.value = false;
    stopTicker();
    error.value = String(e);
  }
}

async function stop() {
  if (!scanning.value) return;
  await cancelDedup(dedupId).catch(() => {});
  // Safety net: a worker that died without emitting `dedup-done` would leave the
  // dialog spinning forever with no way out.
  clearTimeout(stopFallback);
  stopFallback = setTimeout(() => {
    if (!scanning.value) return;
    scanning.value = false;
    stopTicker();
    error.value = "扫描未正常结束（后端可能已异常退出），详情见诊断日志";
  }, 1500);
}

// ── Deletion ──

/// Outcome of the last delete, shown in the status row.
///
/// Deliberately NOT `error`: that one renders in the danger colour, and
/// "已删除 12 个文件" is a success, not a failure. A failed run puts its
/// message in BOTH — the notice keeps the happy path out of the red styling,
/// and the error line still gets it when something actually went wrong.
const notice = ref("");

/// Clear everything the finished scan produced, so the dialog returns to its
/// pre-scan state and the user can scan again.
///
/// Called after a delete AND after a completed scan (`onDone` resets its own
/// state already, but `run` does too — this is the one place that owns the
/// invariant).
function resetResults() {
  groups.value = [];
  keepers.value = new Map();
  checked.value = new Map();
  hasRun.value = false;
  doneInfo.value = null;
  scanErrors.value = [];
  currentDir.value = "";
  scanned.value = 0;
  elapsed.value = 0;
}

/// Second confirmation, in a dialog of our own rather than `window.confirm`:
/// the summary has to state exactly what is about to disappear. The primary
/// confirmation IS this dialog — every row is individually checkable above.
async function confirmDelete() {
  if (deleting.value) return;
  const doomed = redundant.value;
  if (!doomed.length) return;

  const choice = await askConfirm({
    title: "删除重复文件",
    body: `将把 ${doomed.length} 个文件移入回收站，可释放 ${formatBytes(summary.value.redundantBytes)}。每组保留一份。`,
    items: doomed.slice(0, 8).map((f) => f.path),
  });
  if (choice !== "ok") return;

  deleting.value = true;
  notice.value = "";
  error.value = "";
  deleteProgress.value = { processed: 0, total: doomed.length, deleted: 0, current: "" };
  try {
    const res = await dedupDelete(buildDeletePayload(doomed));
    const parts = [`已删除 ${res.deleted?.length || 0} 个重复文件`];
    // Both of these are reported, never swallowed: a file that changed since
    // the scan was NOT what we compared, and the user needs to know it is still
    // there (a failure the same way).
    if (res.changed?.length) {
      parts.push(`${res.changed.length} 个已变化（内容与扫描时不同）而跳过`);
    }
    if (res.failed?.length) {
      parts.push(`${res.failed.length} 个失败：${res.failed.slice(0, 2).join("；")}`);
    }
    notice.value = parts.join(" · ");
    // Failures also go to the error line — that one is styled as danger, which
    // is what they are. The notice alone would style a failure as a success.
    if (res.failed?.length) error.value = notice.value;
    // The listed duplicates no longer describe the disk: the keepers are still
    // there, the rest are in the bin (or changed, or failed). Leaving the list
    // on screen would invite a second click on rows that are already gone —
    // and "删除所选" would still be armed. Clear it and let the user scan again.
    resetResults();
    emit("deleted", res);
  } catch (e) {
    error.value = `删除失败：${String(e)}`;
  } finally {
    deleting.value = false;
    deleteProgress.value = { processed: 0, total: 0, deleted: 0, current: "" };
  }
}

/// Small in-dialog confirm. `window.confirm` cannot show the file list, and a
/// bare OK/Cancel would be a weaker confirmation than the checklist above.
let confirmResolve = null;
const confirmBox = ref({ visible: false, title: "", body: "", items: [] });

function askConfirm({ title, body, items }) {
  confirmBox.value = { visible: true, title, body, items };
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function answerConfirm(value) {
  confirmBox.value.visible = false;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

function requestClose() {
  // Never close mid-delete: the list is hidden and the result is about to be
  // reported, so closing would silently drop the outcome. Esc lands here too,
  // so say why nothing happened instead of swallowing the key.
  if (deleting.value) {
    notice.value = "正在删除，请稍候…";
    return;
  }
  emit("close");
}

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Esc closes the dialog from anywhere inside it, and the confirm box on top of
// it closes first. Registered on the capture phase so it also wins over
// App.vue's "Esc closes the preview" handler.
function onEscCapture(e) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  if (confirmBox.value.visible) {
    answerConfirm("cancel");
    return;
  }
  requestClose();
}

onMounted(async () => {
  unlistenDone = await listen("dedup-done", onDone);
  unlistenProgress = await listen("dedup-progress", onProgress);
  unlistenDeleteProgress = await listen("dedup-delete-progress", onDeleteProgress);
  document.addEventListener("keydown", onEscCapture, true);
  await nextTick();
});

onBeforeUnmount(() => {
  // A scan still walking the disk when the dialog closes would keep going and
  // push events nobody listens to any more.
  if (scanning.value) cancelDedup(dedupId).catch(() => {});
  stopTicker();
  clearTimeout(stopFallback);
  unlistenDone?.();
  unlistenProgress?.();
  unlistenDeleteProgress?.();
  document.removeEventListener("keydown", onEscCapture, true);
});
</script>

<style scoped>
.dedup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dedup-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 900px;
  max-width: 94vw;
  height: 640px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.dedup-header {
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

.dedup-form {
  padding: 12px 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label {
  width: 68px;
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.form-input {
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

.form-input:focus {
  border-color: var(--accent);
}

.btn-ghost {
  flex: none;
  padding: 5px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.btn-ghost:hover {
  background: var(--hover-bg);
}

.options-row {
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

.spacer {
  flex: 1;
}

.btn-primary {
  flex: none;
  padding: 5px 18px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-stop {
  flex: none;
  padding: 5px 18px;
  border: none;
  border-radius: 4px;
  background: var(--danger);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.dedup-status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}

.dedup-status .busy {
  color: var(--accent);
}

.dedup-status .warn {
  color: var(--danger);
}

.dedup-status .dim {
  opacity: 0.7;
}

.dedup-status .cur-dir {
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dedup-error {
  margin: 6px 16px 0;
  font-size: 12px;
  color: var(--danger);
}

/* A finished delete's summary. Success styling — the failures go to
   `.dedup-error` instead, so a partial failure is not dressed up as one. */
.dedup-notice {
  margin: 6px 16px 0;
  font-size: 12px;
  color: var(--accent);
}

/* ── Delete progress ── */
.delete-progress {
  margin: 8px 16px 0;
}

.progress-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.progress-head .dim {
  min-width: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: Consolas, monospace;
}

.progress-track {
  height: 6px;
  border-radius: 3px;
  background: var(--hover-bg);
  border: 1px solid var(--border);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--danger);
  transition: width 120ms linear;
}

.scan-errors {
  margin: 6px 16px 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--danger);
  max-height: 44px;
  overflow-y: auto;
}

.groups-viewport {
  flex: 1;
  min-height: 0;
  margin: 8px 16px;
  overflow-y: auto;
  overflow-x: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  position: relative;
}

.group-list {
  display: flex;
  flex-direction: column;
}

.group {
  border-bottom: 1px solid var(--border);
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--hover-bg);
  font-size: 12px;
  color: var(--text);
  position: sticky;
  top: 0;
  z-index: 1;
}

.group-title {
  font-weight: 600;
}

.group-size {
  color: var(--text-dim);
}

.btn-mini {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.btn-mini:hover {
  background: var(--panel-bg);
}

.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
}

.group-row:hover {
  background: var(--hover-bg);
}

.group-row.keeper {
  background: rgba(64, 160, 255, 0.12);
}

.cell-keeper,
.cell-check {
  flex: none;
  display: flex;
  align-items: center;
}

.col-name {
  flex: 0 0 24%;
  max-width: 24%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-dim);
}

.col-time {
  flex: none;
  width: 118px;
  text-align: right;
  color: var(--text-dim);
}

.badge-keep {
  flex: none;
  width: 40px;
  text-align: right;
  font-size: 11px;
  color: var(--accent);
}

.groups-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
}

.dedup-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.footer-hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-dim);
}

.btn-danger {
  flex: none;
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background: var(--danger);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.btn-danger:disabled {
  opacity: 0.4;
  cursor: default;
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

/* ── Second confirmation ── */
.confirm-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

.confirm-box {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 18px;
  max-width: 560px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.confirm-box h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--text);
}

.confirm-box p {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-dim);
}

.confirm-list {
  margin: 0 0 12px;
  padding-left: 18px;
  max-height: 150px;
  overflow-y: auto;
  font-size: 11px;
  color: var(--text-dim);
  font-family: Consolas, monospace;
}

.confirm-list li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>