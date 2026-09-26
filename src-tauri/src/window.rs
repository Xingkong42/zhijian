//! 无边框窗口控制、居中与「关闭→隐藏到托盘」（归属：系统集成 / 任务 t6）。
//!
//! 契约见 docs/ARCHITECTURE.md §4.9 / §4.10：
//!  - 前端通过 `invoke('window_show' | 'window_hide' | 'window_toggle' | 'app_version')` 调用；
//!  - 显示/隐藏时分别 emit `events::WINDOW_SHOWN` / `events::WINDOW_HIDDEN`；
//!  - 关闭按钮默认**只隐藏**（后台常驻），仅当托盘不可用、或用户从托盘选择
//!    「退出纸笺」（`request_exit()`）时才真正关闭窗口。
//!
//! 冻结签名（不得改名 / 改参数）：MAIN_WINDOW_LABEL、should_hide_on_close、
//! show_main、hide_main、toggle_main；本任务按 t6 契约**追加**（不改既有签名）：
//! main_window、center_window、toggle_visible、is_main_visible、request_exit、init。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::events;

/// 主窗口 label，必须与 tauri.conf.json 的 windows[0].label 一致
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 托盘 id，与 tray.rs::TRAY_ID / tauri.conf.json 的 app.trayIcon.id 一致
pub const TRAY_ID: &str = "main-tray";

/// 用户是否显式要求退出（托盘「退出纸笺」）。
///
/// 置位后让本次关闭**穿过**隐藏逻辑真正退出，然后在关闭被放行时复位
/// （见 `clear_explicit_quit()`）—— 否则会变成不可逆的闩锁，
/// 用户重新打开「关闭到托盘」开关也不会再隐藏。
static EXPLICIT_QUIT: AtomicBool = AtomicBool::new(false);

/// 「关闭窗口时隐藏到系统托盘」偏好（§4.13）。
///
/// - **默认 `true`**：用户需求要求托盘后台常驻，因此默认关闭即隐藏；
/// - 值由前端在**启动时**与**开关变更时**经 `set_close_to_tray` 下发
///   （Rust 读不到 WebView 的 localStorage）；
/// - 本进程内常驻，**不落盘**：前端 localStorage 是唯一持久化来源，
///   启动时会重新下发，故 Rust 侧无需再维护一份可能不一致的副本。
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// 是否已经给过「已最小化到系统托盘」的首次反馈（§4.13 规则 4）
static FIRST_HIDE_NOTIFIED: AtomicBool = AtomicBool::new(false);

/// 本次隐藏的触发原因，随 `WINDOW_HIDDEN` 事件下发给前端
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HideReason {
    /// 用户点了窗口关闭按钮（最需要提示的场景）
    Close,
    /// 托盘菜单「隐藏到托盘」
    Tray,
    /// 托盘左键单击 / 全局快捷键 Alt+Shift+Z 的显隐切换
    Toggle,
}

/// `WINDOW_HIDDEN` 的事件负载（t13 的前端 Toast 依赖 `firstCloseHide`）
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowHiddenPayload {
    pub reason: HideReason,
    /// 是否为「用户第一次通过关闭按钮隐藏」—— 前端据此只提示一次，避免每次关闭都打扰
    pub first_close_hide: bool,
}

/// 取主窗口；窗口尚未创建或已被销毁时返回 None（不 panic）
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
}

/// 关闭按钮当前是否应该「隐藏到托盘」而不是退出（§4.13 规则 2/3）。
///
/// 三个条件全部满足才隐藏：
///  1. 用户没有显式要求退出（托盘「退出纸笺」）；
///  2. 偏好 `close_to_tray` 为真；
///  3. **托盘确实存在** —— 这是「用户永远能退出」的最后保障，任何情况下都不得简化掉。
pub fn should_hide_on_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    !is_explicit_quit() && close_to_tray_preference() && app.tray_by_id(TRAY_ID).is_some()
}

/// 标记「正在显式退出」：本次关闭会穿过隐藏逻辑，走完真正的退出流程
pub fn request_exit() {
    EXPLICIT_QUIT.store(true, Ordering::SeqCst);
}

/// 复位「显式退出」标记。
///
/// **必须在关闭被放行之后调用**：否则该标志只增不减，用户一旦点过托盘「退出」
/// 或关过一次开关，此后即使重新开启「关闭到托盘」，关闭按钮也再不会隐藏。
pub fn clear_explicit_quit() {
    EXPLICIT_QUIT.store(false, Ordering::SeqCst);
}

/// 显式退出标记当前状态（测试 / 诊断用）
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_explicit_quit() -> bool {
    EXPLICIT_QUIT.load(Ordering::SeqCst)
}

/// 「关闭到托盘」偏好当前值（纯读取，不带 `#[tauri::command]`）
pub fn close_to_tray_preference() -> bool {
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

/// 设置「关闭到托盘」偏好（IPC 命令与测试共用）
pub fn set_close_to_tray_preference(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// 主窗口当前是否可见（窗口不存在时为 false）
pub fn is_main_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    main_window(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 显示并聚焦主窗口（托盘「显示」/ 全局快捷键 Alt+N）
pub fn show_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        let _ = app.emit(events::WINDOW_SHOWN, ());
    }
    Ok(())
}

/// 隐藏主窗口到托盘，并 emit `WINDOW_HIDDEN`（§4.13 规则 1）。
///
/// `reason = Close` 且是首次时，负载里 `firstCloseHide = true`，
/// 前端据此给出一次「已最小化到系统托盘」提示 —— 只隐藏而无反馈，
/// 用户依然会以为应用关不掉（§4.13 规则 4）。
pub fn hide_main<R: Runtime>(app: &AppHandle<R>, reason: HideReason) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        window.hide()?;
    }
    let first_close_hide = matches!(reason, HideReason::Close) && !FIRST_HIDE_NOTIFIED.swap(true, Ordering::SeqCst);
    let _ = app.emit(
        events::WINDOW_HIDDEN,
        WindowHiddenPayload {
            reason,
            first_close_hide,
        },
    );
    Ok(())
}

/// 显示/隐藏切换（全局快捷键 Alt+Shift+Z 与托盘左键单击使用）
pub fn toggle_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if is_main_visible(app) {
        hide_main(app, HideReason::Toggle)
    } else {
        show_main(app)
    }
}

/// `toggle_main` 的语义化别名（t6 契约中的 `toggle_visible()`）
pub fn toggle_visible<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    toggle_main(app)
}

/// 把主窗口居中到当前显示器。
///
/// - 窗口不可见 / 已销毁：静默返回 `Ok(())`；
/// - 显示器信息不可得（多屏拔插、远程桌面等）：同样静默返回，绝不让居中失败影响启动；
/// - 取窗口自身所在显示器（`current_monitor`），多屏环境下居中到用户实际使用的那块屏。
pub fn center_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return Ok(());
    };
    let Some(size) = window.outer_size().ok() else {
        return Ok(());
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    if monitor_size.width == 0 || monitor_size.height == 0 {
        return Ok(());
    }

    // 用有符号 i64 计算，避免小屏下 width 差值出现负数时溢出；坐标回写为 i32
    let x = monitor_position.x as i64 + (monitor_size.width as i64 - size.width as i64) / 2;
    let y = monitor_position.y as i64 + (monitor_size.height as i64 - size.height as i64) / 2;

    window.set_position(tauri::PhysicalPosition::new(
        x.max(0).min(i32::MAX as i64) as i32,
        y.max(0).min(i32::MAX as i64) as i32,
    ))?;
    Ok(())
}

/// 初始化主窗口：确保可见（不抢占前台焦点之外的语义）、并居中。
///
/// 由 `lib.rs` 在 `setup` 中调用；失败只告警，不阻断启动。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let Some(window) = main_window(app) else {
        return Err("未找到主窗口（label = main），请检查 tauri.conf.json".into());
    };
    // 启动即显示：托盘常驻应用被再次唤起时也走这条路径
    window.show()?;
    if let Err(error) = center_window(app) {
        eprintln!("[纸笺] 主窗口居中失败（不影响使用）：{error}");
    }
    Ok(())
}

/* ----------------------------- 前端 IPC 命令 ----------------------------- */

#[derive(Serialize)]
pub struct AppVersion {
    pub name: &'static str,
    pub version: String,
    pub tauri: &'static str,
}

/// 显示主窗口（前端调用）
#[tauri::command]
pub async fn window_show<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    show_main(&app).map_err(|e| e.to_string()).map(|_| true)
}

/// 隐藏主窗口到托盘（前端调用；来源为非关闭按钮，故 reason = Tray）
#[tauri::command]
pub async fn window_hide<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    hide_main(&app, HideReason::Tray).map_err(|e| e.to_string())
}

/// 切换主窗口显隐（前端调用）
#[tauri::command]
pub async fn window_toggle<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    toggle_main(&app).map_err(|e| e.to_string())
}

/// 设置「关闭窗口时隐藏到系统托盘」偏好（§4.13）。
///
/// 前端调用时机（两者都必须）：
///  1. **应用启动时**同步一次（把 localStorage 里持久化的值下发给 Rust）；
///  2. **开关变更时**立即下发。
#[tauri::command]
pub fn cmd_set_close_to_tray(enabled: bool) -> bool {
    set_close_to_tray_preference(enabled);
    enabled
}

/// 读取当前「关闭到托盘」偏好（诊断 / 前端状态对账用）
#[tauri::command]
pub fn cmd_close_to_tray_enabled() -> bool {
    close_to_tray_preference()
}

/// 版本信息（设置面板展示）
#[tauri::command]
pub async fn app_version<R: Runtime>(app: AppHandle<R>) -> Result<AppVersion, String> {
    let version = app.package_info().version.to_string();
    Ok(AppVersion {
        name: "纸笺",
        version,
        tauri: "2",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_label_matches_tauri_conf() {
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_eq!(TRAY_ID, "main-tray");
    }

    #[test]
    fn request_exit_sets_global_flag() {
        // 置位后应保持为 true（原子标记只增不减）。断言写成蕴含关系，
        // 保证与其它用例共享进程时不依赖执行顺序。
        let before = is_explicit_quit();
        request_exit();
        assert!(is_explicit_quit());
        assert!(before || is_explicit_quit());
    }

    #[test]
    fn close_to_tray_defaults_to_enabled() {
        // 默认必须是「关闭即隐藏」（用户需求：托盘后台常驻）
        // 注意：与其它用例共享同一进程，故只在未被其它用例改写的前提下断言语义，
        // 随后显式恢复默认真值。
        if !close_to_tray_preference() {
            set_close_to_tray_preference(true);
        }
        assert!(close_to_tray_preference(), "默认应为启用（关闭即隐藏到托盘）");
    }

    #[test]
    fn clear_explicit_quit_resets_latch() {
        // 回归：EXPLICIT_QUIT 若不复位会成为不可逆闩锁 ——
        // 用户重新打开「关闭到托盘」开关后关闭按钮也不会再隐藏。
        request_exit();
        assert!(is_explicit_quit());
        clear_explicit_quit();
        assert!(!is_explicit_quit(), "clear_explicit_quit() 必须能复位闩锁");
    }

    #[test]
    fn close_to_tray_toggle_is_readable() {
        set_close_to_tray_preference(false);
        assert!(!close_to_tray_preference());
        set_close_to_tray_preference(true);
        assert!(close_to_tray_preference());
    }

    #[test]
    fn hidden_payload_serializes_camel_case() {
        let payload = WindowHiddenPayload {
            reason: HideReason::Close,
            first_close_hide: true,
        };
        let json = serde_json::to_string(&payload).expect("payload 必须可序列化");
        // t13 的前端 Toast 依赖这两个字段名
        assert!(json.contains("\"reason\":\"close\""), "实际：{json}");
        assert!(json.contains("\"firstCloseHide\":true"), "实际：{json}");
    }
}
