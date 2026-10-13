// ── Serialized config writer ──
//
// `save_config` is the single landing channel for *every* persisted store
// (view state, bookmarks, shortcuts, tabs, theme, panel split, video / app /
// text-preview settings). Two distinct hazards live there, and they are fixed
// in different places on purpose:
//
//  1. **Integrity** — a reader or a crash must never see a half-written file.
//     Solved in the backend by publishing through a temp file and renaming it
//     over the target. Nothing here can add that back: a bare `fs::write`
//     truncates before it writes, and this module only decides *when* to call
//     it, never *how*.
//
//  2. **Order** — the most recent state must be the one that survives. Solved
//     here. Tauri runs each command on a thread pool, so two `save_config`
//     calls issued 5 ms apart can reach the backend in either order, and the
//     loser commits last — leaving the file holding stale state (the panel
//     split snaps back, a renamed bookmark comes back). A promise chain per
//     config name is genuinely FIFO, which a backend-side Mutex would *not*
//     be: lock acquisition order is arbitrary too.
//
// Serialized **per name**, never globally: the payload is ~4 KB and the cost is
// the IPC round-trip, so making `bookmarks` wait for `theme` would add latency
// for nothing. This is the same reasoning that made `loadConfig` parallel.
//
// The writer is INJECTED. This module reaches no IPC itself, so the ordering —
// the part that is easy to get subtly wrong — is testable against a plain
// in-memory map by scripts/config-writer-check.mjs.

/// Build a `save(name, body)` function that issues writes per name in call
/// order, and never overlaps two writes to the same name.
///
/// `write` — `(name, body) => Promise`, the actual persistence call.
///           In the app this is the backend's `save_config`; in tests it is a
///           stub that records completion order.
///
/// Every call resolves with that call's own write result, so a caller awaiting
/// its save still learns whether *its* write landed. Note the deliberate
/// choice: a superseded write is **not** skipped. If the user changes the theme
/// three times quickly, three writes are issued. Dropping the middle one would
/// save a write but would break any caller that awaited it, and these payloads
/// are a few KB — the cost is not where the risk is.
export function createConfigWriter(write) {
  if (typeof write !== "function") {
    throw new Error("createConfigWriter 需要 write(name, body) 回调");
  }
  // name -> tail of that name's chain.
  const chains = new Map();

  return function save(name, body) {
    const previous = chains.get(name) || Promise.resolve();
    // `.then(go, go)` rather than `.then(go)`: a rejected predecessor must not
    // reject this write too. One failed save (disk full, file locked) must not
    // wedge the queue for that store permanently — the very "silently stops
    // persisting" failure this whole mechanism exists to prevent.
    const next = previous.then(
      () => write(name, body),
      () => write(name, body)
    );
    // The stored tail must never be a rejected promise, or every later link
    // would inherit the rejection.
    chains.set(
      name,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  };
}