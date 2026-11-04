# 修复：`normDir("/")` 归一化为空串，POSIX 根目录与空路径塌缩成同一个 key

> 来源：`TODO.md` 第 49 行 · 章节 P1 — 真 bug / 竞态 / 泄漏 / 明显性能 · 第 19 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO.md`。

<!-- ORIGINAL-BLOCK-START -->

- [ ] **修复：`normDir("/")` 归一化为空串，POSIX 根目录与空路径塌缩成同一个 key** —  ⚠️ 2026-10-19 复核：**代码事实成立但原文的具体后果多数被其他守卫挡住，且函数名有误** —— `pathKey` 不是 `paths.js` 的函数而是 `bookmarks.js:50-52` 的模块私有函数、`samePath` 是 `BookmarkMenu.vue:232-234` 的组件内局部函数，两者实现相同（`normDir(p).toLowerCase()`）。`normDir:44-46` 确无根形态保护（正斜杠根被剥成空串、盘符根被剥成 `C:`）、`parentDirOf("C:反斜杠")` 返回 `C:` 确成立且危害 `App.vue:1276/1630` 的盘根 no-op 漏过滤。但 ① 「marked 把当前目录是根误判成已加书签」**不成立** —— `BookmarkMenu.vue:241-243` 有 `!!props.currentPath` 非空守卫，且当前目录就是根、书签也是根时判为已加书签是**正确**的；② 「sanitize 用空串做去重 key」**不成立** —— `bookmarks.js:64-65` 在算 key **之前**就 `if (!path) continue` 丢弃空路径，空串永远进不了 `seen`。`paths.js:44-46`。`"/".replace(/\/+$/, "")` → `""`，于是 `pathKey("/") === ""`、`samePath("/","")` 为真。在 macOS/Linux 上把 `/` 加为书签后，`sanitize` 会用空串做去重 key，`BookmarkMenu` 的 `marked` 会把「当前目录是 `/`」误判成「已加书签」。同理 `normDir("C:\\")` → `"C:"`，而 `parentDirOf` 会把盘根算成有父级。修法：`normDir` 保留根形态（长度 > 1 才剥尾斜杠）。
