// 视频自动续播的「授权 / 消费」闸门。
//
// 背景：`ended` 之后要不要换到下一条，是**父组件**（App.playNextVideo）决定的
// —— 它有一串提前 return（预览已关 / 非视频 / 无当前名 / 已是最后一条 / 无目录）。
// 早期实现由子组件 onEnded 自己把 `pendingAutoplay` 置真，于是父组件一旦拒绝，
// 这个标志就永远悬着；用户随后手动点选**任何另一个**视频，它的
// onLoadedMetadata 都会看到标志为真并自动播放。
//
// 关键：**加路径校验拦不住**。手动选的路径当然和刚播完那条不同，校验只会把
// 「立刻播」变成「换一个照样播」。真正的修法是反转置位方向 —— 只有父组件在
// 真正决定要续播时才 arm，子组件在**每次**加载的共同入口消费一次。消费必然
// 发生，所以标志无法跨过一次加载存活。
//
// 为什么是模块级单例而不是组件内实例 / props：App 里两个 <VideoPreview> 由
// v-else-if 互斥渲染，任意时刻只有一个存活，autorun 的「下一次加载是不是
// 续播」是**进程内唯一一件事**，做成单例最直白，也免掉 App 侧拿组件 ref。
// 与 dragState.js 同一形态。

export function createAutoplayGate() {
  // 待消费的授权：本次续播的目标绝对路径（null = 无授权）。
  let armed = null;

  return {
    /**
     * 置位授权。**只有父组件**在已经解析出下一条、即将切换时才调。
     * 重复 arm 覆盖前一个 —— 权威数据源是「父组件此刻的意图」，不是历史。
     */
    arm(path) {
      armed = path ? String(path) : null;
    },

    /**
     * 消费授权。在**每次**加载开始时调用，返回「本次加载是否应当自动起播」。
     * 无论是否命中都清除 armed —— 否则「置位了但没真换文件」（如下一条是
     * WebView 解不了的格式，loadVideo 提前返回）会把标志留给下一次手动选择。
     */
    claim(path) {
      const p = path ? String(path) : "";
      const ok = armed !== null && armed === p;
      armed = null;
      return ok;
    },

    /** 当前是否持有未消费的授权（测试 / 调试用）。 */
    isArmed() {
      return armed !== null;
    },
  };
}

/** 全应用共享的续播闸门（见上方「为什么是模块级单例」）。 */
export const autoplayGate = createAutoplayGate();
