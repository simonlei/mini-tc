import { invoke } from "@tauri-apps/api/core";
import { createConfigWriter } from "./configWriter.js";

export async function listDirectory(path) {
  return invoke("list_directory", { path });
}

export async function getHomeDir() {
  return invoke("get_home_dir");
}

export async function getParentDir(path) {
  return invoke("get_parent_dir", { path });
}

export async function listDrives() {
  return invoke("list_drives");
}

export async function pathExists(path) {
  return invoke("path_exists", { path });
}

export async function expandPath(path) {
  return invoke("expand_path", { path });
}

export async function joinPath(parent, child) {
  return invoke("join_path", { parent, child });
}

// `asText = true` forces the backend to read the file as plain text even when
// its extension isn't a built-in text type (used for user-added "preview as
// text" extensions persisted in ~/.minitc/text-preview-extensions.json).
export async function readFilePreview(path, asText = false) {
  return invoke("read_file_preview", { path, asText });
}

export async function getDirSize(path) {
  return invoke("get_dir_size", { path });
}

export async function deleteToTrash(path) {
  return invoke("delete_to_trash", { path });
}

// ── Undo delete ──
//
// `trash::delete()` is one-way — it hands back nothing identifying what it
// put in the bin, while restoring needs the `TrashItem`s. So the backend
// brackets the whole delete loop: `beginTrashDelete` snapshots the bin,
// `commitTrashDelete` diffs it and records ONE undoable batch (N files
// deleted = one Ctrl+Z, not N).
//
// Bracketing is per BATCH, not per file: a snapshot costs a full
// enumeration of the recycle bin, so it must not run once per file.
export async function beginTrashDelete() {
  return invoke("begin_trash_delete");
}

export async function commitTrashDelete(before, deleted) {
  return invoke("commit_trash_delete", { before, deleted });
}

/// Inspect the pending undo WITHOUT consuming it — `{ available, items }`,
/// where each item is `{ path, name, conflict }` and `conflict` means the
/// original path is occupied again. The conflict decision needs user input,
/// and the batch must still be there when they answer.
export async function undoTrashPeek() {
  return invoke("undo_trash_peek");
}

/// Restore the most recent recycle-bin batch. `renames` maps an item's
/// original absolute path to the name to restore it under (used for the
/// "原位置已被占用 → 改名恢复" choice). Resolves to
/// `{ restored: string[], skipped: string[], errors: string[] }` — `skipped`
/// means the item stayed in the bin; it is never overwritten.
export async function undoTrashDelete(renames = {}) {
  return invoke("undo_trash_delete", { renames });
}

/// Delete a file or directory outright — no recycle bin, unrecoverable.
/// Directories are removed recursively. Rejects with a `DeleteError`
/// ({ kind, message }); `kind` is "permission_denied" when the caller should
/// offer the elevated (`deleteWithAdmin`) retry.
export async function deletePermanently(path) {
  return invoke("delete_permanently", { path });
}

/// Delete a path with administrator privileges (Windows only). Uses an
/// elevated PowerShell (ShellExecuteW "runas") to run Remove-Item -Recurse
/// -Force, bypassing the recycle bin. Returns immediately after the elevated
/// process is launched — the frontend should delay-refresh to pick up the
/// result. Rejects with a string message on failure (e.g. user declined UAC).
export async function deleteWithAdmin(path) {
  return invoke("delete_with_admin", { path });
}

/// Report whether the context menu should offer "以管理员身份运行" for
/// `path`. Resolved by the backend from the extension plus a cheap content
/// sniff (PE signature / script has a command) — deliberately NOT via the
/// registry's file associations, which would flag every document whose class
/// happens to register a `runas` verb. Always false off Windows.
export async function isExecutable(path) {
  return invoke("is_executable", { path });
}

/// Launch `path` with administrator privileges (Windows only); the OS shows
/// the UAC prompt. Resolves as soon as the elevated process has started — it
/// does not wait for it, so nothing needs refreshing afterwards. `.bat`/`.cmd`
/// go through `cmd /c`, `.ps1` through PowerShell, `.msi`/`.msp` through
/// msiexec, everything else is launched directly.
///
/// Rejects with a message when the user dismisses the UAC dialog
/// ("已取消管理员权限请求") — callers should treat that as a no-op rather
/// than an error.
export async function runAsAdmin(path) {
  return invoke("run_as_admin", { path });
}

// Rename a file or directory. `oldPath` is the full source path; `newName` is
// the bare new file name (no directory component).
export async function renameFile(oldPath, newName) {
  return invoke("rename_file", { oldPath, newName });
}

export async function openFile(path) {
  return invoke("open_file", { path });
}

/// Create an empty directory at `path` (one level only; refuses to overwrite
/// an existing path). Used by the context-menu "新建目录" action.
export async function createDirectory(path) {
  return invoke("create_directory", { path });
}

/// Copy the given source paths into destDir.
/// `overwrite` = true replaces same-named destinations; false skips them.
/// Resolves to { errors: string[], skipped: number } (never throws for
/// conflicts — real IO failures still surface in `errors`).
export async function copyItems(sources, destDir, overwrite = false) {
  return invoke("copy_items", { sources, destDir, overwrite });
}

/// Move (cut) the given source paths into destDir.
/// `overwrite` = true replaces same-named destinations; false skips them.
/// Resolves to { errors: string[], skipped: number }.
export async function moveItems(sources, destDir, overwrite = false) {
  return invoke("move_items", { sources, destDir, overwrite });
}

/// Kick off a recursive file search (Total Commander's Alt+F7).
///
/// `options` is `{ root, pattern, content, caseSensitive, includeHidden,
/// maxResults }`. The command only spawns the worker thread and returns;
/// results stream back as `search-batch` events and the scan ends with
/// `search-done`. Both carry the `id` passed here, so a stale scan's events
/// can be told apart from the current one.
/// `pattern` follows TC syntax: `;`-separated, `*`/`?` wildcards, a bare word
/// means "name contains", empty matches everything.
export async function startSearch(id, options) {
  return invoke("start_search", { id, options });
}

/// Ask the running search to stop at its next checkpoint.
export async function cancelSearch() {
  return invoke("cancel_search");
}

// ── Duplicate file finder ──

/// Start a duplicate scan over `options.root`. Only spawns the worker and
/// returns; the result arrives as ONE `dedup-done` event (there is no partial
/// result — a half-built cluster set would be misleading). `id` is echoed back
/// on every event so a stale scan's payload can be told apart from the current
/// one.
///
/// `options` is `{ root, recursive, includeHidden, includeEmpty }`.
/// Files are compared by CONTENT, not by name. 0-byte files are excluded
/// unless `includeEmpty`: a folder full of empty files is not a folder full of
/// copies.
export async function startDedup(id, options) {
  return invoke("start_dedup", { id, options });
}

/// Ask the scan with this id to stop at its next checkpoint.
export async function cancelDedup(id) {
  return invoke("cancel_dedup", { id });
}

/// Move the confirmed duplicates to the recycle bin as ONE undoable batch.
///
/// `items` are `{ path, size, modified }` triples as observed at SCAN time. The
/// backend re-stats each one and skips any whose size or mtime has changed
/// since — deleting a file we never compared is not a de-duplication, it is data
/// loss. Resolves to `{ deleted: string[], changed: string[], failed: string[] }`
/// — nothing is thrown for an individual failure; report all three lists.
export async function dedupDelete(items) {
  return invoke("dedup_delete", { items });
}

/// Load a named config blob from ~/.minitc/<name>.json.
/// Resolves to the raw JSON string, or null when absent / unreadable.
///
/// Deliberately one IPC per config, issued in parallel by the boot code. An
/// earlier version batched all of ~/.minitc into a single `load_configs` call
/// and had every `loadConfig` await it — which sounded like a clear win (9
/// round-trips → 1) and measured as the opposite. Boot log: the batch call
/// took 57 ms, while the parallel single-file calls it was meant to replace
/// took ~14 ms each. The config payload is ~4 KB total, so the cost was never
/// I/O — it was the round-trip itself, and serializing nine of them behind one
/// barrier made the slowest thing on the page. At this scale, parallel-and-
/// independent beats batched-and-gated.
export async function loadConfig(name) {
  return invoke("load_config", { name });
}

/// Persist a named config blob to ~/.minitc/<name>.json.
///
/// Writes to the same name are issued strictly in call order, so the newest
/// state is always the one that survives. The backend publishes atomically
/// (temp file + rename), which is what stops a reader or a crash from ever
/// seeing a half-written file — see `configWriter.js` for why these two halves
/// are fixed in different places.
export const saveConfig = createConfigWriter((name, config) =>
  invoke("save_config", { name, config })
);

/// Write the given paths onto the OS clipboard as a file list.
/// `cut = true` marks them for a move (File Explorer moves rather than copies).
export async function setClipboardFiles(paths, cut = false) {
  return invoke("set_clipboard_files", { paths, cut });
}

/// Read file paths from the OS clipboard (CF_HDROP or its text fallback).
/// Resolves to `{ paths: string[], cut: boolean }` or `null` when empty.
export async function getClipboardFiles() {
  return invoke("get_clipboard_files");
}

/// Consume the current system clipboard (called after a cut-paste so it isn't
/// re-pasted). On Windows this empties the clipboard; other platforms no-op.
export async function clearClipboard() {
  return invoke("clear_clipboard");
}

/// Discover external archive-extraction tools installed on the host
/// (7-Zip / WinRAR / unzip). Resolves to an array of
/// `{ id, name, exe, syntax }`; empty when none are found.
export async function getArchiveTools() {
  return invoke("get_archive_tools");
}

/// Extract `archive` into `targetDir` using the external tool identified by
/// `toolId` (an `id` previously returned by `getArchiveTools`). `mode` is
/// "here" (extract into targetDir) or "to_folder" (extract into a new
/// sub-folder named after the archive). Resolves to `{ success, message }`.
///
/// Note the tool is named by id only: the backend resolves the executable from
/// its own discovery table and refuses anything else, so a compromised webview
/// cannot make it run an arbitrary program.
/// `wait` only affects GUI tools: when true the call blocks until the tool's
/// window closes (bounded), so a batch of archives can be extracted strictly
/// one after another instead of stacking every dialog at once. CLI tools
/// always run to completion.
export async function extractArchive(archive, targetDir, toolId, mode, wait = false) {
  return invoke("extract_archive", {
    archive,
    targetDir,
    toolId,
    mode,
    wait,
  });
}

/// Add the given `sources` (files / directories) into a single archive named
/// `archiveName` inside `baseDir`, using the external tool `toolId` (from
/// `getArchiveTools`). Only CLI tools (syntax "7z-cli" / "7z" / "winrar")
/// are valid here.
export async function addToArchive(sources, baseDir, archiveName, toolId) {
  return invoke("add_to_archive", {
    sources,
    baseDir,
    archiveName,
    toolId,
  });
}

/// Start a native OS drag-out operation: hand the given absolute file paths to
/// drag-rs, which writes a real CF_HDROP (Windows) / NSFilenamesPboardType
/// (macOS) so Explorer / Finder / QQ / 7-Zip etc. can receive them as files
/// (not text). `mode` is "move" (DROPEFFECT_MOVE — recipient moves the file)
/// or "copy" (DROPEFFECT_COPY). When the drop completes, `startDrag`
/// resolves with the drop outcome.
///
/// The `image` argument drag-rs requires is intentionally an INVALID PNG,
/// smuggled through the only string form the plugin accepts: a
/// "data:image/png;base64," data URI (the Rust side's Base64Image deserializer
/// rejects anything else, and non-strings fail IPC deserialization entirely).
/// The payload here is a single 0x00 byte ("AA==") — valid base64, but not a
/// decodable PNG. On Windows, drag-rs's `get_drag_image` returns None for an
/// undecodable buffer, which skips the `IDragSourceHelper::InitializeFromBitmap`
/// call entirely. Without that call, the OS auto-renders file icons from the
/// CF_HDROP itself (the same way Explorer behaves when dragging files out of
/// it: multiple files show a "multi-file" thumbnail + count, single files show
/// the source file's icon). If we passed a real icon, drag-rs would override
/// that with our custom bitmap and the OS default would never show.
const DRAG_INVALID_IMAGE = "data:image/png;base64,AA==";
export async function startNativeDrag({ paths, mode = "move" } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  // Dynamic import keeps the bundle cheap if the host hasn't installed the
  // plugin yet (e.g. dev.bat started before `npm install` ran).
  const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
  await startDrag({
    item: paths,
    icon: DRAG_INVALID_IMAGE,
    mode,
  });
}
