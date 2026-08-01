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

export async function joinPath(parent, child) {
  return invoke("join_path", { parent, child });
}

export async function readFilePreview(path) {
  return invoke("read_file_preview", { path });
}
