//! Minimal file logger for the recursive search (Alt+F7).
//!
//! The search runs on a background thread and reports through events, so a
//! failure leaves no stack trace and no console output (a GUI build on Windows
//! has no attached console, so `eprintln!` goes nowhere). Everything of
//! interest is appended to `%USERPROFILE%\.minitc\logs\search.log`, truncated
//! when a search starts so the file always describes exactly one run.
//!
//! Logging must never be able to break the feature it instruments, so every
//! error here is swallowed on purpose.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, Once};

static SINK: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn log_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".minitc")
        .join("logs")
        .join("search.log")
}

/// Route Rust panics into the same file. Without this a panic on the search
/// thread kills it silently: `search-done` is never emitted and the dialog
/// spins forever with no clue why.
pub fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            log(&format!("PANIC: {info}"));
            previous(info);
        }));
    });
}

/// Append one line and flush it, so the file is readable while the app is
/// still running.
pub fn log(message: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{stamp}] {message}\n");

    let Ok(mut guard) = SINK.lock() else { return };
    if guard.is_none() {
        *guard = open_sink();
    }
    let Some(file) = guard.as_mut() else { return };
    let _ = file.write_all(line.as_bytes());
    let _ = file.flush();
}

fn open_sink() -> Option<std::fs::File> {
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .ok()?;
    let mut file = file;
    let _ = writeln!(
        file,
        "=== mini-tc search log — timestamps are epoch milliseconds ==="
    );
    let _ = file.flush();
    Some(file)
}
