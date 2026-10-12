// 预览加载的并发守卫：一次预览请求的结果，只有当「用户要看的还是这个文件」时
// 才允许写进界面。
//
// 病根与 FilePanel 的 `loadGate.js` 同源：HEIC 一次 decode + encode 要几百毫秒，
// 快速按 ↓ 翻文件时先发的 A 必然晚于后发的 B，于是 A 覆盖 B —— 标题写着 B、
// 内容是 A，`previewContent`/`previewType`/`fileSize` 全被写歪。
//
// 判据同样不用「请求序号」而用「目的地还是不是它」：序号与「同 key 折叠」互斥
// 会导致谁都不落地（详见 loadGate.js 顶部）。这里更简单 —— 判据就是
// `props.filePath` 现在指向谁。
//
// 纯逻辑，不碰 Vue / IPC，可直接 `node scripts/preview-gate.test.mjs` 跑。

/**
 * @param {string} requestedPath 本次请求开始时预览的文件路径
 * @param {string} currentPath    现在 props.filePath 指向的路径
 * @returns {boolean} 结果是否仍可落地
 */
export function previewLands(requestedPath, currentPath) {
  return requestedPath === currentPath;
}