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