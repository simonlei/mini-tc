# mini-tc TODO

> 本文件只做清单：每条一行（现象 + 判据），实现/复核明细整块外迁到 `docs/todo-details/`，按需打开。
> 想法暂存区，先记录，暂不实现；曾膨胀到 3.5 万 token 无法整读，故拆明细。
> 瘦身前原文备份（可恢复）：`C:/Users/simon/WorkBuddy/_mini-tc-archive-20261104/todo-before-slim-20261104.tar.gz`
> 已完成条目见 [`TODO-done.md`](TODO-done.md)；判定不做 / 已失效的见其「审计结论」节。
> 🚨 **纪律（2026-11-04 审查新增）**：明细里 2026-10-19 的复核结论必须同步回本文件标题；
> 已修完、已被明细自证推翻、或判定「不值得做」的，整条迁 `TODO-done.md`，别让标题比明细更错。
> 对应的 `docs/todo-details/open-*.md` 原样保留作取证留档，不随清单删除。

## P0 — 数据丢失 / 崩溃 / 安全

（当前为空，2026-10-14 清空）

## P1 — 真 bug / 竞态 / 泄漏 / 明显性能

- [ ] **修复：`loadVideo()` 不 pause 旧视频，切文件时旧音频继续响到新资源起播；`videoSrc = ""` 是死代码** · [明细](docs/todo-details/open-P1-001.md)
- [ ] **修复：五个对话框既不拦全局快捷键，也不还焦点** — `App.vue:2095-2113`（三道闸门）+ `318/357/443/652/…`（入口） · [明细](docs/todo-details/open-P1-002.md)
- [ ] **修复：`FileList.onKeydown` 没有 `isActive` 守卫，与 `onMouseUp` 不一致** · [明细](docs/todo-details/open-P1-003.md)
- [ ] **修复：预览关闭/恢复/视频翻页全部按 `name` 定位行，虚拟目录下会选错同名项** — `App.vue:1596/1680/1013` + `FilePanel.vue:2014/2016` · [明细](docs/todo-details/open-P1-004.md)
- [ ] **修复：`extractTargets` 用 `name` 建索引 Map 和判成员，搜索结果页解压顺序错乱** · [明细](docs/todo-details/open-P1-005.md)
- [ ] **修复：`closeTab` 的 `cancelSearch()` 是全局取消，会误杀另一面板正在跑的扫描** — `FilePanel.vue:588-593`（现址 `610-641`，cancel 在 `631`）+ `api.js:165-167` + `lib.rs:620-628` · [明细](docs/todo-details/open-P1-006.md)
- [ ] **修复：`search-batch` 用 `push(...hits)` 展开入参 + 上限判断在 push 之前** · [明细](docs/todo-details/open-P1-007.md)
- [ ] **修复：内容搜索对每个候选文件做三次全量拷贝（≤8MB × 3）** — `lib.rs:688/696/700`（现址 `file_contains` 在 `708-732`） · [明细](docs/todo-details/open-P1-008.md)
- [ ] **修复：搜索日志在遍历热路径上每次 `write + flush` 并持全局锁，且只 truncate 一次 → 日志成了遍历的主要开销、文件无限增长** — 现址 `search_log.rs:17/43-57/59-69` + `lib.rs:812/819/872/892/920`（原 782/842/890 已漂移） · [明细](docs/todo-details/open-P1-009.md)
- [ ] **修复：`window_state::flush` 持有 `state: Mutex` 跨越整段阻塞文件 IO → 拖动窗口掉帧** — 现址 `window_state.rs:223-231` + `107-134` + `observe:205-218` · [明细](docs/todo-details/open-P1-011.md)
- [ ] **修复：`delete_to_trash` 把所有失败一律映射成 `permission_denied`，提权重试陷入必然失败循环** — 现址 `lib.rs:1118-1142`（原 1104-1110 已漂移） · [明细](docs/todo-details/open-P1-012.md)
- [ ] **修复：CLI 解压/压缩路径没有任何超时 → 工具卡在密码提示上时调用线程永久阻塞** · [明细](docs/todo-details/open-P1-013.md)
- [ ] **修复：`rerunSearch` 的 searchId 用 `Date.now() % 1000000`，且重跑时不取消旧扫描** · [明细](docs/todo-details/open-P1-015.md)
- [ ] **修复：`switchTab` 不校验 id，`pendingSelectName` 跨 tab 残留** · [明细](docs/todo-details/open-P1-016.md)
- [ ] **修复：`dragOutTracker` 用大小写敏感的精确串比较，自拖出可能被判为外部拖入（move 变 copy）** · [明细](docs/todo-details/open-P1-017.md)
- [ ] **修复：`PathBar.segments` 给每个中间面包屑段加尾反斜杠，污染历史栈与持久化** · [明细](docs/todo-details/open-P1-018.md)
- [ ] **修复：`addBookmark` 不校验上限，`sanitize` 在加载时截断 → 重启后书签静默蒸发** · [明细](docs/todo-details/open-P1-021.md)
- [ ] **修复：`loadShortcuts` 对非数组覆盖值静默解绑命令，且无长度上限** — 改非数组时跳过该 key 回落默认值 + 加 `MAX_BINDINGS_PER_COMMAND`；~~`bindingsOf` 加 memo~~ 已判定不做 · [明细](docs/todo-details/open-P1-022.md)
- [ ] **修复：书签下拉每次打开对全部书签并发发起 `pathExists`（上限 200 条 IPC），且探测无序号守卫** · [明细](docs/todo-details/open-P1-023.md)
- [ ] **修复：`ContextMenu` 没有 Esc 处理，书签行右键菜单的 Esc 路径可证明不可达** · [明细](docs/todo-details/open-P1-024.md)
- [ ] **修复：`PathBar.onEnter` 的两次 IPC 全无 catch，失败时静默无反应 + unhandled rejection** · [明细](docs/todo-details/open-P1-025.md)
- [ ] **修复：`SearchDialog.onDone()` 在校验 searchId 之前就清掉了停止兜底定时器** — `SearchDialog.vue:325-337` · [明细](docs/todo-details/open-P1-027.md)
- [ ] **修复：`SearchDialog` 的 `hits` 无上限（后端多发时前端无界增长，「已达上限」提示不出现）** — 修法只做上限；~~`shallowRef` + `EXT_ICON` 拍 Map~~ 已判定不做 · [明细](docs/todo-details/open-P1-028.md)
- [ ] **修复：`scrollToRow` 每次按键仍 `querySelectorAll(".file-row")`，5000 行时每键实例化 5000 节点** — 改 `container.children[i]`；大列表其余三项微优化已判定不做 · [明细](docs/todo-details/open-P1-029.md)
- [ ] **修复：`subtitle` 探测每次切换视频都重扫整个目录 + 逐文件 IPC，且加载了所有匹配项而非只加载命中的那条** — `subtitleGate` 已把 `path` 透传，只差「按目录缓存 listDirectory」 · [明细](docs/todo-details/open-P1-030.md)

## P2 — 可维护性 / 重复实现 / 测试缺口

> 2026-11-04 审查：本节只保留「小修即可见效」的条目；一次性大重构（抽工厂、全量收敛、全量集成测试）已判不做，见 `TODO-done.md` 审计结论节。

- [ ] **收敛（缩小范围）：只合并已出现行为差异的重复实现** — `formatDate` 四份、`isArchiveName`/`getExt`/`leafName` 三份、`copyTextToClipboard` 三份、`isTypingTarget` 五份；不做 15+ 函数全量重构。先例：`formatSize` 8 份曾导致 >1TB 显示 `"undefined"` · [明细](docs/todo-details/open-P2-001.md)
- [ ] **收敛（缩小范围）：先修两处真实配置漂移，不抽 `configStore` 工厂** — ① `VideoPreview.savePlayerConfig` 的 catch 完全空 → 播放速度静默丢失；② `FilePanel.saveState` 缺防抖 · [明细](docs/todo-details/open-P2-002.md)
- [ ] **收敛（缩小范围）：`window_state` 两处 poison 的 `else { return }` 补日志即可** — 不统一全文件四种 Mutex 写法 · [明细](docs/todo-details/open-P2-003.md)
- [ ] **收敛：`home_dir()` 有两套实现、两种失败模式；`save_config` 与 `save_state` 是同一段系统 API 却一份原子一份不原子** — `lib.rs:192-207` vs `search_log.rs:19-25` · [明细](docs/todo-details/open-P2-004.md)
- [ ] **收敛：`shell_execute_elevated` 只解码了 1223，其余错误码原样抛给用户；`delete_with_admin` 静默吞掉全部结果** — `lib.rs:1263-1275` / `1499-1505` · [明细](docs/todo-details/open-P2-005.md)
- [ ] **收敛：`list_directory` / `collect_copy_tasks` 两处把整棵树一次性物化到 Vec，无上限无分批** — ⚠️ 明细已自证「搜索那条已修」（现为逐目录物化 + 边走边发），标题按复核结论改写 · [明细](docs/todo-details/open-P2-007.md)
- [ ] **收敛：复制路径上 5 个 `setTimeout` 未在卸载时清理** — `App.vue:715/720/747/825/1485` + `FilePanel.vue:288/1443` · [明细](docs/todo-details/open-P2-009.md)
- [ ] **收敛：`PathBar`/`FilePanel` 绕过 `paths.js` 直接拼绝对路径，其中两处硬编码 `\`** — 只修 Windows 实际场景，POSIX 全量收敛不做 · `App.vue:1249`、`FilePanel.vue:1463/1741/1122/1854` · [明细](docs/todo-details/open-P2-010.md)
- [ ] **收敛：`HandleNativeDrop` 手写 `destDir.replace(/\\/g,"/")` 绕过 `normDir`，盘符根目录下过滤器失效** — `App.vue:1434-1435` · [明细](docs/todo-details/open-P2-011.md)
- [ ] **收敛：配置持久化失败一律 `console.error`，用户完全无感** — `App.vue:419/662/873/943/1086` · [明细](docs/todo-details/open-P2-012.md)
- [ ] **低优先（一行）：`optimizeDeps.include` 漏了同样动态 `import()` 的 `@crabnebula/tauri-plugin-drag`** — 只在 dev 首次拖出时重载一次，非用户问题；`vite.config.mjs:22-25` 现只有 mammoth + libheif · [明细](docs/todo-details/open-P2-013.md)
- [ ] **收敛：`SearchDialog.onListKeydown` 整块硬编码 key 且从不 `markHandled`** — `SearchDialog.vue:266-292` · [明细](docs/todo-details/open-P2-014.md)
- [ ] **收敛：`Esc` 的捕获阶段竞争 —— VideoPreview 的 window-capture 抢在 SearchDialog 的 document-capture 之前** — `VideoPreview.vue:566-575` vs `SearchDialog.vue:541-546/554` · [明细](docs/todo-details/open-P2-015.md)
- [ ] **收敛：`ContextMenu.menuStyle` 在 computed 里读非响应式的 `window.inner*`，高度估算忽略分隔条** — `ContextMenu.vue:46-60` · [明细](docs/todo-details/open-P2-016.md)
- [ ] **收敛：`ensureVisible()` 直接写 `scrollTop` 与 scrollTop ref 之间差一帧** — `SearchDialog.vue:247-264` · [明细](docs/todo-details/open-P2-017.md)
- [ ] **收敛：列宽拖拽的 window 监听器在组件卸载时不会移除（注释与实现相反）** — `FileList.vue:1396-1419` vs `1351-1357` · [明细](docs/todo-details/open-P2-018.md)
- [ ] **收敛：`videoPreviewAlwaysOnTop` 的默认值在 App.vue 与 GeneralSettingsDialog 各存一份，仅靠注释约束同步** — `App.vue:330` vs `GeneralSettingsDialog.vue:78-84` · [明细](docs/todo-details/open-P2-020.md)
- [ ] **测试缺口（缩小范围）：只补 `plan_overwrite` 表驱动 9 组合** — src 目录/文件 × dest 不存在/目录/文件 × overwrite 真/假；`move_items` 集成测试等全量覆盖不做 · [明细](docs/todo-details/open-P2-022.md)

### 由 P1 降级（2026-11-04 审查：触发条件罕见 / 影响被夸大）

- [ ] **修复（一行）：`list_drives` 一次 panic 永久毒化驱动器缓存** — `.lock()` 对齐同文件 7 处的 `unwrap_or_else(|e| e.into_inner())`；⚠️ 「持锁跨探测」是 `lib.rs:235-240` 注释与 INTERNALS.md 写明的有意设计，不是 bug，不改 · [明细](docs/todo-details/open-P1-010.md)
- [ ] **修复：`parentDirOf` 把盘符根算成有父级，`App.vue:1276/1630` 的盘根 no-op 漏过滤** — 原 P1-019 的另两条后果（marked 误判、sanitize 空串去重）已被现有守卫挡住，不成立 · [明细](docs/todo-details/open-P1-019.md)
- [ ] **修复：`theme.json` 零类型校验 + `setTheme` 把垃圾值写回磁盘形成永久损坏** — 拆 `applyTheme`（纯 DOM）/ `persistTheme`；触发前提是 `~/.minitc` 被手改或损坏 · [明细](docs/todo-details/open-P1-020.md)
- [ ] **低优先：帧检测兜底路径仍用全分辨率 `getImageData`** — 只在 `requestVideoFrameCallback` 2 秒无回调时执行，正常播放不走（原 P1-031 标题「每次播放」夸大）；缩到 32px 宽即可 · [明细](docs/todo-details/open-P1-031.md)
