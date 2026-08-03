use serde::Serialize;
use std::fs;
use std::io::{self, Read, Seek, Write};
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
    // Used to enumerate file paths from an HDROP handle read back from the
    // clipboard. NOTE: we must NOT call DragFinish on such a handle (it would
    // free clipboard-owned memory and corrupt the heap).
    fn DragQueryFileW(
        hDrop: *mut std::ffi::c_void,
        iFile: u32,
        lpszFile: *mut u16,
        cch: u32,
    ) -> u32;
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

/// The result of `list_directory`: the entries plus whether the path has a
/// parent (used to render the ".." row). Returning `has_parent` here lets the
/// frontend skip a separate `get_parent_dir` round-trip on every listing.
#[derive(Serialize)]
pub struct DirectoryListing {
    pub entries: Vec<FileEntry>,
    pub has_parent: bool,
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
/// The frontend renders a synthetic ".." row when `has_parent` is true, so we
/// compute it here once instead of paying a separate `get_parent_dir` RPC.
#[tauri::command]
fn list_directory(path: String) -> Result<DirectoryListing, String> {
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

    let has_parent = matches!(dir_path.parent(), Some(p) if !p.as_os_str().is_empty());

    Ok(DirectoryListing {
        entries: result,
        has_parent,
    })
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
                let rest = expanded[1..].trim_start_matches(['/', '\\']);
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

const TEXT_EXTENSIONS: &[&str] = &["TXT", "MD", "JSON", "LOG"];
const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
                                            // For large log files, only the most recent portion (tail) is read so that
                                            // previewing multi-GB logs stays responsive. txt/md/json still error out.
const LOG_TAIL_LIMIT: u64 = 512 * 1024; // 512 KB shown when a .log is oversized

/// Read a text file for preview (txt/md/json). JSON is returned as raw text;
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
            if extension == "LOG" {
                // Tail large logs instead of failing: seek to the last
                // LOG_TAIL_LIMIT bytes and read from there. The first (likely
                // partial) line is dropped so we don't show a chopped entry.
                let mut f =
                    fs::File::open(file_path).map_err(|e| format!("Failed to open file: {}", e))?;
                let skip = size.saturating_sub(LOG_TAIL_LIMIT);
                f.seek(io::SeekFrom::Start(skip))
                    .map_err(|e| format!("Failed to seek file: {}", e))?;
                let mut buf = Vec::new();
                f.read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read file: {}", e))?;
                let mut content = String::from_utf8_lossy(&buf).to_string();
                if let Some(idx) = content.find('\n') {
                    content = content[idx + 1..].to_string();
                }
                let total_mb = size / 1024 / 1024;
                let shown_kb = (LOG_TAIL_LIMIT / 1024) as usize;
                let banner = format!(
                    "──── 文件过大（共 {} MB），仅显示末尾 {} KB ────\n",
                    total_mb, shown_kb
                );
                return Ok(FilePreview {
                    preview_type: "text".to_string(),
                    content: banner + &content,
                    mime_type: "text/plain".to_string(),
                    size,
                    encoding: "utf-8".to_string(),
                });
            }
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

/// Returns true if `a` and `b` refer to the same filesystem location. Exact
/// comparison first, then canonicalization (resolves case, `.`/`..`, and
/// symlinks) when both paths exist. Used to detect a self-overwrite — copying
/// or moving a file onto itself — which would otherwise delete the source
/// before any copy runs and lose the data.
fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
        return ca == cb;
    }
    false
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
#[allow(clippy::too_many_arguments)]
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
        // Guard against overwriting a path with itself (e.g. pasting a file
        // into the same folder it already lives in). Without this, the code
        // below would `remove_recursive(dest_item)` — which *is* the source —
        // deleting the file before any copy runs, so it's lost with nothing
        // copied in. Skip such no-op entries instead.
        if dest_item.exists() && same_path(src, &dest_item) {
            continue;
        }
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
        // Skip a self-overwrite (dest is also the source) to avoid deleting it.
        if dest.exists() && same_path(src, dest) {
            *skipped += 1;
            continue;
        }
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
        // Guard against moving/cutting a path onto itself (e.g. paste into the
        // same folder): would delete the source before the rename, losing data.
        if dest_item.exists() && same_path(src_path, &dest_item) {
            skipped += 1;
            continue;
        }
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

/// Validate a config name to prevent path traversal. Only bare names without
/// directory separators or ".." segments are allowed (e.g. "theme",
/// "tabs-left", "tabs-right", "video-config").
fn is_valid_config_name(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

/// Load a named config blob from ~/.minitc/<name>.json.
/// Returns the raw JSON string, or null if the file does not exist / can't be read.
/// All app config (theme, per-panel tabs, video player settings) is unified under
/// ~/.minitc via this single pair of commands.
#[tauri::command]
fn load_config(name: String) -> Option<String> {
    if !is_valid_config_name(&name) {
        return None;
    }
    let dir = home_dir()?.join(".minitc");
    let path = dir.join(format!("{}.json", name));
    fs::read_to_string(path).ok()
}

/// Persist a named config blob to ~/.minitc/<name>.json so it is shared across
/// every run of the binary (dev vs bundled) regardless of cwd.
#[tauri::command]
fn save_config(name: String, config: String) -> Result<(), String> {
    if !is_valid_config_name(&name) {
        return Err("非法的配置名".to_string());
    }
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let dir = home.join(".minitc");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", name));
    fs::write(path, config).map_err(|e| e.to_string())?;
    Ok(())
}

/// Result returned by `get_clipboard_files`: the list of file paths currently
/// on the OS clipboard and whether they were cut (move) or copied.
#[derive(Serialize)]
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

/// Read / write the OS file clipboard so mini-tc interoperates with File
/// Explorer, Finder, and other file managers. The OS clipboard is the single
/// source of truth — there is deliberately no in-app mirror buffer, so a
/// copy/cut made in any other app is always picked up on paste.
///
/// - Windows: native clipboard APIs (CF_HDROP + a Unicode-text fallback copy +
///   a "Preferred DropEffect" marker so a cut pastes as a *move*).
/// - macOS / Linux: `arboard` (NSPasteboard / X11 CLIPBOARD `text/uri-list`).
///   These platforms have no clipboard move-flag, so `cut` is always `false`
///   there (Ctrl+X pastes as a copy, matching Finder which has no file-cut).
#[cfg(windows)]
mod os_clipboard {
    use std::path::Path;
    use std::ptr;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWnd: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, hMem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut std::ffi::c_void;
        fn GlobalLock(hMem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GlobalUnlock(hMem: *mut std::ffi::c_void) -> i32;
        fn GlobalFree(hMem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;
    const DROPEFFECT_MOVE: u32 = 2;

    // DROPFILES: pFiles, POINT{x,y}, fNC, fWide = 20 bytes total.
    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        pt_x: i32,
        pt_y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    fn to_wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0u16))
            .collect()
    }

    /// RAII guard that closes the clipboard when dropped — even if a panic
    /// unwinds through the code that opened it. This prevents the clipboard
    /// from being left permanently locked by a mid-operation failure.
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    /// Write `paths` onto the OS clipboard as a file list (CF_HDROP), plus a
    /// Unicode-text copy (one path per line) and — when `cut` — a
    /// "Preferred DropEffect" = DROPEFFECT_MOVE marker so Explorer moves (not
    /// copies) the files on paste.
    ///
    /// # Safety
    /// Must be called from a context where the OS clipboard may be opened.
    unsafe fn set_files_inner(paths: &[String], cut: bool) -> Result<(), String> {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return Err("无法打开系统剪贴板(可能被其他程序占用)".to_string());
        }
        // Guard guarantees CloseClipboard runs on every exit path (incl. panic).
        let _guard = ClipboardGuard;
        EmptyClipboard();

        // Build the double-null-terminated wide-char file list.
        let mut file_list: Vec<u16> = Vec::new();
        for p in paths {
            file_list.extend_from_slice(&to_wide(p));
        }
        file_list.push(0u16); // second terminating null

        let header_size = std::mem::size_of::<DropFiles>() as u32;
        let total = header_size as usize + file_list.len() * 2;
        let hglobal = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total);
        if hglobal.is_null() {
            return Err("剪贴板内存分配失败".to_string());
        }
        let locked = GlobalLock(hglobal);
        if locked.is_null() {
            GlobalFree(hglobal);
            return Err("剪贴板内存锁定失败".to_string());
        }
        std::ptr::write(
            locked as *mut DropFiles,
            DropFiles {
                p_files: header_size,
                pt_x: 0,
                pt_y: 0,
                f_nc: 0,
                f_wide: 1,
            },
        );
        let list_ptr = (locked as *mut u8).add(header_size as usize) as *mut u16;
        std::ptr::copy_nonoverlapping(file_list.as_ptr(), list_ptr, file_list.len());
        GlobalUnlock(hglobal);

        if SetClipboardData(CF_HDROP, hglobal).is_null() {
            GlobalFree(hglobal);
            return Err("写入文件剪贴板(CF_HDROP)失败".to_string());
        }

        // Unicode-text copy (one path per line) for text targets / fallback.
        let text = paths.join("\r\n");
        let wide_text = to_wide(&text);
        let th = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, wide_text.len() * 2);
        if !th.is_null() {
            let tlocked = GlobalLock(th);
            if !tlocked.is_null() {
                std::ptr::copy_nonoverlapping(
                    wide_text.as_ptr(),
                    tlocked as *mut u16,
                    wide_text.len(),
                );
                GlobalUnlock(th);
                if SetClipboardData(CF_UNICODETEXT, th).is_null() {
                    GlobalFree(th);
                }
            } else {
                GlobalFree(th);
            }
        }

        // Mark cut vs copy via the "Preferred DropEffect" custom format.
        if cut {
            let fmt = RegisterClipboardFormatW(to_wide("Preferred DropEffect").as_ptr());
            if fmt != 0 {
                let eh = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, 4);
                if !eh.is_null() {
                    let elocked = GlobalLock(eh);
                    if !elocked.is_null() {
                        std::ptr::write(elocked as *mut u32, DROPEFFECT_MOVE);
                        GlobalUnlock(eh);
                        if SetClipboardData(fmt, eh).is_null() {
                            GlobalFree(eh);
                        }
                    } else {
                        GlobalFree(eh);
                    }
                }
            }
        }

        Ok(())
    }

    /// Read file paths from the OS clipboard. Prefers CF_HDROP; falls back to
    /// parsing the Unicode-text copy. Returns `None` when the clipboard holds
    /// no usable file paths. The `cut` flag is derived from "Preferred
    /// DropEffect" (or defaults to copy for the text fallback).
    ///
    /// # Safety
    /// Must be called from a context where the OS clipboard may be opened.
    unsafe fn get_files_inner() -> Result<Option<(Vec<String>, bool)>, String> {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return Err("无法打开系统剪贴板(可能被其他程序占用)".to_string());
        }
        let _guard = ClipboardGuard;
        let mut result: Option<(Vec<String>, bool)> = None;

        if IsClipboardFormatAvailable(CF_HDROP) != 0 {
            let hdrop = GetClipboardData(CF_HDROP);
            if !hdrop.is_null() {
                let count = crate::DragQueryFileW(hdrop, u32::MAX, ptr::null_mut(), 0);
                let mut paths = Vec::new();
                for i in 0..count {
                    let len = crate::DragQueryFileW(hdrop, i, ptr::null_mut(), 0) as usize;
                    if len == 0 {
                        continue;
                    }
                    let mut buf: Vec<u16> = vec![0u16; len + 1];
                    crate::DragQueryFileW(hdrop, i, buf.as_mut_ptr(), (len + 1) as u32);
                    // `len` from DragQueryFileW is the path length WITHOUT the
                    // null terminator (the buffer is `len + 1` to hold it). The
                    // valid path is `buf[..len]` — slicing `len - 1` would drop
                    // the final character of the file name.
                    paths.push(String::from_utf16_lossy(&buf[..len]));
                }
                // IMPORTANT: do NOT call DragFinish(hdrop) here. `hdrop` came from
                // GetClipboardData and is owned by the clipboard; DragFinish would
                // GlobalFree it, causing a double-free / STATUS_HEAP_CORRUPTION
                // (0xc0000374) on the next clipboard free or process exit. The
                // clipboard releases the handle itself when we CloseClipboard.

                let mut cut = false;
                let fmt = RegisterClipboardFormatW(to_wide("Preferred DropEffect").as_ptr());
                if fmt != 0 && IsClipboardFormatAvailable(fmt) != 0 {
                    let eh = GetClipboardData(fmt);
                    if !eh.is_null() {
                        let elocked = GlobalLock(eh);
                        if !elocked.is_null() {
                            let effect = std::ptr::read(elocked as *const u32);
                            cut = effect == DROPEFFECT_MOVE;
                            GlobalUnlock(eh);
                        }
                    }
                }
                result = Some((paths, cut));
            }
        }

        // Fallback: parse the Unicode-text copy (one existing path per line).
        if result.is_none() && IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
            let htext = GetClipboardData(CF_UNICODETEXT);
            if !htext.is_null() {
                let locked = GlobalLock(htext);
                if !locked.is_null() {
                    let mut w: Vec<u16> = Vec::new();
                    let p = locked as *const u16;
                    let mut i = 0;
                    loop {
                        let c = *p.add(i);
                        if c == 0 {
                            break;
                        }
                        w.push(c);
                        i += 1;
                    }
                    GlobalUnlock(htext);
                    let text = String::from_utf16_lossy(&w);
                    let paths: Vec<String> = text
                        .split(['\r', '\n'])
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty() && Path::new(s).exists())
                        .collect();
                    if !paths.is_empty() {
                        result = Some((paths, false));
                    }
                }
            }
        }

        Ok(result)
    }

    /// Public, panic-safe wrapper around `set_files_inner`. A panic inside the
    /// Win32 code (e.g. an unexpected clipboard state) is caught and turned
    /// into a normal `Err` instead of aborting the whole application.
    pub fn set_files(paths: &[String], cut: bool) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        crate::debug_log(&format!(
            "[clip] set_files: {} paths, cut={}",
            paths.len(),
            cut
        ));
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            set_files_inner(paths, cut)
        }));
        match res {
            Ok(Ok(())) => {
                crate::debug_log("[clip] set_files: ok");
                Ok(())
            }
            Ok(Err(e)) => {
                crate::debug_log(&format!("[clip] set_files: err {e}"));
                Err(e)
            }
            Err(_) => {
                let m = "剪贴板写入发生内部错误(已捕获，应用未崩溃)".to_string();
                crate::debug_log("[clip] set_files: PANIC caught");
                Err(m)
            }
        }
    }

    /// Public, panic-safe wrapper around `get_files_inner`.
    pub fn get_files() -> Result<Option<(Vec<String>, bool)>, String> {
        crate::debug_log("[clip] get_files: enter");
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            get_files_inner()
        }));
        match res {
            Ok(r) => {
                crate::debug_log(&format!(
                    "[clip] get_files: result={:?}",
                    r.as_ref().map(|o| o.as_ref().map(|(p, c)| (p.len(), *c)))
                ));
                r
            }
            Err(_) => {
                let m = "剪贴板读取发生内部错误(已捕获，应用未崩溃)".to_string();
                crate::debug_log("[clip] get_files: PANIC caught");
                Err(m)
            }
        }
    }

    /// Empty the system clipboard (consume a cut after paste). Mirrors
    /// Explorer's behavior so a cut isn't re-pasted after it's used.
    pub fn clear() -> Result<(), String> {
        unsafe {
            if OpenClipboard(ptr::null_mut()) == 0 {
                return Err("无法打开系统剪贴板(可能被其他程序占用)".to_string());
            }
            let _guard = ClipboardGuard;
            EmptyClipboard();
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod os_clipboard {
    use arboard::Clipboard;

    /// Write `paths` onto the OS file clipboard. `_cut` is ignored: macOS/Linux
    /// expose no clipboard move-flag, so a cut pastes as a copy (which also
    /// matches Finder, which has no file-cut).
    pub fn set_files(paths: &[String], _cut: bool) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut cb = Clipboard::new().map_err(|e| format!("无法访问系统剪贴板: {e}"))?;
        let list: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
        cb.set()
            .file_list(&list)
            .map_err(|e| format!("写入文件剪贴板失败: {e}"))?;
        Ok(())
    }

    /// Read file paths from the OS clipboard. Returns `None` when empty.
    pub fn get_files() -> Result<Option<(Vec<String>, bool)>, String> {
        let mut cb = Clipboard::new().map_err(|e| format!("无法访问系统剪贴板: {e}"))?;
        let paths = cb
            .get()
            .file_list()
            .map_err(|e| format!("读取文件剪贴板失败: {e}"))?;
        if paths.is_empty() {
            return Ok(None);
        }
        let paths: Vec<String> = paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        // No clipboard move-flag on these platforms -> always copy.
        Ok(Some((paths, false)))
    }

    /// Best-effort clear used to consume a cut after paste. macOS/Linux have no
    /// portable "clear", and since cut there is effectively a copy, leaving the
    /// clipboard is harmless — so this is intentionally a no-op.
    pub fn clear() -> Result<(), String> {
        Ok(())
    }
}

/// Write the given paths onto the OS clipboard as a file list. `cut = true`
/// marks them for a move (so File Explorer moves rather than copies on paste —
/// Windows only; other platforms paste as copy).
#[tauri::command]
fn set_clipboard_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    os_clipboard::set_files(&paths, cut)
}

/// Read file paths from the OS clipboard. Returns `null` when the clipboard
/// holds no usable file paths.
#[tauri::command]
fn get_clipboard_files() -> Result<Option<ClipboardFiles>, String> {
    let opt = os_clipboard::get_files()?;
    Ok(opt.map(|(paths, cut)| ClipboardFiles { paths, cut }))
}

/// Consume the current clipboard contents. On Windows this empties the system
/// clipboard (matching Explorer's "cut then paste clears the clipboard"
/// behavior) so a cut isn't re-pasted; on other platforms it's a no-op.
#[tauri::command]
fn clear_clipboard() -> Result<(), String> {
    os_clipboard::clear()
}

/// ─────────────────────────────────────────────────────────────────────────
/// External archive extraction (7-Zip / WinRAR / unzip) via the right-click
/// context menu. mini-tc does NOT bundle an extractor; instead it discovers an
/// already-installed tool on the host and shells out to it.
/// ─────────────────────────────────────────────────────────────────────────
///
/// A discovered external extraction tool.
#[derive(Serialize)]
pub struct ArchiveTool {
    pub id: String,     // stable identifier (e.g. "7zip-7z", "path-7za")
    pub name: String,   // display name shown in the menu (e.g. "7-Zip")
    pub exe: String,    // absolute path to the executable
    pub syntax: String, // "7z" | "unzip" | "winrar" — how to invoke it
}

/// Locate an executable by name using the system PATH.
/// Returns the first resolved absolute/relative path, or None when absent.
fn find_in_path(name: &str) -> Option<String> {
    #[cfg(windows)]
    let out = std::process::Command::new("where.exe")
        .arg(name)
        .output()
        .ok();
    #[cfg(not(windows))]
    let out = std::process::Command::new("which").arg(name).output().ok();

    if let Some(out) = out {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let first = s.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    None
}

/// Best-effort search for `basenames` (e.g. `["7z.exe", "7za.exe"]`) across all
/// drive roots C:..Z:. For each available root it checks the root itself, a few
/// well-known portable folders, and one level of sub-directories (including the
/// conventional `7-Zip` / `WinRAR` sub-folder). This catches custom/portable
/// installs such as `D:\Soft\7-Zip\7z.exe` that the standard paths miss.
/// Unavailable or inaccessible drives are skipped silently so detection never
/// blocks the UI.
#[cfg(windows)]
fn scan_drives_for_exe(basenames: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    let known_subdirs: &[&str] = &[
        "Soft",
        "Tools",
        "PortableApps",
        "Program Files",
        "Program Files (x86)",
    ];
    let tool_dirs: &[&str] = &["7-Zip", "7zip", "WinRAR", "Winrar"];
    for letter in b'C'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let rootp = Path::new(&root);
        if !rootp.exists() {
            continue;
        }
        for base in basenames {
            // Directly at the drive root (rare but cheap).
            let direct = rootp.join(base);
            if direct.exists() {
                found.push(direct.to_string_lossy().into_owned());
            }
            // <root>/<known_subdir>/<base>
            for sub in known_subdirs {
                let under = rootp.join(sub).join(base);
                if under.exists() {
                    found.push(under.to_string_lossy().into_owned());
                }
            }
        }
        // One level of sub-directories: <root>/<child>/<base> and
        // <root>/<child>/<tool_dir>/<base>.
        if let Ok(entries) = std::fs::read_dir(rootp) {
            for entry in entries.flatten() {
                let child = entry.path();
                if !child.is_dir() {
                    continue;
                }
                for base in basenames {
                    let c1 = child.join(base);
                    if c1.exists() {
                        found.push(c1.to_string_lossy().into_owned());
                    }
                    for tool in tool_dirs {
                        let c2 = child.join(tool).join(base);
                        if c2.exists() {
                            found.push(c2.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    found
}

/// Discover extraction tools actually present on this machine. Only tools whose
/// executable exists are returned, so the frontend can tailor the menu (and
/// show a "not installed" placeholder when none are found).
#[tauri::command]
fn get_archive_tools() -> Vec<ArchiveTool> {
    let mut tools: Vec<ArchiveTool> = Vec::new();

    #[cfg(windows)]
    {
        // Collect every candidate executable path we can find, then classify &
        // de-duplicate. Sources, in order:
        //   1. Well-known install locations (fast, explicit).
        //   2. System PATH (7z.exe / 7za.exe / winrar.exe / unrar.exe).
        //   3. A best-effort scan of local drive roots for portable / custom
        //      installs (e.g. D:\Soft\7-Zip\7z.exe) outside Program Files.
        let mut candidates: Vec<(String, String)> = Vec::new(); // (path, id-hint)

        for (path, id) in [
            (r"C:\Program Files\7-Zip\7z.exe", "7zip-7z"),
            (r"C:\Program Files (x86)\7-Zip\7z.exe", "7zip-7z-x86"),
            (r"C:\Program Files\WinRAR\WinRAR.exe", "winrar-gui"),
            (r"C:\Program Files\WinRAR\UnRAR.exe", "winrar-unrar"),
        ] {
            if Path::new(path).exists() {
                candidates.push((path.to_string(), id.to_string()));
            }
        }

        for name in ["7z.exe", "7za.exe", "winrar.exe", "unrar.exe"] {
            if let Some(p) = find_in_path(name) {
                candidates.push((p, format!("path-{}", name)));
            }
        }

        for p in scan_drives_for_exe(&["7z.exe", "7za.exe"]) {
            candidates.push((p, "scan-7z".to_string()));
        }
        for p in scan_drives_for_exe(&["winrar.exe", "unrar.exe"]) {
            candidates.push((p, "scan-winrar".to_string()));
        }

        // De-duplicate by path and classify each survivor.
        let mut seen = std::collections::HashSet::new();
        for (path, id) in candidates {
            if !seen.insert(path.clone()) {
                continue;
            }
            let lower = path.to_lowercase();
            let (name, syntax) = if lower.contains("winrar") || lower.contains("unrar") {
                ("WinRAR".to_string(), "winrar".to_string())
            } else {
                ("7-Zip".to_string(), "7z".to_string())
            };
            tools.push(ArchiveTool {
                id,
                name,
                exe: path,
                syntax,
            });
        }
    }

    #[cfg(not(windows))]
    {
        // p7zip
        for name in ["7z", "7za"] {
            if let Some(p) = find_in_path(name) {
                tools.push(ArchiveTool {
                    id: format!("path-{}", name),
                    name: "7-Zip".to_string(),
                    exe: p,
                    syntax: "7z".to_string(),
                });
            }
        }
        // unzip
        if let Some(p) = find_in_path("unzip") {
            tools.push(ArchiveTool {
                id: "path-unzip".to_string(),
                name: "unzip".to_string(),
                exe: p,
                syntax: "unzip".to_string(),
            });
        }
    }

    tools
}

/// Result returned by `extract_archive`.
#[derive(Serialize)]
pub struct ExtractResult {
    pub success: bool,
    pub message: String,
}

/// Run an external archive tool to extract `archive` into `target_dir`.
///
/// - `mode == "here"`: extract directly into `target_dir`.
/// - `mode == "to_folder"`: extract into a new sub-folder named after the
///   archive's base name (e.g. `foo.zip` → `foo\`), which 7z/unzip create
///   automatically.
/// `tool_exe` + `syntax` come from `get_archive_tools` so this command stays
/// agnostic to which tool is installed.
#[tauri::command]
fn extract_archive(
    archive: String,
    target_dir: String,
    tool_exe: String,
    syntax: String,
    mode: String,
) -> Result<ExtractResult, String> {
    let archive_path = Path::new(&archive);
    if !archive_path.exists() {
        return Err(format!("压缩包不存在: {}", archive));
    }
    let target_base = Path::new(&target_dir);
    if !target_base.is_dir() {
        return Err(format!("目标目录无效: {}", target_dir));
    }

    // Resolve the final extraction target directory.
    let target = if mode == "to_folder" {
        let stem = archive_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "archive".to_string());
        target_base.join(stem)
    } else {
        target_base.to_path_buf()
    };

    let target_str = target.to_string_lossy().to_string();

    // Build the invocation per tool syntax.
    let mut cmd = std::process::Command::new(&tool_exe);
    match syntax.as_str() {
        "unzip" => {
            // unzip -o <archive> -d <target>  (-o = overwrite)
            cmd.arg("-o").arg(&archive).arg("-d").arg(&target);
        }
        "winrar" => {
            // WinRAR `x` = extract with full paths; the destination folder
            // must end with a separator so WinRAR treats it as a directory.
            let mut t = target_str.clone();
            if !t.ends_with('\\') && !t.ends_with('/') {
                t.push(std::path::MAIN_SEPARATOR);
            }
            cmd.arg("x").arg(&archive).arg(t);
        }
        _ => {
            // Default / "7z": `7z x <archive> -o<target> -y`
            // The `-o` switch is concatenated with the path (no space) so it
            // survives paths containing spaces as a single argument.
            cmd.arg("x")
                .arg(&archive)
                .arg(format!("-o{}", target_str))
                .arg("-y");
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("compression tool launch failed: {}", e))?;

    if output.status.success() {
        Ok(ExtractResult {
            success: true,
            message: format!("已解压到: {}", target_str),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let detail = (stderr + &stdout).trim().to_string();
        Err(format!(
            "解压失败 ({}):\n{}",
            output.status,
            if detail.is_empty() {
                "未知错误（工具无输出）"
            } else {
                &detail
            }
        ))
    }
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
            load_config,
            save_config,
            set_clipboard_files,
            get_clipboard_files,
            clear_clipboard,
            get_archive_tools,
            extract_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
