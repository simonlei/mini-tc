# 修复：`save_config` 是全部用户配置的落盘通道，却用裸 `fs::write`（非原子、无串行化）

> 来源：`TODO-done.md` 第 207 行 · 章节 P0 — 数据丢失 / 崩溃 / 安全 · 第 9 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **修复：`save_config` 是全部用户配置的落盘通道，却用裸 `fs::write`（非原子、无串行化）** — `lib.rs:2225`。`viewState` / `bookmarks` / `shortcuts` / `tabs` / `theme` / `panel-split` / `video-config` / `app-config` / `text-preview` 十处全走它。叠加 `FilePanel.saveState` 的 deep watcher **完全无防抖**（`FilePanel.vue:371`，对比 `viewState` 的 150ms），连续 Alt+← / 切标签会并发发多个 `save_config`，Tauri command 跑在线程池上，两次 `fs::write` 同一路径会交错 → 半截或拼接的 JSON。下次启动 `load_config` 的 `fs::read_to_string(path).ok()`（`2211`）把解析失败变成 `None` → 各 store 的 `catch` 静默回落默认值 → **用户书签、标签页、快捷键绑定整体消失且无任何提示**。同仓库 `window_state.rs:124-133` 已实现 tmp+rename 并写了注释，通用配置通道反而没有。修法：抽 `write_atomic(path, body)` 给两处共用；`api.js` 加按 `name` 串行化的写队列；`saveState` 复用现有防抖模式。
  - ✅ **已实现（2026-10-13）**。原提的修法三条都做了，但**「完整性」与「顺序」必须分开修，我第一版把它们合在一起做了，结果做错了一半**。
    - **完整性归后端**：新模块 `src-tauri/src/atomic_file.rs` 的 `write_atomic(dest, body)`（tmp 与目标同级 → `create_new` 独占占名 → `sync_all` → rename）。`save_config` 与 `window_state::save_state` 现在共用它。
      - 🚨 **`window_state` 那份手写实现不只是「重复」，它比通用通道更危险**：注释写着「Windows 上 rename 不能覆盖已存在的目标，必须先删」，于是**先 `remove_file` 再 rename**。前半句是错的（本机实测 `fs::rename` → `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，覆盖文件毫无问题），后半句等于凭空开了一个「文件不存在」的窗口 —— 那两次系统调用之间崩一次，用户连上一份几何都没了。**比「没写」更差的失败模式，被一段自信的注释合理化了。**
    - **顺序归前端**：新模块 `src/configWriter.js` 的 `createConfigWriter(write)`，`api.js` 用它包住 `invoke("save_config")`。按 `name` 建 promise 链（**不是**全局串行），同 name 严格 FIFO，不同 name 仍并行 —— payload 仅数 KB，代价在 IPC 往返，让 `bookmarks` 等 `theme` 纯属凭空加延迟（与 `loadConfig` 并行同一理由）。
      - 🚨 **我第一版在后端加了按 name 的 Mutex，这是错的，两个原因**：① **变异测试直接证伪** —— 去掉锁连跑三次，拼接测试仍全绿，因为 `write_atomic` 已保证每次写都完整，锁对我声称的性质**毫无贡献**；② 它还是**跨阻塞文件 IO 持有 Mutex**，正是本项目「已知未修」里给 `window_state::flush` 记的同一条反模式，等于一边修一边新增。**更关键的是 Mutex 根本解决不了顺序问题** —— Tauri command 跑在线程池，两次请求到达顺序不定，而 **Mutex 的获取顺序也不是 FIFO**；真正有序的只有前端 promise 链。
    - **防抖**：`FilePanel` 两个 watcher 改走 `scheduleSave()`（200ms，比 `viewState` 的 150ms 宽 —— 这里的 payload 带目录历史，丢一次下次启动历史就明显不对）。**防抖是减少重复写，不是正确性依赖** —— 正确性已由上面两条独立保证。
    - **测试（后端 `config_persist_tests` 3 例 + `atomic_file::tests` 6 例，`cargo test --lib` 55 passed）**：`concurrent_saves_never_expose_a_partial_file` 用 8 个**不同长度**的 body 让 40 个真线程 + 1 个连续读线程对打，断言任一时刻文件内容必是某个完整文档；`a_failing_save_keeps_the_previous_document_loadable`、`persisted_documents_round_trip_unchanged`（含多字节内容，钉住任何按字节数算长度的假设）。
    - **测试（前端 `scripts/config-writer-check.mjs` 16 例，已挂进 `npm test`）**：顺序 / 乱序反例 / 同 name 最大并发为 1 / 不同 name 并行 / 失败不污染后续（含反复失败）/ 每笔调用拿到自己那笔的结果。
    - **变异测试四次，其中一次失败、一次是我自己的错**：
      - ① 去掉后端锁 → **没被抓住**（正是发现「锁无用」的那次变异，价值最高）；
      - ② `write_atomic` 退回裸 `fs::write` → **被抓住**（`reader saw a partial file: 0 bytes`）；
      - ③ 前端去掉串行化 → **被抓住 3 条**；
      - ④ 链尾不再吞 rejection → **被抓住**（以未捕获 rejection 崩掉，退出码 1）。
    - ⚠️ **反例构造失败过一次**：乱序那条我最初把延迟写成 `body.length * 5`，以为长 body 最后完成，实际**短的先完成**，于是反例根本没成立、测试抓不到任何东西。改成 `(10 - body.length) * 8` 后才真的乱序。**并在该测试里加了一条「反例前提」断言** —— 先证明无串行化确实会落地过期值，再验证串行化版本不会。**构造反例时必须先确认它真的会失败。**
    - ⚠️ 另两次变异（④的变体：去掉 `then(go, go)` 的 rejection 分支）**全绿**：因为链尾 `next.then(noop, noop)` 永不 reject，那个分支根本走不到。查下来真正承重的是**链尾那句 `.then(noop, noop)`**，两处冗余。留着（都便宜且有注释说明），但**知道谁承重，下次改动别删错那一句**。
    - **`lint:imports` 抓到一个真错误**：我第一版把 `saveConfig` 写成 `const` 而非 `export const`，6 个调用点全部拿不到。**这就是那个 lint 存在的意义。**
    - `cargo test --lib` 55 passed / 0 failed、`cargo check` 与 `cargo fmt --check` 均 exit 0 零warning、`npm run check` 全绿（lint 30 文件 + 110/22/23/11/37/16）、`vite build` exit 0（主 bundle 261.44 kB）。**待用户双击 `dev.bat` 实测**：连按 Alt+← 快速翻目录历史后关闭重开，书签 / 标签页 / 列宽应完整保留（旧版本有机会整体回默认值）；拖动分栏线后重启，分栏位置应与关闭前一致。
