// 画中画请求的就绪判据与等待意图的落地判据。
//
// requestPictureInPicture() 在 <video> 的 readyState 是 HAVE_NOTHING 或没有
// 视频轨时抛 InvalidStateError；同时它要求 transient user activation（Chrome
// 约 5 秒窗口）。所以「视频刚打开就点画中画」不能改成异步事件回调里重试 ——
// 那样手势可能已过期。正确做法是在**同一次点击的 await 链里**等就绪，
// 并在 await 回来后用「目的地判据」确认用户没在等待期间切到别的视频。

/** 拿到 metadata 且确实有画面才能请求 PiP；纯函数供单测。 */
export function videoReadyForPip(readyState, videoWidth) {
  return readyState >= 1 && videoWidth > 0;
}

/**
 * await 回来后，意图只对点击那一刻的那个文件有效。
 * 换片（自动连播 / 手动切）即作废，否则会在新视频上突然弹出小窗。
 */
export function pipIntentLands(intentPath, currentPath) {
  return intentPath !== null && intentPath !== undefined && intentPath === currentPath;
}

/**
 * 在用户手势的时间窗口内等视频就绪。ctx.cancelled 让用户再点一次能取消等待。
 * 事件 + 轮询双保险：metadata 可能在监听器挂上前就已到达。
 */
export function waitForVideoReady(video, ctx, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const pollMs = opts.pollMs ?? 50;
  const onReady = opts.onReady ?? videoReadyForPip;
  if (onReady(video.readyState, video.videoWidth)) {
    return Promise.resolve({ ok: true, reason: "ready" });
  }
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    let poll = 0;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("canplay", check);
      resolve(result);
    };
    function check() {
      if (ctx.cancelled) { finish({ ok: false, reason: "cancelled" }); return; }
      if (onReady(video.readyState, video.videoWidth)) finish({ ok: true, reason: "ready" });
    }
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("canplay", check);
    poll = setInterval(check, pollMs);
    timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
  });
}
