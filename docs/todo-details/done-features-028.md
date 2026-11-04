# 回退：启动期配置「9 次 `load_config` 合并为 1 次 `load_configs`」

> 来源：`TODO-done.md` 第 66 行 · 章节 已实现功能（想法暂存区） · 第 28 条
> 2026-11-04 TODO 瘦身整块外迁，以下原文逐字保留；主清单见 `../../TODO-done.md`。

<!-- ORIGINAL-BLOCK-START -->

- [x] **回退：启动期配置「9 次 `load_config` 合并为 1 次 `load_configs`」** — 曾实现（后端一次 `read_dir` 读回全部 `~/.minitc/*.json` + 前端 `primeConfigs()` 缓存 + `loadConfig` 内部 await 该 in-flight promise），**实测为负优化，已完整删除**（后端命令、handler 注册、`HashMap` import、前端缓存层、README 段落全部清掉）。**实测数据**：`cfg:prime` 单次 **57.2ms**，而被它替代的 9 次**并行**单文件 `loadConfig` 每个仅 **~14ms**；配置总量实测只有 **~4 KB**（最大 `tabs-right.json` 1590 B）→ 瓶颈从来不是 I/O，而是 **IPC 往返本身**。把 9 次并行排到 1 道屏障后面，等于**让页面上最慢的东西变成那道屏障**，把约 14ms 的墙钟变成 57ms。**教训**：这个改动在静态分析里是「9 次往返 → 1 次」，听起来必然更优，**量级却是反的**。此量级下**并行独立 > 批量串行**；「合并请求以减少往返」只在**单次往返开销远大于载荷**时才成立（此处载荷 4 KB，往返却是十几 ms 量级，条件完全不满足）。**启动埋点的价值正在于此** —— 这类错误 `cargo check` / `vite build` 一律发现不了。
