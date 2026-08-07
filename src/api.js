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

export async function openFile(path) {
  return invoke("open_file", { path });
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
