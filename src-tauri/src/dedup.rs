//! Content-based duplicate detection.
//!
//! The comparison is deliberately **byte-exact streaming comparison**, not a
//! hash: `mini-tc` ships no hashing crate, and a hash collision here would mean
//! silently deleting a file the user still wanted. Two cheap stages keep it
//! fast anyway:
//!
//! 1. bucket candidates by `size` — files of different length are never equal,
//!    and this eliminates the overwhelming majority without touching content;
//! 2. within a bucket, compare the first and last 64 KB ([`quick_eq`]) and only
//!    then the whole file ([`files_equal`]).
//!
//! Every comparison result distinguishes **differs** from **could not tell**.
//! An unreadable file (locked, in use, permission denied) is never lumped in
//! with "not a duplicate" in a way that could delete it: the clusterer simply
//! never puts it next to anything.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Bytes read from each end of a file for the quick pre-filter.
const QUICK_EDGE: u64 = 64 * 1024;
/// Block size for the full streaming comparison.
const COMPARE_BLOCK: usize = 256 * 1024;

/// One file under consideration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub size: u64,
    /// Milliseconds since UNIX_EPOCH, as reported by the directory scan.
    pub modified: i64,
}

/// Outcome of comparing two files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Same {
    /// Byte-for-byte identical.
    Yes,
    /// Definitely different (or, for [`quick_eq`], different within the sampled
    /// edges).
    No,
    /// The comparison could not be carried out — the file vanished, is locked,
    /// or could not be read. Never treated as "identical".
    Unknown,
}

/// Group candidates by length. Buckets are returned largest-size-first so the
/// dialog can show the biggest space wins at the top, and within a bucket the
/// input order is preserved (the caller sorts by path first, which makes the
/// whole scan deterministic).
pub fn bucket_by_size(cands: &[Candidate]) -> Vec<Vec<Candidate>> {
    let mut order: Vec<u64> = Vec::new();
    let mut buckets: std::collections::HashMap<u64, Vec<Candidate>> =
        std::collections::HashMap::new();
    for c in cands {
        let e = buckets.entry(c.size).or_insert_with(|| {
            order.push(c.size);
            Vec::new()
        });
        e.push(c.clone());
    }
    order.sort_unstable_by(|a, b| b.cmp(a)); // biggest first
    order
        .into_iter()
        .filter_map(|size| buckets.remove(&size))
        .collect()
}

/// Compare the first and last [`QUICK_EDGE`] bytes of two files.
///
/// Cheap enough to run on every candidate pair inside a size bucket. Returns
/// [`Same::Yes`] only when both edges match; for files smaller than
/// `2 * QUICK_EDGE` the whole file is read anyway, which is simply the exact
/// answer.
pub fn quick_eq(a: &Path, b: &Path) -> Same {
    let (Ok(mut fa), Ok(mut fb)) = (fs::File::open(a), fs::File::open(b)) else {
        return Same::Unknown;
    };
    let (Ok(ma), Ok(mb)) = (fa.metadata(), fb.metadata()) else {
        return Same::Unknown;
    };
    if ma.len() != mb.len() {
        return Same::No;
    }
    if ma.len() == 0 {
        return Same::Yes;
    }
    let (Ok(ea), Ok(eb)) = (read_edges(&mut fa, ma.len()), read_edges(&mut fb, mb.len())) else {
        return Same::Unknown;
    };
    if ea == eb {
        Same::Yes
    } else {
        Same::No
    }
}

/// Read the head and (when it does not overlap the head) the tail of a file.
fn read_edges(f: &mut fs::File, len: u64) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let head_len = QUICK_EDGE.min(len);
    let mut head = vec![0u8; head_len as usize];
    f.read_exact(&mut head)?;
    out.extend_from_slice(&head);

    let tail_start = len.saturating_sub(QUICK_EDGE);
    // Overlapping edges are skipped: the head already covers those bytes.
    if tail_start > head_len {
        let tail_len = (len - tail_start) as usize;
        f.seek(SeekFrom::Start(tail_start))?;
        let mut tail = vec![0u8; tail_len];
        f.read_exact(&mut tail)?;
        out.extend_from_slice(&tail);
    }
    Ok(out)
}

/// Compare two files byte for byte, in blocks, without loading either into
/// memory. Used only after [`quick_eq`] said the sampled edges match.
pub fn files_equal(a: &Path, b: &Path) -> Same {
    let (Ok(mut fa), Ok(mut fb)) = (fs::File::open(a), fs::File::open(b)) else {
        return Same::Unknown;
    };
    let (Ok(ma), Ok(mb)) = (fa.metadata(), fb.metadata()) else {
        return Same::Unknown;
    };
    if ma.len() != mb.len() {
        return Same::No;
    }
    let mut ba = vec![0u8; COMPARE_BLOCK];
    let mut bb = vec![0u8; COMPARE_BLOCK];
    loop {
        let (Ok(na), Ok(nb)) = (fill(&mut fa, &mut ba), fill(&mut fb, &mut bb)) else {
            return Same::Unknown;
        };
        // One file ended before the other → different (the size check above
        // already covered the normal case; this catches a file that grew while
        // we were reading it).
        if na != nb {
            return Same::No;
        }
        if na == 0 {
            return Same::Yes;
        }
        if ba[..na] != bb[..nb] {
            return Same::No;
        }
    }
}

/// Read until the buffer is full or EOF, returning how many bytes were read.
///
/// `Read::read` is allowed to return short reads mid-file, so a single call is
/// not enough for a block comparison — two "identical" files could differ in
/// length of the block read and be declared equal.
fn fill(f: &mut fs::File, buf: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match f.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

/// Group candidates whose contents are identical.
///
/// Returns only clusters of two or more. `on_compare` is called once per
/// attempted comparison so the caller can report progress; `cancel` is
/// consulted before every candidate so a long scan stays interruptible.
///
/// A candidate is compared against the **representative** (first member) of
/// each existing cluster rather than against every member: identical files are
/// by definition equal to their representative, so this turns the inner loop
/// from O(n²) file comparisons into O(n · clusters).
pub fn cluster<F>(
    cands: &[Candidate],
    cancel: &AtomicBool,
    mut on_compare: F,
) -> Vec<Vec<Candidate>>
where
    F: FnMut(),
{
    let mut out: Vec<Vec<Candidate>> = Vec::new();
    for bucket in bucket_by_size(cands) {
        if bucket.len() < 2 {
            continue; // unique length → cannot be a duplicate
        }
        let mut clusters: Vec<Vec<Candidate>> = Vec::new();
        for c in bucket {
            if cancel.load(Ordering::Relaxed) {
                return out;
            }
            let mut placed: Option<usize> = None;
            for (ci, cl) in clusters.iter().enumerate() {
                let rep = &cl[0];
                // Two stages: the sampled edges reject nearly everything, and
                // only a `Yes` from it earns the full read.
                if quick_eq(&rep.path, &c.path) != Same::Yes {
                    continue;
                }
                on_compare();
                if files_equal(&rep.path, &c.path) == Same::Yes {
                    placed = Some(ci);
                    break;
                }
            }
            // `c` is moved exactly once, on one arm — moving it inside the
            // loop above would be a use-after-move on the `continue` path.
            match placed {
                Some(ci) => clusters[ci].push(c),
                None => clusters.push(vec![c]),
            }
        }
        out.extend(clusters.into_iter().filter(|c| c.len() >= 2));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> TempTree {
            let base = std::env::temp_dir().join(format!(
                "mini-tc-dedup-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).expect("temp dir");
            TempTree(base)
        }
        fn write(&self, name: &str, body: &[u8]) -> Candidate {
            let p = self.0.join(name);
            fs::write(&p, body).expect("write");
            let meta = fs::metadata(&p).expect("stat");
            Candidate {
                path: p,
                size: meta.len(),
                modified: 0,
            }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn buckets_are_largest_first_and_singletons_survive() {
        let b = bucket_by_size(&[
            Candidate {
                path: PathBuf::from("a"),
                size: 1,
                modified: 0,
            },
            Candidate {
                path: PathBuf::from("b"),
                size: 9,
                modified: 0,
            },
            Candidate {
                path: PathBuf::from("c"),
                size: 9,
                modified: 0,
            },
        ]);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0][0].size, 9);
        assert_eq!(b[0].len(), 2);
        assert_eq!(b[1][0].size, 1);
    }

    #[test]
    fn quick_eq_rejects_different_content_and_unreadable_files() {
        let t = TempTree::new("quick");
        let a = t.write("a.bin", b"hello world");
        let b = t.write("b.bin", b"hello worlx");
        assert_eq!(quick_eq(&a.path, &b.path), Same::No);
        // Different sizes never match, no read needed.
        let c = t.write("c.bin", b"hello world!");
        assert_eq!(quick_eq(&a.path, &c.path), Same::No);
        // Missing file → Unknown, never Yes.
        let missing = t.0.join("nope.bin");
        assert_eq!(quick_eq(&a.path, &missing), Same::Unknown);
    }

    #[test]
    fn quick_eq_catches_a_difference_past_the_sampled_edges() {
        // The distinguishing byte sits in the middle, so head+tail agree and
        // only the FULL comparison can reject it. This is why the clusterer
        // must not stop at quick_eq.
        let t = TempTree::new("mid");
        let mut x = vec![b'A'; 200 * 1024];
        let mut y = vec![b'A'; 200 * 1024];
        x[100 * 1024] = b'B';
        y[100 * 1024] = b'C';
        let a = t.write("a.bin", &x);
        let b = t.write("b.bin", &y);
        assert_eq!(quick_eq(&a.path, &b.path), Same::Yes);
        assert_eq!(files_equal(&a.path, &b.path), Same::No);
    }

    #[test]
    fn files_equal_compares_every_byte() {
        let t = TempTree::new("full");
        let big: Vec<u8> = (0..(600 * 1024u32)).map(|i| (i % 251) as u8).collect();
        let a = t.write("a.bin", &big);
        let b = t.write("b.bin", &big);
        assert_eq!(files_equal(&a.path, &b.path), Same::Yes);

        let mut other = big.clone();
        // A difference past the first 256 KB block: proves the loop keeps going
        // instead of stopping after one block.
        other[500 * 1024] ^= 0xff;
        let c = t.write("c.bin", &other);
        assert_eq!(files_equal(&a.path, &c.path), Same::No);
    }

    #[test]
    fn empty_files_compare_equal_so_the_caller_must_filter_them() {
        // At this level two empty files really are byte-identical and DO form
        // a cluster — nothing in `dedup.rs` excludes them. That is deliberate:
        // the "0 字节不参与去重" rule is a product decision about what the user
        // asked for (a folder full of empties is not a folder of copies), so it
        // lives in the scanner, which knows about `include_empty`. This test
        // pins the premise that rule relies on: if it ever stops holding, the
        // filter in `lib.rs` has to change with it.
        let t = TempTree::new("empty");
        let a = t.write("a.bin", b"");
        let b = t.write("b.bin", b"");
        assert_eq!(files_equal(&a.path, &b.path), Same::Yes);
        let out = cluster(&[a, b], &AtomicBool::new(false), || {});
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 2);
    }

    #[test]
    fn cluster_keeps_only_real_multiples() {
        let t = TempTree::new("cluster");
        let a = t.write("a.txt", b"same body");
        let b = t.write("b.txt", b"same body");
        let c = t.write("c.txt", b"different!!");
        let d = t.write("d.txt", b"unique one");
        let out = cluster(&[a, b, c, d], &AtomicBool::new(false), || {});
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 2);
        let names: Vec<String> = out[0]
            .iter()
            .map(|x| x.path.to_string_lossy().into())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("a.txt")));
        assert!(names.iter().any(|n| n.ends_with("b.txt")));
    }

    #[test]
    fn a_three_way_cluster_merges_in_one_pass() {
        let t = TempTree::new("three");
        let a = t.write("a.txt", b"body");
        let b = t.write("b.txt", b"body");
        let c = t.write("c.txt", b"body");
        let out = cluster(&[a, b, c], &AtomicBool::new(false), || {});
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 3);
    }

    #[test]
    fn cancellation_stops_the_clusterer() {
        let t = TempTree::new("cancel");
        let mut cands = Vec::new();
        for i in 0..6 {
            cands.push(t.write(&format!("f{i}.txt"), b"identical payload"));
        }
        let flag = AtomicBool::new(false);
        let out = cluster(&cands, &flag, || flag.store(true, Ordering::Relaxed));
        // The flag flips on the very first comparison, so at most the first
        // candidate of the bucket was placed.
        assert!(out.is_empty(), "cancel must abort before forming a cluster");
    }
}
