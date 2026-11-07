# 已知问题与限制

收录**已确认、且短期不会在应用层修**的行为：平台或依赖自身的限制、需要重写整套实现才能绕过的问题、实测判定不做的方案。

- 待修的 bug 在 [TODO.md](TODO.md)，这里不重复清单。
- 功能说明在 [README.md](README.md)，README 只留一个入口，不摊开细节。
- 新增条目请写清「现象 / 原因 / 验证经过 / 结论 / 变通」，尤其记下**试过且证伪**的方案，避免下次照着现象重做一遍。

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
