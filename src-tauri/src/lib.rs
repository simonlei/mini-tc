use serde::Serialize;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::Emitter;

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

/// Payload streamed to the frontend during a copy/move so it can render a
/// progress bar. `copied_bytes` / `total_bytes` drive the bar; `current_name`
/// shows which file is currently being copied.
#[derive(Serialize, Clone)]
pub struct CopyProgress {
    pub current_name: String,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub file_index: usize,
    pub file_total: usize,
}

/// Result of a copy/move operation. `errors` are genuine IO failures;
/// `skipped` counts items left untouched because a same-named destination
/// existed and the user chose NOT to overwrite (the dialog decision).
#[derive(Serialize, Default)]
pub struct CopyResult {
    pub errors: Vec<String>,
    pub skipped: usize,
}

/// Recursively remove a file or directory.
fn remove_recursive(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Walk a single source (file or directory) and append every file (with its
/// destination path and byte size) plus every directory (size 0) to `tasks`.
fn collect_copy_tasks(src: &Path, dest: &Path, tasks: &mut Vec<(PathBuf, PathBuf, u64)>) {
    if src.is_dir() {
        tasks.push((src.to_path_buf(), dest.to_path_buf(), 0));
        if let Ok(entries) = fs::read_dir(src) {
            for entry in entries.flatten() {
                let child_src = entry.path();
                let child_dest = dest.join(entry.file_name());
                collect_copy_tasks(&child_src, &child_dest, tasks);
            }
        }
    } else if src.is_file() {
        let size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        tasks.push((src.to_path_buf(), dest.to_path_buf(), size));
    }
}

/// Emit a progress event for the current copy state.
fn emit_progress(
    app: &tauri::AppHandle,
    name: &str,
    file_index: usize,
    file_total: usize,
    copied_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        "copy-progress",
        CopyProgress {
            current_name: name.to_string(),
            copied_bytes,
            total_bytes,
            file_index,
            file_total,
        },
    );
}

/// Copy a single file in 1 MB chunks, emitting progress roughly every 1% of the
/// overall job size (or at least every chunk for small jobs).
fn copy_file_with_progress(
    app: &tauri::AppHandle,
    src: &Path,
    dest: &Path,
    _file_size: u64,
    copied: &mut u64,
    total_bytes: u64,
    file_index: usize,
    file_total: usize,
) -> io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut reader = fs::File::open(src)?;
    let mut writer = fs::File::create(dest)?;
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MB chunks
    let step = (total_bytes / 100).max(256 * 1024).max(1);
    let mut last_emit = *copied;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        *copied += n as u64;
        if *copied - last_emit >= step {
            last_emit = *copied;
            emit_progress(
                app,
                &src.file_name().unwrap().to_string_lossy(),
                file_index,
                file_total,
                *copied,
                total_bytes,
            );
        }
    }
    writer.flush()?;
    // Final emit so the bar reaches 100% for this file.
    emit_progress(
        app,
        &src.file_name().unwrap().to_string_lossy(),
        file_index,
        file_total,
        *copied,
        total_bytes,
    );
    Ok(())
}

/// Copy all `sources` into `dest_dir`, emitting `copy-progress` events so the
/// frontend can render a progress bar.
///
/// Conflict policy is driven by `overwrite`:
/// - `false`: any destination that already exists is left untouched and counted
///   in `*skipped` (the user chose to skip via the dialog).
/// - `true`: the existing destination is removed first, then replaced.
///
/// Genuine IO failures are returned in the error vector.
fn copy_all(
    app: &tauri::AppHandle,
    sources: &[PathBuf],
    dest_dir: &Path,
    overwrite: bool,
    skipped: &mut usize,
) -> Vec<String> {
    let mut tasks: Vec<(PathBuf, PathBuf, u64)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for src in sources {
        if !src.exists() {
            errors.push(format!("源不存在: {}", src.display()));
            continue;
        }
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                errors.push(format!("无效路径: {}", src.display()));
                continue;
            }
        };
        let dest_item = dest_dir.join(&name);
        if dest_item.exists() {
            if overwrite {
                // Remove the existing target so the copy replaces it.
                if let Err(e) = remove_recursive(&dest_item) {
                    errors.push(format!("无法覆盖 {}: {}", name, e));
                    continue;
                }
            } else {
                *skipped += 1;
                continue;
            }
        }
        collect_copy_tasks(src, &dest_item, &mut tasks);
    }

    let total_bytes: u64 = tasks.iter().map(|t| t.2).sum();
    let file_total = tasks.len();
    let mut copied: u64 = 0;

    for (i, (src, dest, size)) in tasks.iter().enumerate() {
        // Nested conflict (inside a copied directory): honor the same policy.
        if dest.exists() {
            if overwrite {
                if let Err(e) = remove_recursive(dest) {
                    errors.push(format!("无法覆盖 {}: {}", dest.display(), e));
                    continue;
                }
            } else {
                *skipped += 1;
                continue;
            }
        }
        emit_progress(
            app,
            &src.file_name().unwrap().to_string_lossy(),
            i + 1,
            file_total,
            copied,
            total_bytes,
        );
        let res = if src.is_dir() {
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::create_dir_all(dest)
        } else {
            copy_file_with_progress(
                app,
                src,
                dest,
                *size,
                &mut copied,
                total_bytes,
                i + 1,
                file_total,
            )
            .map(|_| ())
        };
        if let Err(e) = res {
            errors.push(format!(
                "复制失败 {}: {}",
                src.file_name().unwrap().to_string_lossy(),
                e
            ));
        }
    }

    errors
}

/// Copy one or more source items into `dest_dir`.
/// `overwrite` controls the conflict policy (see `copy_all`). Returns a
/// `CopyResult` with genuine errors and the count of skipped conflicts.
#[tauri::command]
fn copy_items(
    app: tauri::AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    overwrite: bool,
) -> Result<CopyResult, String> {
    let dest_path = Path::new(&dest_dir);
    if !dest_path.is_dir() {
        return Result::Err(format!("目标目录不存在: {}", dest_dir));
    }
    let srcs: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let mut skipped = 0;
    let errors = copy_all(&app, &srcs, dest_path, overwrite, &mut skipped);
    Result::Ok(CopyResult { errors, skipped })
}

/// Move (cut) one or more source items into `dest_dir`.
/// Tries a fast `rename` first (same volume); if that fails (e.g. cross-drive),
/// falls back to chunked copy + delete (with progress events). `overwrite`
/// controls the conflict policy (see `copy_all`). Returns a `CopyResult`.
#[tauri::command]
fn move_items(
    app: tauri::AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    overwrite: bool,
) -> Result<CopyResult, String> {
    let dest_path = Path::new(&dest_dir);
    if !dest_path.is_dir() {
        return Result::Err(format!("目标目录不存在: {}", dest_dir));
    }

    let mut errors: Vec<String> = Vec::new();
    let mut skipped: usize = 0;
    let mut cross_volume: Vec<PathBuf> = Vec::new();

    for src in &sources {
        let src_path = Path::new(src);
        if !src_path.exists() {
            errors.push(format!("源不存在: {}", src));
            continue;
        }
        let name = match src_path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => {
                errors.push(format!("无效路径: {}", src));
                continue;
            }
        };
        let dest_item = dest_path.join(&name);
        if dest_item.exists() {
            if overwrite {
                if let Err(e) = remove_recursive(&dest_item) {
                    errors.push(format!("无法覆盖 {}: {}", name, e));
                    continue;
                }
            } else {
                skipped += 1;
                continue;
            }
        }
        // Try rename first; if it fails (cross-volume), defer to copy+delete.
        match fs::rename(src_path, &dest_item) {
            Result::Ok(_) => {}
            Result::Err(_) => cross_volume.push(src_path.to_path_buf()),
        }
    }

    // Cross-volume items: copy with progress, then delete the original.
    if !cross_volume.is_empty() {
        let mut cv_skipped = 0;
        let copy_errors = copy_all(&app, &cross_volume, dest_path, overwrite, &mut cv_skipped);
        errors.extend(copy_errors);
        skipped += cv_skipped;
        for src_path in &cross_volume {
            let name = src_path.file_name().unwrap().to_string_lossy().to_string();
            let dest_item = dest_path.join(&name);
            if dest_item.exists() {
                if let Err(e) = remove_recursive(src_path) {
                    errors.push(format!("删除源失败 {}: {}", name, e));
                }
            }
        }
    }

    Result::Ok(CopyResult { errors, skipped })
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
            copy_items,
            move_items,
            load_video_config,
            save_video_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
