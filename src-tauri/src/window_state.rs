//! 窗口状态（位置 / 大小 / 最大化 / 全屏）持久化。
//!
//! 存在 `~/.minitc/window-state.json`，在 `setup` 阶段（窗口已创建、事件循环
//! 尚未启动）读取并套用，配合 `tauri.conf.json` 里的 `visible: false` 实现
//! 「打开即是上次的窗口」，不会先闪一下默认尺寸再跳过去。
//!
//! 三个容易踩的点都在这里处理了：
//!
//! 1. **最大化 / 全屏 / 最小化时读到的几何是系统接管后的值**（全屏时等于
//!    整块屏幕，最小化时 Windows 给的是 iconic 偏移 -32000）。原样存下来，
//!    下次「还原」就会得到一个全屏尺寸、或者完全拖不回来的窗口。所以这三
//!    种状态下只更新标志位，几何保持最后一次普通态的值。
//! 2. **显示器会变**。保存的位置可能落在已经拔掉的外接屏上，恢复后窗口就在
//!    屏幕外。`resolve` 会检查交集，且要求交集盖住标题栏（用户抓得到才拖得
//!    回来），否则回退到居中。
//! 3. **拖动 / 缩放时 Moved / Resized 是高频事件**（每秒几十次），每次都写
//!    JSON 会把主线程 IO 拖垮。只保留最后一次变化，由后台线程按固定节奏落盘，
//!    关闭时再强制同步一次。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, Monitor, PhysicalPosition, PhysicalSize, WindowEvent};

const MAIN_WINDOW: &str = "main";

/// 与 `tauri.conf.json` 的 `minWidth` / `minHeight` 保持一致。
const MIN_WIDTH: u32 = 800;
const MIN_HEIGHT: u32 = 500;

/// 交集顶端必须落进窗口顶部这么多物理像素内，才认为这个位置「还能被抓住」。
/// 低于这个值说明标题栏在屏幕外，窗口只剩一截边露在外面，用户既拖不动也
/// 双击不到。
const TITLEBAR_REACH: i32 = 30;

/// 落盘轮询间隔。取 400ms：拖动窗口时最新几何最多丢 0.4s（下次移动/缩放/
/// 关闭时立刻补上），但把高频事件压成每秒 2.5 次写盘。
const FLUSH_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
            maximized: false,
            fullscreen: false,
        }
    }
}

/// 后台落盘线程与事件回调之间共享的状态。
struct Shared {
    /// 当前应该被持久化的几何。「普通态」下的真实值 + 最新标志位。
    state: Mutex<WindowState>,
    /// 几何自上次落盘后是否变过。用来把高频事件合并成一次写。
    dirty: AtomicBool,
}

/// dev 与 release 的窗口尺寸差异很大（dev 往往被拖成半屏），共用一个文件
/// 会让正式版的布局被调试过程污染，所以分开存。
fn state_path() -> Option<PathBuf> {
    let name = if cfg!(debug_assertions) {
        "window-state-dev.json"
    } else {
        "window-state.json"
    };
    Some(crate::home_dir()?.join(".minitc").join(name))
}

fn load_state() -> Option<WindowState> {
    let path = state_path()?;
    let raw = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<WindowState>(&raw) {
        // 宽高为 0 说明读到的是一份坏数据（正常 outer_size 不会返回 0），
        // 按「没有历史」处理，走默认布局。
        Ok(st) if st.width > 0 && st.height > 0 => Some(st),
        Ok(st) => {
            crate::debug_log(&format!(
                "window-state: ignoring degenerate size {}x{}",
                st.width, st.height
            ));
            None
        }
        Err(e) => {
            crate::debug_log(&format!("window-state: parse failed: {}", e));
            None
        }
    }
}

fn save_state(st: &WindowState) {
    let Some(path) = state_path() else {
        return;
    };
    let Some(dir) = path.parent() else {
        return;
    };
    if let Err(e) = fs::create_dir_all(dir) {
        crate::debug_log(&format!("window-state: mkdir failed: {}", e));
        return;
    }
    let Ok(body) = serde_json::to_string(st) else {
        return;
    };

    // 先写临时文件再改名：崩溃 / 断电时不会留下半截 JSON，下次启动仍能用
    // 上一份好状态。Windows 上 rename 不能覆盖已存在的目标，必须先删。
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, body) {
        crate::debug_log(&format!("window-state: write tmp failed: {}", e));
        return;
    }
    let _ = fs::remove_file(&path);
    if let Err(e) = fs::rename(&tmp, &path) {
        crate::debug_log(&format!("window-state: rename failed: {}", e));
        let _ = fs::remove_file(&tmp);
    }
}

/// 一块屏幕的工作区，纯数据形态。抽出来是为了让 `resolve` 能在没有真实
/// 显示器（`Monitor` 只能由窗口系统构造）的单元测试里被验证。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl From<&Monitor> for WorkArea {
    fn from(m: &Monitor) -> Self {
        let wa = m.work_area();
        Self {
            x: wa.position.x,
            y: wa.position.y,
            width: wa.size.width,
            height: wa.size.height,
        }
    }
}

/// 把保存的几何映射回**当前**屏幕布局。
///
/// 返回 `None` 表示保存的位置已经不可用（外接屏拔了、分辨率改了），调用方
/// 应回退到居中。命中时顺带把尺寸夹到 `[最小尺寸, 所在屏工作区大小]`。
fn resolve(areas: &[WorkArea], st: &WindowState) -> Option<(i32, i32, u32, u32)> {
    // 找与窗口矩形交集最大的那块屏。`u64` 乘法先转，避免 i32 溢出。
    let (_, mw, mh) = areas
        .iter()
        .filter_map(|wa| {
            let mw = wa.width as i32;
            let mh = wa.height as i32;

            // 交集宽高，任一为负/零即不相交。
            let ix = (st.x + st.width as i32).min(wa.x + mw) - st.x.max(wa.x);
            let iy = (st.y + st.height as i32).min(wa.y + mh) - st.y.max(wa.y);
            if ix <= 0 || iy <= 0 {
                return None;
            }
            // 整条标题栏必须落在工作区竖直范围内。少了这个判断，窗口压在
            // 屏幕下沿只露 20px 时会被当成「可见」而原样恢复 —— 但用户既
            // 抓不住标题栏（拖不回来），也双击不到（最大化不了）。
            //
            // 注意不能只看交集的顶端：窗口整体在屏幕下方时交集顶端就是它
            // 自己，任何容差都恒成立，等于没检查。所以显式要求标题栏的上沿
            // 不高于工作区顶边、下沿不高于工作区底边。
            if st.y < wa.y || st.y + TITLEBAR_REACH > wa.y + mh {
                return None;
            }
            Some((ix as u64 * iy as u64, mw, mh))
        })
        .max_by_key(|t| t.0)?;

    // 屏幕比最小尺寸还小（极端的竖屏小窗）时 max 会顶出屏幕，但那样
    // 反而比看不见强，交给 tauri 的 minWidth 约束兜底。
    let width = st.width.min(mw as u32).max(MIN_WIDTH);
    let height = st.height.min(mh as u32).max(MIN_HEIGHT);
    Some((st.x, st.y, width, height))
}

/// 事件回调 / 初始化共用的「读当前窗口 → 更新内存态」逻辑。
fn observe<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, shared: &Shared) {
    let minimized = window.is_minimized().unwrap_or(false);
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);

    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };

    let Ok(mut guard) = shared.state.lock() else {
        return;
    };

    // 见模块注释第 1 点：这三态下 outer_position / inner_size 不可信。
    if !minimized && !maximized && !fullscreen && size.width > 0 && size.height > 0 {
        guard.x = pos.x;
        guard.y = pos.y;
        guard.width = size.width;
        guard.height = size.height;
    }
    guard.maximized = maximized;
    guard.fullscreen = fullscreen;
    drop(guard);

    shared.dirty.store(true, Ordering::Relaxed);
}

fn flush(shared: &Shared) {
    if !shared.dirty.swap(false, Ordering::Relaxed) {
        return;
    }
    let Ok(guard) = shared.state.lock() else {
        return;
    };
    save_state(&guard);
}

fn spawn_flusher(shared: Arc<Shared>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);
        flush(&shared);
    });
}

/// 读取上次状态并套用到主窗口，然后开始跟踪变化。必须在 `setup` 里调用。
///
/// 兜底原则：`tauri.conf.json` 里窗口是 `visible: false`（为了避免先闪一下
/// 默认尺寸再跳到存档位置），所以**任何提前返回都必须先把窗口点亮**，
/// 否则窗口永不出现、用户以为程序没启动。`window_by_label` 拿不到窗口时
/// 退回到「显示所有窗口」，保证可见性不依赖本模块的成功。
pub fn install<R: tauri::Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        crate::debug_log("window-state: main window missing, showing all");
        for (_, w) in app.webview_windows() {
            let _ = w.show();
        }
        return;
    };

    let saved = load_state();

    // 恢复顺序有讲究：先摆普通态几何，再叠加最大化 / 全屏。反过来的话
    // maximize() 会用它自己的工作区尺寸覆盖掉刚设好的 size，于是「还原」
    // 之后得到一个全屏大小的窗口。
    let mut applied = false;
    if let Some(st) = saved.as_ref() {
        if let Ok(monitors) = window.available_monitors() {
            let areas: Vec<WorkArea> = monitors.iter().map(WorkArea::from).collect();
            match resolve(&areas, st) {
                Some((x, y, w, h)) => {
                    let _ = window.set_size(PhysicalSize::new(w, h));
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                    applied = true;
                }
                None => {
                    crate::debug_log("window-state: saved position off-screen, centering");
                }
            }
        }
        // fullscreen 与 maximized 互斥，全屏优先。
        if st.fullscreen {
            let _ = window.set_fullscreen(true);
            applied = true;
        } else if st.maximized {
            let _ = window.maximize();
            applied = true;
        }
    }
    if !applied {
        let _ = window.center();
    }

    // 初始内存态：没有历史就以窗口当前几何为基线，避免第一次 flush 把
    // 未初始化的默认值写回去。
    let baseline = saved.unwrap_or_else(|| WindowState {
        x: window.outer_position().map(|p| p.x).unwrap_or(0),
        y: window.outer_position().map(|p| p.y).unwrap_or(0),
        width: window.inner_size().map(|s| s.width).unwrap_or(1200),
        height: window.inner_size().map(|s| s.height).unwrap_or(800),
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    });

    let shared = Arc::new(Shared {
        state: Mutex::new(baseline),
        dirty: AtomicBool::new(false),
    });

    {
        let shared = Arc::clone(&shared);
        let win = window.clone();
        window.on_window_event(move |event| match event {
            // 跨屏会同时触发 ScaleFactorChanged（Windows 上改 DPI 缩放也
            // 会触发），此时几何变了，必须一起采样。
            WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. } => observe(&win, &shared),
            // 关闭是最后一次机会：必须同步落盘，不能指望后台线程的下一拍
            // ——进程可能已经没了。
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => flush(&shared),
            _ => {}
        });
    }

    // 无论恢复成功与否都要显示，否则 `visible: false` 会让窗口永远不出现。
    let _ = window.show();

    spawn_flusher(shared);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, width: u32, height: u32) -> WorkArea {
        WorkArea {
            x,
            y,
            width,
            height,
        }
    }

    fn state(x: i32, y: i32, width: u32, height: u32) -> WindowState {
        WindowState {
            x,
            y,
            width,
            height,
            ..Default::default()
        }
    }

    const LAPTOP: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    /// 笔记本右侧的外接屏。
    const EXTERNAL: WorkArea = WorkArea {
        x: 1920,
        y: 0,
        width: 2560,
        height: 1400,
    };

    #[test]
    fn restores_position_verbatim_when_fully_visible() {
        let got = resolve(&[LAPTOP], &state(300, 200, 1200, 800)).expect("on-screen");
        assert_eq!(got, (300, 200, 1200, 800));
    }

    #[test]
    fn keeps_negative_coords_on_left_of_primary_monitor() {
        // 主屏左侧接了一台更窄的屏，窗口整个落在它上面，x/y 为负是正常的。
        let left = area(-1280, 0, 1280, 1024);
        let got = resolve(&[LAPTOP, left], &state(-1200, 100, 1000, 700)).expect("on-screen");
        assert_eq!(got, (-1200, 100, 1000, 700));
    }

    #[test]
    fn falls_back_when_saved_monitor_is_gone() {
        // 上次窗口在外接屏上，这次只剩笔记本 → 必须判定不可用并居中，
        // 否则窗口会开在屏幕外，用户以为程序没启动。
        assert!(resolve(&[LAPTOP], &state(2200, 300, 1200, 800)).is_none());
    }

    #[test]
    fn rejects_position_whose_titlebar_is_off_screen() {
        // 窗口整体在屏幕下方：只有底边一条缝露在外面，标题栏抓不到，
        // 拖不回来。必须拒绝而不是「勉强露出一点」。
        assert!(resolve(&[LAPTOP], &state(400, 1040, 1200, 800)).is_none());

        // 顶端刚好在容差内（露出 30px）→ 接受，用户能抓住标题栏。
        assert!(resolve(&[LAPTOP], &state(400, 1010, 1200, 800)).is_some());

        // 只露出 29px → 拒绝。
        assert!(resolve(&[LAPTOP], &state(400, 1011, 1200, 800)).is_none());
    }

    #[test]
    fn clamps_size_to_the_matching_monitor_work_area() {
        // 外接屏拔了以后，原来的 2560 宽窗口被夹回笔记本屏宽。
        let got = resolve(&[LAPTOP], &state(100, 100, 2560, 1400)).expect("on-screen");
        assert_eq!(got, (100, 100, 1920, 1040));
    }

    #[test]
    fn picks_the_monitor_with_the_largest_overlap() {
        // 窗口横跨两屏（拼在一起当一块用），应以交集更大的那块为准来夹尺寸。
        let got = resolve(&[LAPTOP, EXTERNAL], &state(1500, 100, 1600, 900)).expect("on-screen");
        // 与外接屏交集 1160x900 > 与主屏交集 420x900 → 走外接屏的 2560 宽上限。
        assert_eq!(got, (1500, 100, 1600, 900));

        // 反过来：窗口主体在主屏上，就该被主屏宽度夹住。
        let got = resolve(&[LAPTOP, EXTERNAL], &state(1600, 100, 1600, 900)).expect("on-screen");
        assert_eq!(got, (1600, 100, 1600, 900));
    }

    #[test]
    fn never_shrinks_below_minimum_size() {
        // 存档里的小窗口（老版本或被手改过）不能恢复到比 minWidth 更窄。
        let got = resolve(&[LAPTOP], &state(50, 50, 320, 200)).expect("on-screen");
        assert_eq!(got, (50, 50, MIN_WIDTH, MIN_HEIGHT));
    }

    #[test]
    fn accepts_a_window_hanging_off_the_bottom_edge() {
        // 用户主动把窗口压到屏幕下沿只露一条标题栏 —— 这是合法用法，
        // 不能判成不可用。
        assert!(resolve(&[LAPTOP], &state(400, 1000, 1200, 800)).is_some());
    }

    #[test]
    fn no_monitors_means_unresolvable() {
        assert!(resolve(&[], &state(0, 0, 1200, 800)).is_none());
    }

    #[test]
    fn json_roundtrip_preserves_flags() {
        let st = WindowState {
            x: -5,
            y: 12,
            width: 1000,
            height: 700,
            maximized: true,
            fullscreen: false,
        };
        let back: WindowState = serde_json::from_str(&serde_json::to_string(&st).unwrap()).unwrap();
        assert_eq!(back.x, st.x);
        assert_eq!(back.y, st.y);
        assert_eq!(back.width, st.width);
        assert_eq!(back.height, st.height);
        assert!(back.maximized);
        assert!(!back.fullscreen);
    }

    #[test]
    fn json_tolerates_missing_fields() {
        // 旧版本或手写的存档缺字段时应退回默认值，而不是整个解析失败
        // 丢掉用户的位置。
        let back: WindowState = serde_json::from_str(r#"{"x":42,"y":43}"#).unwrap();
        assert_eq!((back.x, back.y), (42, 43));
        assert_eq!((back.width, back.height), (1200, 800));
    }
}
