// 字幕探测（`VideoPreview.detectSubtitles`）的并发守卫 + 候选筛选。
//
// 病根：`loadVideo()` 清空 `subtitleTracks` 之后要 await 一整条字幕链 ——
// `getParentDir` → `listDirectory` → 串行 `fetch` 每个字幕文件。整条链 4~5 次
// await，而这期间 `props.filePath` 可以变：watcher 会为新文件再跑一次
// `loadVideo()`，它**同样清空** `subtitleTracks`。旧的那条链稍后 resolve，
// `addTrack` 无条件 `subtitleTracks.value.push(...)` → **旧目录的字幕被推进新
// 文件的轨道列表**（字幕串台）。用户看到的是：视频 B 配着视频 A 的字幕。
//
// 另一半更隐蔽：`detectSubtitles` 在 `listDirectory` **之后**才读
// `props.fileName` 算 base 名，于是 dir 取自旧文件、base 取自新文件，
// 「同名前缀」判定直接跨了两个文件。这不是守卫能救的 —— 快照必须在 await 之前
// 取，并透传到每一个消费者。
//
// 判据是「意图身份」：每次 `loadVideo()` 领一个全新对象 token，只有 token 仍
// 等于 current 的那条链能落地。用对象身份而不是自增序号，是因为本项目里序号已经
// 被反复证伪（`rerunSearch` 用 `Date.now() % 1000000`，16.7 分钟循环一次；A→B→A
// 折返时第一个 A 的序号也会被第三个请求作废）。
//
// 为什么这里可以用 token，而 `previewRequest.js` / `loadGate.js` 要用「目的地
// 还是不是它」：那边有**同key 的 in-flight 折叠**（连点两次同一个文件只发一次
// 请求），折返时第一个 A 的请求被折叠掉，于是序号判据会让谁都不落地。字幕探测
// **没有折叠** —— 每次 `loadVideo()` 都真的扫一遍目录。所以 A→B→A 折返时，第一个
// A 的 token 已被第三次加载覆盖、不落地是**对的**：第三次加载那条链会落地，不存在
// 「谁都不落地」。
//
// 落地方式是**全部 await 之后一次性提交**（见 METHODOLOGY「共享状态只在全部
// await 之后一次性提交」）：逐条 push 会让「刚被清空的新列表」与「旧链的残留」
// 混成一个中间态，而半更新的中间态比完全不更新更毒 —— 它喂给下游一个看起来合法
// 的组合（轨道非空、但一半来自别的文件）。

/**
 * 字幕探测的意图登记表。
 *
 * `begin()` 由每次 `loadVideo()` 调用（**无条件**调用，包括 `isExternalOnly`
 * 的分支 —— 那些分支不探测字幕，但它们同样换了目的地，必须作废仍在飞的探测）。
 * `lands(token)` 在每个 await 之后复核。`reset()` 在组件卸载时作废全部在飞探测。
 */
export function createSubtitleGate() {
  let current = null;
  return {
    begin() {
      // A fresh object per load: identity is the whole point, so two loads can
      // never collide the way two timestamps can.
      current = {};
      return current;
    },
    lands(token) {
      return !!token && token === current;
    },
    // Not the same as "the destination changed": unmounting doesn't navigate
    // anywhere, but nothing landing after unmount may touch the dead component.
    // Kept separate for the same reason `ctxMenuGate.reset()` is — see the
    // counterexample in METHODOLOGY where folding "closed" into the landing
    // criterion made the dispatching click invalidate itself.
    reset() {
      current = null;
    },
  };
}

/**
 * 从一次目录列表里挑出字幕候选，命中同名前缀的排前面。
 *
 * `base` 必须由调用方在 **await 之前**取好并透传进来：在这里重读 props 就是
 * 原 bug 的另一半（dir 来自旧文件、base 来自新文件）。
 *
 * 只做筛选与排序 —— 不碰 IPC、不碰 Vue，因此可被 plain node 直接测。
 *
 * @param {Array<{name: string, is_dir: boolean, path?: string}>} entries 目录列表的原始条目
 * @param {string} base    视频去掉扩展名后的主干名
 * @param {string[]} subExts 字幕扩展名白名单（小写、无点）
 * @returns {Array<{name: string, ext: string, matched: boolean, path?: string}>} 已排序的候选
 */
export function subtitleCandidates(entries, base, subExts) {
  const list = Array.isArray(entries) ? entries : [];
  const wanted = Array.isArray(subExts) ? subExts : [];
  const stem = base || "";
  return list
    .filter((e) => e && !e.is_dir && wanted.includes(extOf(e.name)))
    .map((e) => {
      const s = stemOf(e.name);
      // `movie.srt` matches video `movie.mp4`; `movie.en.srt` matches too, but
      // `movie2.srt` must NOT — hence the explicit "." instead of a bare
      // startsWith(base).
      // `path` is carried through (the backend always sends an absolute one) so
      // callers can skip a joinPath round-trip per subtitle file. Kept optional
      // because a listing that lacks it must still work.
      const out = { name: e.name, ext: extOf(e.name), matched: s === stem || s.startsWith(stem + ".") };
      if (e.path) out.path = e.path;
      return out;
    })
    .sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0) || a.name.localeCompare(b.name));
}

// "archive.tar.gz" → "gz"; no dot at all → "" (a file named "README" has no
// extension, and must not be treated as one).
function extOf(name) {
  const p = String(name || "").split(".");
  return p.length > 1 ? p.pop().toLowerCase() : "";
}

// "movie.en.srt" → "movie.en" — strip only the LAST extension, so the language
// suffix stays part of the stem and still matches `movie`.
function stemOf(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}
