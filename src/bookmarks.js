import { ref } from "vue";
import { loadConfig, saveConfig } from "./api.js";
import { normDir } from "./paths.js";

// ── Directory bookmarks (Ctrl+D) ──
//
// A flat, globally shared list of directories the user wants one-click access
// to. Deliberately independent of tabs: a bookmark does NOT occupy a tab (see
// `FilePanel.toggleTabLock` for the per-tab anchor, which is a different
// feature), does NOT belong to either panel, and survives both panels being
// closed. Persisted to ~/.minitc/bookmarks.json through the generic backend
// config commands, so it is shared by both panels for free — they import this
// same module-level store.

/// Config file name → ~/.minitc/bookmarks.json
const CONFIG_KEY = "bookmarks";

/// Hard cap on the stored list. The user can add as many as they like, but a
/// hand-edited or runaway config file must not grow the dropdown without limit
/// (nor the JSON written back on every mutation).
const MAX_BOOKMARKS = 200;

/// The one and only bookmark list, shared by both panels.
export const bookmarks = ref([]);

/// Guards against the two panels racing to load at startup (both call
/// `loadBookmarks` on mount; the second one joins the first's promise).
let loadPromise = null;

/// Save debounce. Mutations happen in bursts (a rename is two writes), and the
/// file is tiny, so coalesce writes within 150 ms.
let saveTimer = null;

let idSeq = 0;

function makeId() {
  idSeq += 1;
  return `bm${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/// Last path segment — the default display name for a bookmark. Falls back to
/// the whole path for a root (`C:\` → `C:\`), where there is nothing to trim.
function leafOf(p) {
  const parts = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.pop() || String(p || "");
}

/// Comparison key for a path: slash-normalised (so `C:\a` == `C:/a`), lowercased
/// (Windows paths are case-insensitive) and without a trailing separator.
function pathKey(p) {
  return normDir(p).toLowerCase();
}

/// Coerce an arbitrary parsed list into valid bookmark records: drop junk
/// entries, fill in a missing id / name, and drop duplicates of the same path
/// (a duplicate in the dropdown is never intentional — clicking it can only go
/// to one place). Returns a NEW array; the caller's object is never mutated.
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const path = typeof raw.path === "string" ? raw.path.trim() : "";
    if (!path) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    out.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : makeId(),
      name: name || leafOf(path),
      path,
      addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

export async function loadBookmarks() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await loadConfig(CONFIG_KEY);
      if (raw) bookmarks.value = sanitize(JSON.parse(raw));
    } catch (e) {
      // A corrupt bookmarks file must never block startup — the app is still
      // perfectly usable without bookmarks, so fall back to an empty list.
      console.error("Failed to load bookmarks:", e);
      bookmarks.value = [];
    }
  })();
  return loadPromise;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveConfig(CONFIG_KEY, JSON.stringify(bookmarks.value)).catch((e) => {
      console.error("Failed to persist bookmarks:", e);
    });
  }, 150);
}

/// The bookmark pointing at `path`, or null.
export function findBookmark(path) {
  const key = pathKey(path);
  return bookmarks.value.find((b) => pathKey(b.path) === key) || null;
}

export function isBookmarked(path) {
  return !!findBookmark(path);
}

/// Append a bookmark for `path`. Refuses a duplicate of the same path — the
/// caller uses that to implement Ctrl+D as a toggle.
/// Returns `{ ok, bookmark }` or `{ ok: false, reason, bookmark }`.
export function addBookmark(path, name) {
  const p = String(path || "").trim();
  if (!p) return { ok: false, reason: "empty" };
  const existing = findBookmark(p);
  if (existing) return { ok: false, reason: "exists", bookmark: existing };
  const bm = {
    id: makeId(),
    name: String(name || "").trim() || leafOf(p),
    path: p,
    addedAt: Date.now(),
  };
  bookmarks.value = [...bookmarks.value, bm];
  scheduleSave();
  return { ok: true, bookmark: bm };
}

/// Remove by id. Returns whether anything was removed.
export function removeBookmark(id) {
  const next = bookmarks.value.filter((b) => b.id !== id);
  if (next.length === bookmarks.value.length) return false;
  bookmarks.value = next;
  scheduleSave();
  return true;
}

/// Rename. An empty / whitespace-only name is rejected (the caller keeps the old
/// name rather than storing a blank row).
export function renameBookmark(id, name) {
  const n = String(name || "").trim();
  if (!n) return { ok: false, reason: "empty" };
  const i = bookmarks.value.findIndex((b) => b.id === id);
  if (i < 0) return { ok: false, reason: "missing" };
  const next = [...bookmarks.value];
  next[i] = { ...next[i], name: n };
  bookmarks.value = next;
  scheduleSave();
  return { ok: true };
}

/// Reorder by `delta` positions (-1 = up, +1 = down), so the user can control
/// which bookmarks sit at the top of the dropdown.
export function moveBookmark(id, delta) {
  const i = bookmarks.value.findIndex((b) => b.id === id);
  if (i < 0) return { ok: false, reason: "missing" };
  const j = i + delta;
  if (j < 0 || j >= bookmarks.value.length) return { ok: false, reason: "edge" };
  const next = [...bookmarks.value];
  const [row] = next.splice(i, 1);
  next.splice(j, 0, row);
  bookmarks.value = next;
  scheduleSave();
  return { ok: true };
}

// ── Dropdown open-state ownership ──
//
// Each panel renders its own bookmark dropdown (it has to be anchored to that
// panel's PathBar), but only one may be open at a time. The owner is tracked
// here so opening one closes the other — otherwise clicking ⭐ in the left panel
// and then in the right panel leaves two dropdowns on screen, each with its own
// outside-click overlay.
export const openMenuOwner = ref(null);

let ownerSeq = 0;

export function claimMenuOwner() {
  ownerSeq += 1;
  openMenuOwner.value = ownerSeq;
  return ownerSeq;
}

export function releaseMenuOwner(token) {
  if (openMenuOwner.value === token) openMenuOwner.value = null;
}