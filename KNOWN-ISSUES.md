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
