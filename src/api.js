import { invoke } from "@tauri-apps/api/core";

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

/// Load a named config blob from ~/.minitc/<name>.json.
/// Resolves to the raw JSON string, or null when absent / unreadable.
export async function loadConfig(name) {
  return invoke("load_config", { name });
}

/// Persist a named config blob to ~/.minitc/<name>.json.
export async function saveConfig(name, config) {
  return invoke("save_config", { name, config });
}

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

/// Extract `archive` into `targetDir` using the external tool described by
/// `toolExe` + `syntax` (from `getArchiveTools`). `mode` is "here" (extract
/// into targetDir) or "to_folder" (extract into a new sub-folder named after
/// the archive). Resolves to `{ success, message }`.
export async function extractArchive(archive, targetDir, toolExe, syntax, mode) {
  return invoke("extract_archive", {
    archive,
    targetDir,
    toolExe,
    syntax,
    mode,
  });
}

/// Add the given `sources` (files / directories) into a single archive named
/// `archiveName` inside `baseDir`, using the external tool `toolExe` + `syntax`
/// (from `getArchiveTools`). Only CLI tools (syntax "7z-cli" / "7z" / "winrar")
/// are valid here.
export async function addToArchive(sources, baseDir, archiveName, toolExe, syntax) {
  return invoke("add_to_archive", {
    sources,
    baseDir,
    archiveName,
    toolExe,
    syntax,
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
