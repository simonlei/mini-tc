import { ref } from "vue";
import { loadConfig, saveConfig } from "./api.js";

// ── View state (show-hidden / column widths / default sort) ──
//
// Everything here is "how the user likes to LOOK at their files", as opposed
// to bookmarks.js (which dirs they care about) or the per-panel tabs-*.json
// (where each tab is pointing). Deliberately a module-level singleton, like
// bookmarks.js, so both panels and App.vue read the same live values without
// prop-drilling or an IPC round-trip per consumer.
//
// Persisted to ~/.minitc/view-state.json through the generic backend config
// commands.
//
// NOT stored here (they already have their own homes, and duplicating them
// would let the two copies drift):
//   • panel split ratio  → ~/.minitc/panel-split.json  (App.vue)
//   • per-tab path/sort  → ~/.minitc/tabs-<id>.json   (FilePanel.vue)
//   • theme / text-preview extensions / video player prefs → their own files

/// Config file name → ~/.minitc/view-state.json
const CONFIG_KEY = "view-state";

/// Resizable columns. `found` is excluded: it's a search-results-only marker
/// column, present in at most one panel at a time, so making it user-resizable
/// would only add a knob nobody has a use for.
export const COLUMN_WIDTHS = ["name", "size", "type", "modified"];

/// Per-column clamp. The lower bound keeps a column readable (an ellipsised
/// "…" tells the user nothing); the upper bound stops a drag from pushing all
/// other columns off-screen.
///
/// `name` is included even though it used to be the flexible `flex: 1` column.
/// It's the column users most want to control (long names get truncated), so
/// it now has a literal width like every other column and the leftover space
/// becomes an empty gutter at the right — the same model Windows Explorer uses.
const COLUMN_LIMITS = {
  name: { min: 80, max: 800, def: 240 },
  size: { min: 50, max: 300, def: 80 },
  type: { min: 40, max: 200, def: 60 },
  modified: { min: 80, max: 300, def: 140 },
};

export const DEFAULT_COLUMN_WIDTHS = Object.fromEntries(
  Object.entries(COLUMN_LIMITS).map(([k, v]) => [k, v.def])
);

/// Sort columns offered in the settings dialog. `found` ("search order") is
/// excluded — it's only meaningful for a search-results pseudo-directory, so
/// it can't be a sensible *default* for an ordinary listing.
export const SORT_COLUMNS = [
  { key: "name", label: "名称" },
  { key: "size", label: "大小" },
  { key: "type", label: "类型" },
  { key: "modified", label: "修改时间" },
];

export const SORT_DIRECTIONS = [
  { key: "asc", label: "升序" },
  { key: "desc", label: "降序" },
];

// ── Live state ──
//
// `showHidden` is per panel (deliberately NOT global): the two panels exist to
// be compared side by side, and "show dotfiles here, hide them there" is a
// legitimate thing to want. Column widths ARE global — a 300px Size column
// means the same thing in both panels, and having them differ would just look
// like a bug.
export const showHidden = ref({ left: false, right: false });
export const columnWidths = ref({ ...DEFAULT_COLUMN_WIDTHS });

// Applied to newly created tabs. Existing tabs keep whatever sort they were
// created with / last clicked (that lives in tabs-<id>.json) — changing this
// must not retroactively re-sort tabs the user has already arranged.
export const defaultSortColumn = ref("name");
export const defaultSortDirection = ref("asc");

// Which panel was showing a preview, and what — so a restart comes back to the
// same view instead of silently dropping the user back to two file lists.
// `kind` mirrors App.vue's previewKind ('file' | 'video' | 'unsupported').
export const previewRestore = ref(null);

/// Guards against the two panels racing to load at startup (both panels mount
/// before App.vue's onMounted in some orders).
let loadPromise = null;

/// Save debounce. Column-width drags fire a change per pointermove, so writes
/// are coalesced; 150ms matches bookmarks.js.
let saveTimer = null;

function clampWidth(key, value) {
  const { min, max, def } = COLUMN_LIMITS[key];
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/// Coerce arbitrary parsed JSON into valid state. A hand-edited or truncated
/// config must never be able to produce e.g. `width: NaN` (which would collapse
/// the column to nothing) or a `sortColumn` the file list doesn't understand.
function sanitize(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    const sh = raw.showHidden;
    if (sh && typeof sh === "object") {
      out.showHidden = { left: sh.left === true, right: sh.right === true };
    }
    const cw = raw.columnWidths;
    if (cw && typeof cw === "object") {
      out.columnWidths = Object.fromEntries(
        COLUMN_WIDTHS.map((k) => [k, clampWidth(k, cw[k])])
      );
    }
    const col = String(raw.defaultSortColumn || "").toLowerCase();
    if (SORT_COLUMNS.some((c) => c.key === col)) out.defaultSortColumn = col;
    const dir = String(raw.defaultSortDirection || "").toLowerCase();
    if (dir === "asc" || dir === "desc") out.defaultSortDirection = dir;
    // Only a preview we can actually re-open is worth restoring: it needs a
    // panel, a path and a kind. Anything else is dropped rather than restored
    // into a broken preview surface. `unsupported` is deliberately excluded —
    // it's just a "no preview for this format" placeholder with nothing to
    // show, so re-opening it on startup would be noise.
    const pv = raw.preview;
    if (pv && typeof pv === "object" && typeof pv.path === "string" && pv.path) {
      const panel = pv.panel === "left" || pv.panel === "right" ? pv.panel : "";
      const kind = ["file", "video"].includes(pv.kind) ? pv.kind : "";
      if (panel && kind) {
        out.preview = {
          panel,
          kind,
          path: pv.path,
          name: typeof pv.name === "string" ? pv.name : "",
          bytes: Number.isFinite(pv.bytes) ? pv.bytes : 0,
          asText: pv.asText === true,
        };
      }
    }
  }
  return out;
}

export async function loadViewState() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await loadConfig(CONFIG_KEY);
      if (raw) {
        const s = sanitize(JSON.parse(raw));
        if (s.showHidden) showHidden.value = s.showHidden;
        if (s.columnWidths) columnWidths.value = s.columnWidths;
        if (s.defaultSortColumn) defaultSortColumn.value = s.defaultSortColumn;
        if (s.defaultSortDirection) defaultSortDirection.value = s.defaultSortDirection;
        if (s.preview) previewRestore.value = s.preview;
      }
    } catch (e) {
      // A corrupt view-state must never block startup — defaults are fine.
      console.error("Failed to load view state:", e);
    }
  })();
  return loadPromise;
}

function persist() {
  saveConfig(
    CONFIG_KEY,
    JSON.stringify({
      showHidden: showHidden.value,
      columnWidths: columnWidths.value,
      defaultSortColumn: defaultSortColumn.value,
      defaultSortDirection: defaultSortDirection.value,
      // `null` (preview closed) is written explicitly so a stale preview from
      // a previous session can never be resurrected by omission.
      preview: previewRestore.value,
    })
  ).catch((e) => console.error("Failed to persist view state:", e));
}

export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 150);
}

/// Apply a whole batch of changes and write once. Used by the settings dialog,
/// where several fields change under a single 确定.
export function applyViewState(next) {
  if (next.showHidden) showHidden.value = { ...next.showHidden };
  if (next.columnWidths) {
    columnWidths.value = Object.fromEntries(
      COLUMN_WIDTHS.map((k) => [k, clampWidth(k, next.columnWidths[k])])
    );
  }
  if (next.defaultSortColumn) defaultSortColumn.value = next.defaultSortColumn;
  if (next.defaultSortDirection) defaultSortDirection.value = next.defaultSortDirection;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  persist();
}

// ── Mutators ──

export function isHiddenShown(panelId) {
  return showHidden.value[panelId] === true;
}

export function setHiddenShown(panelId, value) {
  if (showHidden.value[panelId] === !!value) return;
  showHidden.value = { ...showHidden.value, [panelId]: !!value };
  scheduleSave();
}

export function toggleHidden(panelId) {
  setHiddenShown(panelId, !isHiddenShown(panelId));
}

export function widthOf(key) {
  const w = columnWidths.value[key];
  return Number.isFinite(w) ? w : COLUMN_LIMITS[key].def;
}

/// Set one column's width. Clamped here (not just on load) so a live drag can
/// never push a value out of range, even transiently.
export function setColumnWidth(key, value) {
  const next = clampWidth(key, value);
  if (columnWidths.value[key] === next) return;
  columnWidths.value = { ...columnWidths.value, [key]: next };
  scheduleSave();
}

export function resetColumnWidths() {
  columnWidths.value = { ...DEFAULT_COLUMN_WIDTHS };
  scheduleSave();
}

/// Reset a single column back to its default width (double-click on a grip).
/// Returns false for an unknown key so callers can ignore it.
export function resetColumnWidth(key) {
  if (!(key in COLUMN_LIMITS)) return false;
  setColumnWidth(key, COLUMN_LIMITS[key].def);
  return true;
}

export function setDefaultSort(column, direction) {
  if (column) defaultSortColumn.value = column;
  if (direction) defaultSortDirection.value = direction;
  scheduleSave();
}

// ── Preview persistence ──

/// Record the preview that's currently open (pass null when it closes).
/// Called on every open/close so the state on disk is always "what the user
/// was last looking at".
export function setPreviewRestore(state) {
  previewRestore.value = state || null;
  scheduleSave();
}

/// Consume the stored preview — returns it once and clears it in memory, so a
/// later failed restore (file deleted meanwhile) can't be retried forever, and
/// so the value can't linger and be restored a second time. Clearing here does
/// NOT write to disk: the disk copy stays until the next open/close overwrites
/// it, which keeps a crash between "restored" and "user acted" harmless.
export function consumePreviewRestore() {
  const p = previewRestore.value;
  previewRestore.value = null;
  return p;
}

/// A snapshot for the settings dialog (which edits a local copy so 取消 works).
export function snapshot() {
  return {
    showHidden: { ...showHidden.value },
    columnWidths: { ...columnWidths.value },
    defaultSortColumn: defaultSortColumn.value,
    defaultSortDirection: defaultSortDirection.value,
  };
}