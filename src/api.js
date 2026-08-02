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

export async function readFilePreview(path) {
  return invoke("read_file_preview", { path });
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
