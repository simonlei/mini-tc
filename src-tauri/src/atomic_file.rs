//! Publishing a file's contents **atomically**: write a temp file beside the
//! destination, get it onto the platter, then rename it over the target.
//!
//! Three callers need this and must not each grow their own version:
//!
//! - the copy path in `lib.rs` (one file at a time, with progress events),
//! - `save_config`, which is the single landing channel for *every* persisted
//!   store (view state, bookmarks, shortcuts, tabs, theme, panel split,
//!   video / app / text-preview settings),
//! - `window_state::save_state`, which had its own hand-rolled copy of the
//!   idea.
//!
//! The hand-rolled copies were not equivalent. `window_state` wrote to a
//! **fixed** temp name and — because the comment claimed "Windows rename can't
//! overwrite an existing target" — deleted the destination *before* renaming.
//! That is both unnecessary (measured on this machine: `fs::rename` maps to
//! `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, so it overwrites a file
//! fine) and destructive: the delete opens a window in which a crash leaves
//! **no** file at all. `save_config` did not even use a temp file — a bare
//! `fs::write` truncates first, so any interruption leaves half a JSON
//! document, `load_config` fails to parse, and every store silently falls back
//! to defaults. The user's bookmarks, tabs and key bindings simply vanish.
//!
//! Rules encoded here, all of them load-bearing:
//!
//! - The temp file is a **sibling** of the destination. Same directory means
//!   same filesystem, so the final `rename` stays a metadata-only atomic
//!   operation; a temp in `%TEMP%` would silently degrade into
//!   copy-then-delete.
//! - The temp name is claimed with `create_new`, so a file stranded by an
//!   earlier crash (or put there by something else) is never clobbered — we
//!   walk past it to the next free name.
//! - `sync_all` before the rename. The rename protects a *concurrent reader*
//!   from seeing a partial file; it does nothing about power loss, which is
//!   what the fsync is for.
//! - Every failure path removes the temp file and leaves the destination
//!   exactly as it was.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// A temp path next to `dest` — same directory, so the final `rename` stays on
/// one filesystem and therefore stays atomic. `attempt` only exists to walk
/// past a name left behind by an earlier crash.
pub fn tmp_sibling_path(dest: &Path, attempt: u32) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    if attempt == 0 {
        // No pid: the name is claimed with create_new, so we only need it to be
        // unlikely to collide. The pid keeps the common case collision-free
        // against a *concurrent* copy in the other panel.
        dir.join(format!(".{name}.minitc-{}.tmp", std::process::id()))
    } else {
        dir.join(format!(
            ".{name}.minitc-{}-{attempt}.tmp",
            std::process::id()
        ))
    }
}

/// Claim the temp path exclusively. `create_new` refuses an existing name, so a
/// name left behind by a previous crash (or another process) is never silently
/// clobbered — we bump the suffix until we find a free one.
pub fn create_new_file(dest: &Path) -> io::Result<(fs::File, PathBuf)> {
    for attempt in 0..64u32 {
        let candidate = tmp_sibling_path(dest, attempt);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => return Ok((f, candidate)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("无法为 {} 创建临时文件", dest.display()),
    ))
}

/// Replace `dest` with `body`, atomically.
///
/// The destination is never truncated in place and never removed up front: a
/// reader (or a crash) always sees either the previous complete content or the
/// new complete content.
pub fn write_atomic(dest: &Path, body: &[u8]) -> io::Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let (mut writer, tmp) = create_new_file(dest)?;
    let written = (|| -> io::Result<()> {
        writer.write_all(body)?;
        writer.flush()?;
        // Bytes onto the platter *before* the name is published. Without this
        // a power cut can leave a renamed-but-empty file where a good one used
        // to be.
        writer.sync_all()
    })();
    // The handle must be closed before the rename: Windows refuses to rename
    // over a path that still has an open handle on it.
    drop(writer);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // The commit. Everything above can fail with the destination still intact.
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "minitc-atomic-file-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
    }

    fn temps_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("minitc"))
            .collect()
    }

    /// A temp in `%TEMP%` would turn the commit into a cross-volume copy, i.e.
    /// a non-atomic one.
    #[test]
    fn temp_is_a_sibling_of_the_destination() {
        let dir = scratch("sibling");
        let dest = dir.join("sub").join("theme.json");
        let tmp = tmp_sibling_path(&dest, 0);
        assert_eq!(tmp.parent(), dest.parent());
        assert_ne!(tmp, dest, "the temp must not be the destination itself");
    }

    /// The whole point: an existing file is replaced by rename, **not**
    /// truncated in place and **not** deleted first.
    #[test]
    fn overwrite_keeps_the_old_content_until_the_commit() {
        let dir = scratch("overwrite");
        let dest = dir.join("bookmarks.json");
        write_atomic(&dest, b"OLD-BUT-COMPLETE").expect("first write");
        assert_eq!(read(&dest), "OLD-BUT-COMPLETE");

        write_atomic(&dest, b"NEW").expect("second write");
        assert_eq!(read(&dest), "NEW", "the new content must be published");
        assert!(
            temps_in(&dir).is_empty(),
            "no temp may survive a successful write: {:?}",
            temps_in(&dir)
        );
    }

    /// A failed publish must leave the previous good file **in place**. The
    /// hand-rolled `window_state` version deleted the destination before
    /// renaming, so any failure between the two left the user with no file at
    /// all — strictly worse than not writing.
    #[test]
    fn failed_publish_leaves_the_previous_file_intact() {
        let dir = scratch("fail-keep");
        // A non-empty directory cannot be replaced by rename
        // (`ERROR_DIR_NOT_EMPTY`, measured on this machine), which gives us a
        // commit step that genuinely fails.
        let dest = dir.join("dest");
        fs::create_dir_all(dest.join("child")).expect("create blocking dir");
        fs::write(dest.join("child").join("keep.txt"), "precious").expect("seed");

        let err = write_atomic(&dest, b"NEW").expect_err("rename over a non-empty dir must fail");
        // Measured on this machine: renaming onto a non-empty directory fails
        // with ERROR_ACCESS_DENIED (os error 5), which surfaces as
        // PermissionDenied — not ERROR_DIR_NOT_EMPTY as the copy path's
        // pre-clear check assumes. Either way it is a failure, and what this
        // test actually cares about is everything *after* that point.
        assert!(
            matches!(
                err.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::Other
            ),
            "unexpected error: {}",
            err
        );
        assert_eq!(
            read(&dest.join("child").join("keep.txt")),
            "precious",
            "a failed publish must not destroy what was already there"
        );
        assert!(
            temps_in(&dir).is_empty(),
            "a failed publish must clean up its temp: {:?}",
            temps_in(&dir)
        );
    }

    /// A name stranded by an earlier crash is never reused — overwriting it
    /// would destroy a file we know nothing about.
    #[test]
    fn stranded_temp_names_are_walked_past() {
        let dir = scratch("stranded");
        let dest = dir.join("theme.json");
        write_atomic(&dest, b"GOOD").expect("first write");

        let squatter = tmp_sibling_path(&dest, 0);
        fs::write(&squatter, "someone else's data").expect("squat");

        write_atomic(&dest, b"ALSO GOOD").expect("write past the squatter");
        assert_eq!(read(&dest), "ALSO GOOD");
        assert_eq!(read(&squatter), "someone else's data");
    }

    /// Parent directories are created for the caller — `save_config` targets a
    /// fresh `~/.minitc` on first run.
    #[test]
    fn missing_parent_directory_is_created() {
        let dir = scratch("mkdir");
        let dest = dir.join("fresh").join("deep").join("theme.json");
        write_atomic(&dest, b"{}").expect("write into a fresh tree");
        assert_eq!(read(&dest), "{}");
    }

    /// The regression this module exists for. A plain `fs::write` truncates the
    /// destination to zero *before* writing the body, so a reader — or a crash
    /// — can observe an empty or half-written file. Rename-based publishing has
    /// no such window: every observation is one of the complete bodies.
    ///
    /// Asserting the final content would prove nothing (the naive version ends
    /// up correct too). This test reads the destination **while** it is being
    /// rewritten and demands that every single observation is complete.
    #[test]
    fn concurrent_readers_never_see_a_partial_file() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = scratch("no-partial");
        let dest = dir.join("tabs.json");
        let small = br#"{"tabs":["left"]}"#.to_vec();
        let big = {
            let names = vec!["x"; 200_000].join(",");
            format!(r#"{{"tabs":[{}]}}"#, names).into_bytes()
        };
        write_atomic(&dest, &small).expect("seed");

        let stop = Arc::new(AtomicBool::new(false));
        let reader = {
            let dest = dest.clone();
            let stop = Arc::clone(&stop);
            let small = small.clone();
            let big = big.clone();
            std::thread::spawn(move || {
                let mut observations = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    if let Ok(body) = fs::read(&dest) {
                        observations += 1;
                        assert!(
                            body == small || body == big,
                            "reader saw a partial file: {} bytes, neither {} nor {}",
                            body.len(),
                            small.len(),
                            big.len()
                        );
                    }
                }
                observations
            })
        };

        for i in 0..60 {
            let body = if i % 2 == 0 { &big } else { &small };
            write_atomic(&dest, body).expect("rewrite");
        }
        stop.store(true, Ordering::Relaxed);
        let observations = reader.join().expect("reader thread");

        // Precondition: the reader must actually have run, otherwise every
        // assertion above is vacuous and the test measures nothing.
        assert!(
            observations > 0,
            "the reader thread observed nothing — the test proved nothing"
        );
    }

    /// Precondition guard for the test above, stated on its own so a future
    /// edit that breaks the reader (a renamed helper, a closed handle) fails
    /// loudly instead of silently making the concurrency test vacuous.
    #[test]
    fn the_reader_would_notice_a_truncated_write() {
        let dir = scratch("control");
        let dest = dir.join("tabs.json");
        let big = {
            let names = vec!["x"; 200_000].join(",");
            format!(r#"{{"tabs":[{}]}}"#, names)
        };
        fs::write(&dest, "OLD").expect("seed");

        // Control arm: the naive in-place write this module replaces. If this
        // loop cannot observe a partial state, then the concurrency test above
        // cannot prove anything either.
        let mut saw_partial = false;
        let body = big.as_bytes();
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&dest)
                .expect("open for in-place rewrite");
            for chunk in body.chunks(4096) {
                f.write_all(chunk).expect("write chunk");
                if fs::read_to_string(&dest)
                    .map(|s| s.len())
                    .unwrap_or(usize::MAX)
                    != body.len()
                {
                    saw_partial = true;
                    break;
                }
            }
        }
        assert!(
            saw_partial,
            "control arm never saw a partial file, so the concurrency test \
             above has no discriminating power"
        );
    }
}
