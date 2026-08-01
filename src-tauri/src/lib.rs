use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// A single file/folder entry returned to the frontend.
#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64, // milliseconds since UNIX_EPOCH
    pub extension: String,
    pub is_hidden: bool,
}

/// Convert a system time to milliseconds since UNIX_EPOCH.
fn system_time_to_millis(time: std::io::Result<std::time::SystemTime>) -> i64 {
    match time {
        Ok(t) => t
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// Check whether a file/folder is hidden (Unix dot-file or Windows hidden attribute).
fn is_hidden(name: &str, path: &Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        if let Ok(metadata) = fs::metadata(path) {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
            if metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
                return true;
            }
        }
    }
    false
}

/// List the contents of a directory.
/// Returns `..` as the first entry if the path has a parent.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let entries = fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip entries we can't read
        };
        let file_path = entry.path();
        let metadata = match fs::metadata(&file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();

        let extension = Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_uppercase())
            .unwrap_or_default();

        result.push(FileEntry {
            name,
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified: system_time_to_millis(metadata.modified()),
            extension,
            is_hidden: is_hidden(&entry.file_name().to_string_lossy(), &file_path),
        });
    }

    // Sort: directories first, then by name
    result.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(result)
}

/// Return the user's home directory.
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    home_dir().map(|p| p.to_string_lossy().to_string()).ok_or_else(|| "Could not determine home directory".to_string())
}

fn home_dir() -> Option<PathBuf> {
    // Try USERPROFILE (Windows) or HOME (Unix)
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("USERPROFILE") {
            return Some(PathBuf::from(p));
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(p) = std::env::var("HOME") {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// Get the parent directory of a path. Returns empty string if there is no parent.
#[tauri::command]
fn get_parent_dir(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Ok(parent.to_string_lossy().to_string()),
        _ => Ok(String::new()),
    }
}

/// On Windows, list available drive letters (e.g. "C:\\"). On other platforms, return root "/".
#[tauri::command]
fn list_drives() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let mut drives = Vec::new();
        let letters = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for &letter in letters.iter() {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                drives.push(drive);
            }
        }
        Ok(drives)
    }
    #[cfg(not(windows))]
    {
        Ok(vec!["/".to_string()])
    }
}

/// Check if a path exists.
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Join a directory path with a child name.
#[tauri::command]
fn join_path(parent: String, child: String) -> String {
    Path::new(&parent)
        .join(&child)
        .to_string_lossy()
        .to_string()
}

/// Recursively calculate the total size of a directory.
#[tauri::command]
fn get_dir_size(path: String) -> Result<u64, String> {
    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    dir_size(dir_path).map_err(|e| format!("Failed to calculate directory size: {}", e))
}

fn dir_size(path: &Path) -> Result<u64, std::io::Error> {
    let mut total: u64 = 0;
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                total += dir_size(&entry.path())?;
            } else if file_type.is_symlink() {
                // Skip symlinks to avoid loops
                continue;
            } else {
                total += entry.metadata()?.len();
            }
        }
    }
    Ok(total)
}

/// Preview data returned to the frontend.
#[derive(Serialize)]
pub struct FilePreview {
    pub preview_type: String, // "text" or "image"
    pub content: String,      // text content or data URL
    pub mime_type: String,
    pub size: u64,
    pub encoding: String,     // "utf-8" for text, "base64" for image
}

const TEXT_EXTENSIONS: &[&str] = &["TXT", "MD"];
const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024; // 2 MB

/// Read a text file for preview (txt/md only).
/// Images are loaded directly by the frontend via convertFileSrc (asset protocol).
#[tauri::command]
fn read_file_preview(path: String) -> Result<FilePreview, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if file_path.is_dir() {
        return Err("Cannot preview a directory".to_string());
    }

    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    let size = metadata.len();

    let extension = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .unwrap_or_default();

    if TEXT_EXTENSIONS.contains(&extension.as_str()) {
        if size > MAX_TEXT_SIZE {
            return Err(format!(
                "File too large to preview (max {} MB)",
                MAX_TEXT_SIZE / 1024 / 1024
            ));
        }
        let content = fs::read_to_string(file_path)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        Ok(FilePreview {
            preview_type: "text".to_string(),
            content,
            mime_type: "text/plain".to_string(),
            size,
            encoding: "utf-8".to_string(),
        })
    } else {
        Err(format!(
            "Unsupported file type: .{}",
            extension.to_lowercase()
        ))
    }
}

/// Move a file or directory to the system recycle bin (trash).
#[tauri::command]
fn delete_to_trash(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    trash::delete(p).map_err(|e| format!("Failed to move to trash: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            list_directory,
            get_home_dir,
            get_parent_dir,
            list_drives,
            path_exists,
            join_path,
            read_file_preview,
            get_dir_size,
            delete_to_trash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
