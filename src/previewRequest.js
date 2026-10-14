// 一次「打开预览」请求的目的地快照，以及它现在还能不能落地的判据。
//
// 背景：App.vue 里驱动预览的四个入口（选中项 watcher、activePanel watcher、
// playNextVideo、showFilePreview 本身）都要先 `await entryPath(entry, dir)`
// 把条目解析成绝对路径，才能写 preview* 状态。那次 await 是 IPC 往返，而在此
// 期间用户完全可以连按 ↓ 翻页、切面板、进别的目录、甚至按 Esc 关掉预览。
// 无条件落地 = 界面显示上一个文件（标题是 B、内容是 A），或者把预览挂到用户
// 已经离开的那一侧。
//
// 判据是「目的地还是不是它」，不是请求序号：序号与同 key 折叠互斥，A→B→A 快速
// 翻页会让谁都不落地（同 loadGate.js / previewGate.js 顶部那条）。快照回答的是
// 「这份结果服务的那一行，现在还是不是当前选中项」—— 折返回 A 时迟到的第一个 A
// 依然可以落地，这正是对的。
//
// 纯逻辑，不碰 Vue / IPC，可直接 `node scripts/preview-request.test.mjs` 跑。

import { entryKey } from "./paths.js";

/// 快照一份「用户当时要预览的那一行」。
///
/// `panelId` 是源面板（预览总是挂在对面板），`activePanelId` 单列出来是因为
/// 两个 watcher 只对活动面板生效 —— 源面板没变但活动面板切走了，同样是「目的地
/// 已经不是你以为的那个」。
export function makePreviewRequest({ panelId, activePanelId, dir, entry } = {}) {
  return {
    panelId: panelId || "",
    activePanelId: activePanelId || "",
    dir: dir || "",
    key: entry ? entryKey(entry) : "",
  };
}

/// 这份请求的结果现在还能不能写进界面。四个字段全等才算 —— 少比一个就等于把
/// 一种真实存在的用户操作（翻页 / 切面板 / 换目录）当成「没变」。
///
/// 快照里没有条目（`key === ""`）一律作废：那是「面板此刻没有选中项」，例如
/// 导航后选中被清空。空快照与空快照当然彼此相等，让它返回 true 等于把
/// 「什么都没有」当成「目的地没变」—— 调用点自己也会因此打开一个空预览。
export function previewRequestLands(request, current) {
  if (!request || !current) return false;
  if (!request.key || !current.key) return false;
  if (request.panelId !== current.panelId) return false;
  if (request.activePanelId !== current.activePanelId) return false;
  if (request.dir !== current.dir) return false;
  if (request.key !== current.key) return false;
  return true;
}
