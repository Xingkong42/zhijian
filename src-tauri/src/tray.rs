//! 系统托盘（归属：系统集成 / 任务 t6）。
//!
//! 菜单：显示纸笺 / 隐藏到托盘 / 新建笔记(Alt+N) / 设置… / 退出纸笺。
//!  - 左键单击托盘图标 => 切换主窗口显隐（`window::toggle_visible`）；
//!  - 右键（或左键双击）=> 弹出菜单；
//!  - 菜单项一律通过 `emit` 通知前端（事件名取自 events.rs），Rust 侧不猜业务状态；
//!  - 「退出纸笺」是**唯一**真正退出的入口：先把窗口事件拦截关掉
//!    （`window::request_exit()`），注销全局快捷键，再 `app.exit(0)`。
//!
//! 托盘是「后台常驻」的载体：只要托盘存在，关闭按钮就只隐藏窗口（见 window.rs）。
//! 冻结签名：`TRAY_ID`、`setup<R>(app) -> tauri::Result<()>`；
//! 本任务按 t6 契约追加 `init()` 供 lib.rs 统一挂载。

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{events, window};

/// 托盘 id，必须与 tauri.conf.json 的 app.trayIcon.id 一致
pub const TRAY_ID: &str = "main-tray";

const MENU_SHOW: &str = "tray.show";
const MENU_HIDE: &str = "tray.hide";
const MENU_NEW_NOTE: &str = "tray.new-note";
/// t44：快速笔记（不写快捷键提示：它的键位由用户在设置里自定，且默认不占用全局键）
const MENU_QUICK_NOTE: &str = "tray.quick-note";
const MENU_SETTINGS: &str = "tray.settings";
const MENU_QUIT: &str = "tray.quit";

/// 创建托盘图标与菜单。
///
/// 返回 `Err` 表示托盘不可用；调用方（lib.rs）应仅打印告警，不要中断启动
/// —— 托盘缺失时关闭按钮会退化为「真正关闭」（`window::should_hide_on_close`）。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 重复调用（例如开发期热重载）时先清掉旧托盘，避免出现两个图标
    if app.tray_by_id(TRAY_ID).is_some() {
        app.remove_tray_by_id(TRAY_ID);
    }

    let show = MenuItem::with_id(app, MENU_SHOW, "显示纸笺", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE, "隐藏到托盘", true, None::<&str>)?;
    let new_note = MenuItem::with_id(app, MENU_NEW_NOTE, "新建笔记\tAlt+N", true, None::<&str>)?;
    let quick_note = MenuItem::with_id(app, MENU_QUICK_NOTE, "快速笔记…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出纸笺", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &PredefinedMenuItem::separator(app)?,
            &new_note,
            // t44：给「快速笔记」一个不改键位也能用到的入口 ——
            // 它的全局键位默认不开（§4.8.1 只默认注册前两个动作），
            // 只留快捷键的话这个功能在用户设置之前是**不可达**的。
            &quick_note,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("纸笺 — 极简便笺（左键显示/隐藏）")
        .menu(&menu)
        // 左键单击走自定义逻辑（切换显隐），因此不显示默认菜单；
        // 右键仍然弹出菜单（Tauri 默认在右键时显示）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event))
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                // 左键单击（抬起）=> 切换窗口显隐
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let _ = window::toggle_visible(app);
                }
                // 左键双击 => 直接显示并聚焦（不隐藏，符合「我要用它」的直觉）
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let _ = window::show_main(app);
                }
                _ => {}
            }
        });

    // 图标：优先用应用默认图标，缺失时由 Tauri 使用内置占位
    let tray = if let Some(icon) = app.default_window_icon().cloned() {
        tray.icon(icon)
    } else {
        tray
    };

    tray.build(app)?;
    Ok(())
}

/// 按 t6 契约提供的统一初始化入口（lib.rs 的 `setup` 内调用）
///
/// 只做「失败即告警」的语义封装：托盘不可用不阻断启动。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    match setup(app) {
        Ok(()) => {
            println!("[纸笺] 系统托盘已就绪（关闭按钮 = 隐藏到托盘）");
            Ok(())
        }
        Err(error) => {
            eprintln!("[纸笺] 系统托盘初始化失败：{error}");
            Err(Box::new(error) as Box<dyn std::error::Error>)
        }
    }
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_SHOW => {
            let _ = window::show_main(app);
        }
        MENU_HIDE => {
            // 托盘菜单触发的隐藏（非关闭按钮）—— 前端无需给「已最小化」提示
            let _ = window::hide_main(app, window::HideReason::Tray);
        }
        MENU_NEW_NOTE => {
            // 先让窗口可见再通知前端，避免前端在隐藏窗口里新建笔记后用户看不到
            let _ = window::show_main(app);
            let _ = app.emit(events::NEW_NOTE_REQUESTED, ());
        }
        MENU_QUICK_NOTE => {
            // t44：**不唤起主窗口** —— 用户要的就是"不要整个程序界面"。
            // 必须走 spawn 版本：这里是**事件处理器**，直接 build() 会在 Windows 上死锁
            // （框架文档原文见 `quick_note::spawn_open_quick_note` 的说明）。
            crate::quick_note::spawn_open_quick_note(app);
        }
        MENU_SETTINGS => {
            let _ = window::show_main(app);
            let _ = app.emit(events::OPEN_SETTINGS_REQUESTED, ());
        }
        MENU_QUIT => {
            // 通知前端（给前端一次「收尾」的机会），再关闭关闭拦截，
            // 最后注销全局快捷键并退出。
            let _ = app.emit(events::APP_QUIT_REQUESTED, ());
            quit(app);
        }
        _ => {}
    }
}

/// 真正退出应用：解除关闭拦截 → 注销全局快捷键 → 关闭全部磁贴 → 移除托盘 → `exit(0)`
fn quit<R: Runtime>(app: &AppHandle<R>) {
    window::request_exit();
    crate::shortcuts::unregister_all(app);
    // t19：退出前把磁贴几何落盘并关闭全部磁贴窗口（避免留下孤儿窗口）
    crate::tiles::cleanup_all(app);
    app.remove_tray_by_id(TRAY_ID);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_id_matches_window_tray_id() {
        assert_eq!(TRAY_ID, window::TRAY_ID);
    }

    #[test]
    fn menu_ids_are_namespaced() {
        for id in [MENU_SHOW, MENU_HIDE, MENU_NEW_NOTE, MENU_SETTINGS, MENU_QUIT] {
            assert!(id.starts_with("tray."), "菜单 id 需带 tray. 前缀：{id}");
        }
    }
}
