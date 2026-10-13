import { joinPath } from "./api.js";

// Sentinel prefix marking a tab whose "directory" is really a set of search
// results rather than a real folder on disk.
//
// It deliberately looks like a URI scheme so it can never collide with a
// legitimate Windows path (`minitc://…` is not a valid drive or UNC form),
// and so the failure mode if the check is ever forgotten is a visibly bogus
// path rather than a silent wrong-directory operation.
export const SEARCH_PATH_PREFIX = "minitc://search/";

/// True when `path` is a search-results pseudo-directory.
export function isSearchPath(path) {
  return typeof path === "string" && path.startsWith(SEARCH_PATH_PREFIX);
}

/// Build the pseudo-path for a search-results tab carrying `id`.
export function makeSearchPath(id) {
  return `${SEARCH_PATH_PREFIX}${id}`;
}

/// Absolute path of a listed entry.
///
/// Every `FileEntry` the backend produces carries `path`, so this is normally
/// a plain field read — no IPC round-trip, unlike the `joinPath` call it
/// replaces. The joinPath fallback only matters for entries that predate the
/// field (and keeps this helper total rather than throwing), and joining an
/// absolute path onto a parent is a no-op we can skip outright.
export function entryPath(entry, dirPath) {
  const p = entry && entry.path;
  if (p) return Promise.resolve(p);
  return joinPath(dirPath, (entry && entry.name) || "");
}

/// Parent directory of an absolute path (slash-normalised, no trailing sep).
export function parentDirOf(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "" : norm.slice(0, i);
}

/// Slash-normalised directory for equality comparison, so `C:\a` and
/// `C:/a` compare equal.
export function normDir(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/// Stable identity for a listed entry — the value to key a row by.
///
/// A name is unique *within one directory*, but not within a search-results
/// tab: the same `report.zip` can be listed from ten different folders at
/// once. Vue's keyed diff builds a `key -> index` map and, on duplicates, the
/// later entry overwrites the earlier one — so it reuses nodes shifted by one
/// position. Given [A,B,C,D] becoming [D,A,B,C], row 1 sits where D is but
/// still holds A's per-row state (cached dir size, decoded thumbnail, the
/// inline rename state). Measured, not assumed: see
/// `scripts/row-key-identity-check.mjs`.
///
/// Note what this does *not* cause: the inline rename input does not end up on
/// the wrong file. Its position comes from `renamingIndex`, an index, and given
/// a correctly remapped index both key strategies behave identically. The
/// genuinely mis-targeted rename is a separate defect (an index that is not
/// remapped when the list changes) — tracked on its own.
///
/// Both entry sources (`FileEntry` from `list_directory`, `SearchHit` from the
/// search command) always carry an absolute `path`, and `entries` is always
/// replaced wholesale from a single source — never a merge of two listings —
/// so the path is unique across the rendered list. The `|| name` fallback only
/// covers a hypothetical entry with no path at all, where colliding is still
/// better than rendering nothing.
export function entryKey(entry) {
  return (entry && entry.path) || (entry && entry.name) || "";
}