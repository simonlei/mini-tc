use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_cmd: i32,
    ) -> isize;
}

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
fn is_hidden(name: &str, _path: &Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        if let Ok(metadata) = fs::metadata(_path) {
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
    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
}

/// Return the user's home directory.
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
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

/// Expand `%ENV_VAR%` placeholders inside a path string into their values.
fn expand_env_vars(input: &str) -> String {
    let mut result = String::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;
    while i < len {
        if chars[i] == '%' {
            let mut j = i + 1;
            while j < len && chars[j] != '%' {
                j += 1;
            }
            if j < len {
                let var_name: String = chars[(i + 1)..j].iter().collect();
                if let Ok(v) = std::env::var(&var_name) {
                    result.push_str(&v);
                }
                i = j + 1;
            } else {
                result.push('%');
                i = j + 1;
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

/// Normalize path separators to the platform-native form so that a mixed
/// input like `C:/Users\simon` becomes consistent (`C:\Users\simon` on Windows).
fn normalize_separators(input: &str) -> String {
    #[cfg(windows)]
    {
        input.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        input.to_string()
    }
}

/// Resolve a path that may contain `%ENV_VAR%` placeholders and a leading `~`
/// (home directory) into an absolute path usable by the rest of the app.
#[tauri::command]
fn expand_path(path: String) -> String {
    let expanded = expand_env_vars(&path);

    let resolved = if expanded == "~" {
        home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "~".to_string())
    } else if expanded.starts_with("~/") || expanded.starts_with("~\\") {
        match home_dir() {
            // Join through `PathBuf` so the separator between the home
            // directory and the remainder is always inserted exactly once.
            Some(home) => {
                let rest = expanded[1..].trim_start_matches(|c| c == '/' || c == '\\');
                home.join(rest).to_string_lossy().to_string()
            }
            None => expanded,
        }
    } else {
        expanded
    };

    normalize_separators(&resolved)
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
    pub encoding: String, // "utf-8" for text, "base64" for image
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

    let metadata = fs::metadata(file_path).map_err(|e| format!("Failed to get metadata: {}", e))?;
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
        let content =
            fs::read_to_string(file_path).map_err(|e| format!("Failed to read file: {}", e))?;
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

/// Write debug log to temp file (survives dev restarts).
fn debug_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(std::env::temp_dir().join("mini-tc-debug.log"))
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

/// Open a file or directory using ShellExecuteW (Windows) / xdg-open (Unix).
/// ShellExecuteW is the same API Windows Explorer uses for double-click.
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    debug_log(&format!("open_file called: {}", path));
    let p = Path::new(&path);
    if !p.exists() {
        let msg = format!("Path does not exist: {}", path);
        debug_log(&format!("ERROR: {}", msg));
        return Err(msg);
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        let wide_path: Vec<u16> = std::ffi::OsStr::new(&path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide_verb: Vec<u16> = "open\0".encode_utf16().collect();

        // Set working directory to the file's parent, NOT the project root.
        // This prevents the spawned exe from writing files into the Tauri
        // watched dirs (src-tauri/src etc.) and triggering a dev recompile.
        let wide_dir: Vec<u16> = p
            .parent()
            .map(|d| {
                std::ffi::OsStr::new(d)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect()
            })
            .unwrap_or_default();

        debug_log(&format!(
            "Calling ShellExecuteW, dir={:?}",
            p.parent().map(|d| d.to_string_lossy().to_string())
        ));
        let result = unsafe {
            ShellExecuteW(
                0,
                wide_verb.as_ptr(),
                wide_path.as_ptr(),
                std::ptr::null(),
                if wide_dir.is_empty() {
                    std::ptr::null()
                } else {
                    wide_dir.as_ptr()
                },
                1, // SW_SHOWNORMAL
            )
        };

        // ShellExecuteW returns HINSTANCE > 32 on success, <= 32 on error
        if result as usize <= 32 {
            let msg = format!("ShellExecuteW failed, code={}", result);
            debug_log(&format!("ERROR: {}", msg));
            return Err(msg);
        }
        debug_log("ShellExecuteW succeeded");
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

/// Load persisted video-player config from ~/.minitc/video-config.json.
/// Returns the raw JSON string, or null if no config exists / it can't be read.
#[tauri::command]
fn load_video_config() -> Option<String> {
    let dir = home_dir()?.join(".minitc");
    let path = dir.join("video-config.json");
    fs::read_to_string(path).ok()
}

/// Persist video-player config to ~/.minitc/video-config.json so it is shared
/// across every run of the binary (dev vs bundled) regardless of cwd.
#[tauri::command]
fn save_video_config(config: String) -> Result<(), String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let dir = home.join(".minitc");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("video-config.json");
    fs::write(path, config).map_err(|e| e.to_string())?;
    Ok(())
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
            expand_path,
            join_path,
            read_file_preview,
            get_dir_size,
            delete_to_trash,
            open_file,
            load_video_config,
            save_video_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
