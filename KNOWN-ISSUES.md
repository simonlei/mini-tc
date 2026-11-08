# 已知问题与限制

收录**已确认、且短期不会在应用层修**的行为：平台或依赖自身的限制、需要重写整套实现才能绕过的问题、实测判定不做的方案。

- 功能说明在 [README.md](README.md)，README 只留一个入口，不摊开细节。
- 新增条目请写清「现象 / 原因 / 验证经过 / 结论 / 变通」，尤其记下**试过且证伪**的方案，避免下次照着现象重做一遍。

## CI 发布时 NSIS 工具链下载偶发 504

**平台**：Windows / macOS（GitHub Actions）
**状态**：2026-11-08 已定位并绕过（预取步骤），根因在 Tauri 上游

### 现象

打 tag 触发发布，Windows 平台构建到最后一步（打包）失败：

```
Finished `release` profile [optimized] target(s) in 6m 38s
Info Verifying NSIS package
Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
Error failed to bundle project: `http status: 504`
```

6 分半的 Rust 编译全部作废。重跑一次，失败点会漂移到另一个文件（先 `nsis-3.11.zip`，后 `nsis_tauri_utils.dll`）。

### 原因

`tauri-bundler`（`@tauri-apps/cli` 2.11.4 内置 2.9.4）在**打包这一步**才去 GitHub Release 下载 NSIS 工具链，且是**单次请求、零重试**。GitHub 资源 CDN 偶发 504 时没有任何回退，直接让整个构建失败。

失败点在两个文件之间漂移，说明是链路抖动而不是某个文件缺失或被删 —— 这也是判断依据：若文件真的没了，失败点会稳定在同一个文件上。

### 验证经过

- 本机复现同一 URL，直连连续 5 次全部 504（同一份 92 字节的「504 Gateway Time-out」HTML 响应体），换镜像则 200 且 SHA1 与官方一致 —— 确认是链路问题，不是文件问题。
- 读了 `tauri-bundler 2.9.4` 的 `bundle/windows/nsis/mod.rs`：下载走 `download_and_verify()`，内部是单次 `ureq` GET，无重试；且下载发生在 `bundle_project()` 里，即编译完成之后。
- 确认 bundler 有 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` 这个换源开关，但它只换源、同样不重试，单独用不能解决。
- 确认 bundler 的检查逻辑：目录存在 + 必需文件齐全 + 插件 DLL 哈希正确，则完全跳过下载。所以只要提前把工具链放到正确位置即可绕过。

### 结论

**这是 Tauri 上游的问题**（打包期下载无重试），本仓库用预取步骤绕过：`.github/workflows/release.yml` 在 `npm ci` 之后先跑 `scripts/ci/prefetch-nsis-toolchain.mjs`，把工具链下好、按 bundler 自己的 SHA1 校验、放到 bundler 期望的位置。

实现细节见 [INTERNALS.md 的「CI 上的 NSIS 工具链预取」](INTERNALS.md#ci-上的-nsis-工具链预取)。

### 变通

预取脚本自带重试与镜像回退；且**失败只告警不中断** —— 预取失败时 bundler 仍会自己尝试官方源，不会把本来能过的构建搞挂。

若将来上游修好了（bundler 自带重试），可以删掉这个预取步骤；判断依据是 `release.yml` 里不再出现 `Verifying NSIS package`。

## 画中画小窗标题无法改成文件名

**平台**：Windows / WebView2（Chromium）
**状态**：2026-11-07 实测确认，按「接受现状」结案

### 现象

视频预览点「画中画」后，期望小窗标题显示当前视频文件名、连播换片时跟着更新，实际是：

- 小窗内部标题栏：来源 host `tauri.localhost`
- 任务栏 / Alt-Tab 窗口名：本地化的「画中画」

### 原因

PiP 小窗由浏览器进程自绘：内部那行取 opener 的 host，窗口名取固定的本地化字符串。两者都不读页面的 `document.title`，也不读 `navigator.mediaSession.metadata`。

### 试过且证伪

PiP 期间把 `document.title` 设为文件名，并写 `MediaMetadata({ title: fileName })`；进入、离开、请求失败回滚、关闭、卸载、连播换片各同步点都覆盖，还用 token 判据处理两个预览实例共用一个 `document.title` 的归属问题。实测小窗两处文字都没变。

相关代码（`src/pipTitle.js` 及两个 `pip-title-*` 测试脚本）已删除。`scripts/pip-ready-check.mjs` 留了一组反向静态断言，`scripts/pip-ready-mutation.mjs` 配了对应的回归变异，防止这段死代码被加回来；将来真要动标题方案，先删这套断言。

### 仍未做的路线

1. **后端 Win32 枚举 PiP 窗口调 `SetWindowTextW`**：只能改任务栏 / Alt-Tab，小窗内部仍是 `tauri.localhost`；Chromium 可能重设标题，需要持续守护。
2. **弃用原生画中画，自建独立置顶 `WebviewWindow` 播放页**：两处都能显示文件名，代价是重写播放器与进度同步。

两条都因收益与成本不匹配暂不做。

### 变通

无。文件名在主预览面板可见。

## Windows 安装包首次运行被 SmartScreen 拦截

**平台**：Windows
**状态**：长期存在，等代码签名证书

### 现象

打开 `x64-setup.exe` 时，Microsoft Defender SmartScreen 提示「已保护你的电脑 / 发布者未知」。

### 原因

安装包没有购买代码签名证书。安装包由 [GitHub Actions](https://github.com/simonlei/mini-tc/actions) 公开构建，构建记录可核对，但 SmartScreen 的发布者声誉只认签名。

### 处理

点 **更多信息 → 仍要运行**。

### 不做

购买代码签名证书是发布成本决策，不是代码问题；在此之前不改。

## Defender 把 mini-tc.exe 误报为 Bearfoos 木马

**平台**：Windows
**状态**：2026-11-07 取证结案，判定为 Microsoft Defender 机器学习启发式误报

### 现象

`D:\Soft\MiniTC\mini-tc.exe` 被报 `Trojan:Win32/Bearfoos.A!ml` / `B!ml`（严重、特洛伊木马），Defender 尝试隔离。重装或换版本后消失，下一次自动更新又出现。报毒对象的路径始终是安装目录里的主 exe。

### 原因

`!ml` 是 Defender 的机器学习判定，不是命中已知病毒特征码。触发链：

`CI 发版 → 应用内 updater 把未签名安装包下载到 %TEMP% → installMode: passive 静默执行 → 覆盖写一个全新哈希、未签名的 exe → 实时保护对 first-seen 文件做 ML 打分 → Bearfoos`

安装包和主 exe 都没有 Authenticode 签名（见上一条），ML 模型没有正向信誉信号；程序本身又带提权、调用 PowerShell 删除、写卸载注册表、后台下载静默安装等高危特征。安全智能版本从 1.459.554.0 升到 1.463.166.0 期间模型换版，威胁名也从 `A!ml` 漂到 `B!ml`。

### 试过且证伪

- **「重新下载换到了干净包」证伪**：两次下载的 `MiniTC_0.2.10_x64-setup.exe` 大小同为 3,911,832 字节，SHA256 都是 `01DFA28D…B99C`，字节完全相同。
- **「换成 Supabase 分发才引入」证伪**：10/05 15:05 已报 `A!ml`，当时通道仍是腾讯云 COS；切换提交 `713e06f` 在 11/06 12:56。切换 diff 只改上传工具（coscli → aws s3）与 URL，没动构建参数、minisign 签名或 installMode。
- **「Supabase 共享子域信誉差」证伪**：`%TEMP%` 里 09/04 ~ 11/07 的 20 个 updater 安装包横跨两个通道，`Zone.Identifier` 全部为空，Defender 看不到来源域名。浏览器手动下载才带 `HostUrl=*.supabase.co` 的 MOTW，那是另一条路径。
- **「更新包被投毒」证伪**：`latest.json` 各平台都带 minisign 签名，updater 验签通过才会执行。
- **真正相关**：切换后 3 天连发 0.2.8 / 0.2.9 / 0.2.10 / 0.2.11 四个全新哈希，等于 4 次 first-seen 判定机会；叠加病毒库换版，所以看起来像「换通道后才开始报」。

### 结论

误报，不是源码里被塞了木马，也不是下载链路被污染。11/07 21:43 那次 Defender 报「隔离」但错误码 `0x80508023`（找不到恶意软件），实际没删掉文件，只是把那次自动更新打断了。

### 变通

1. 到 `https://www.microsoft.com/wdsi/filesubmission` 选 **Software developer** 提交误报复核，附检测名、安全智能版本、主 exe 与安装包的 SHA256。这是撤销 ML 判定的官方通道。
2. 临时绕开：改为手动下载安装，不走应用内自动更新（报毒集中在 updater 这条链路）；管理员加 Defender 排除路径只作短期方案。
3. 用 Release 的同名 `.sha256` / `SHA256SUMS.txt` 核对下载物字节。
4. 根治仍是购买 Authenticode 代码签名证书，见上一条。

## 提权删除改成 Win32 API 降特征（判定不做）

**平台**：Windows
**状态**：2026-11-07 代码取证，判定不做

### 现象 / 动机

Defender 误报时，曾考虑把 `delete_with_admin` 里「提权启动 `powershell.exe` 跑 `Remove-Item -Recurse -Force`」换成 Rust 直接调 Win32 删除 API，以减少 ML 高危特征。

### 证伪经过

- `delete_with_admin`（`lib.rs:2580`）的语义是**普通删除失败后，用管理员权限删只读 / 系统 / 无权限的文件**，靠 `ShellExecuteW` 的 `runas` 动词弹 UAC 后启动提权的 PowerShell。改成当前进程里直接调 `DeleteFileW` / `RemoveDirectoryW`，进程仍是标准用户权限，对原本就删不掉的文件照样失败 —— 等于把功能改没了。
- 自举提权（`runas` 启动自身 + `--elevated-delete <path>`，复用项目已有的 `remove_link_or_tree()`）能保住权限，也顺带避开 `-Recurse -Force` 对目录 symlink 会删链接目标的隐患，但仍是 `runas` 启动 exe，去掉的只是 `powershell.exe` 一个字符串；还要在 Tauri 初始化前拦截 CLI 参数、处理路径转义与提权进程退出码。
- 该改动涉及 UAC 提权与 Windows 文件系统语义，按项目判据必须本机实测；本环境无法端到端验证（UAC 交互、构建由用户自管），不交付未经验证的删除逻辑重写。

### 结论

不做。`powershell.exe` 只是众多 ML 特征之一，主因是**未签名 + 全新哈希 + 从 %TEMP% 静默覆盖写 exe**；去掉它对判定影响有限，却要承担删除功能回归的风险。降特征优先走代码签名与误报复核。

### 变通

`RUST.md` 已记录这条提权路径的两个真实问题：`-ErrorAction SilentlyContinue` 导致失败无任何提示、`-Recurse -Force` 对目录 symlink 会遍历删除链接目标。将来若真要重写提权删除，先写复现脚本实测这两条，再连同自举方案一起做。

## 已复核判定不做的代码问题（2026-11-08 归档）

下面这些是 code review 找出、逐条复核后判定**不值得改**的问题。留着结论是为了避免下次 review 又把它们当成新发现再提一遍 —— 记的是「为什么不做」，代码本身没有改动。

| 问题 | 判定不做的理由 |
|---|---|
| `list_drives` 在全局锁内跑完 A–Z 探测 | `lib.rs` 注释与 INTERNALS 均论证为有意权衡：避免两块面板同 tick 重复全量探测。照「修」反而引入两次探测窗口 |
| `preloadOtherTabs` 的 `tabCache` 从不淘汰 | 明细自算 10 tab × 5 万条 ≈ 数十 MB 常驻，且切回时本就丢弃重来；桌面应用可接受 |
| 复制路径上的死参数、重复分配、重复 stat | 单条都不致命，收益仅为「与文件性能取向自相矛盾」 |
| `SearchDialog` 的 `hits` 深度响应式 / `iconOf` 每行 `Object.keys` | 渲染微优化；`hits` 无上限那半已单独立项 |
| 大列表热路径的 `getFileIcon` 对象、`Intl` formatter、排序比较器 | 教科书式微优化，仅 5000 行极端目录才有意义 |
| `emit_progress` 丢弃 emit 错误 | 只在窗口正在关闭 / webview 崩了时复制没进度，边缘 |
| 统一全文件四种 Mutex 中毒写法 | 洁癖；仅 `window_state` 两处静默 return 补日志值得做 |
| `SearchDialog.onMounted` 的 `await listen()` 期间卸载导致监听器泄漏 | 需「打开后几毫秒内关闭」的极窄窗口 |
| POSIX 根目录 / 硬编码反斜杠的全量跨平台收敛 | Windows 单机使用，收益低；盘符根过滤器失效等实际场景已单独立项 |
| `.vp-buttons` 在同一个 `<style scoped>` 写两遍 | 当前零 bug，样式层叠侥幸正常；可直接合并，不占条目 |
| `bindingsOf` 每次按键重建数组 / 加 memo | 一次按键约 20 次 map + normalize，纳秒级；「非数组静默解绑 + 无上限」那半已单独立项 |
| 抽 `configStore` 工厂统一 10 处 config | 只修两处真实漂移（空 catch / 缺防抖），不值得为一致性抽工厂 |
| 15+ 个重复函数的全量收敛 | 只合并已出现行为差异的；`formatSize` 8 份曾导致 >1TB 显示 `"undefined"`，是唯一值得动过的先例 |
| 数据丢失路径全量集成测试 | 只补 `plan_overwrite` 表驱动 9 组合 |

判断标准：**改动风险 > 用户可感收益**的一律不做；只有能具体说出「用户会遇到什么」的才立项。
