//! 快速笔记窗口（t44）。
//! 归属：系统集成（窗口创建）+ 编辑器成员（窗口内 UI）。
//!
//! ## 为什么需要它（用户原话）
//! 「通过快捷键立马打开一个单独的记录框界面而不是整个程序界面，可以快速建立一个笔记。」
//! 即：捕捉灵感时**不要**把 1280×800 的主界面整个弹到眼前，只要一个小框。
//!
//! ## 与桌面磁贴的区别（别把两者混为一谈）
//! | | 磁贴 `tile-<noteId>` | 快速笔记 `quick-note` |
//! |---|---|---|
//! | 数量 | 一条笔记一个窗口，可同时存在多个 | **全局只有一个**（label 固定） |
//! | 生命周期 | 常驻，几何被持久化到 `tiles.json` | 用完即关，**不持久化任何几何** |
//! | 语义 | 编辑**已有**的一条笔记 | **新建**一条笔记，保存后窗口关闭 |
//! | 内容 | 双向实时同步（t44 的 note-changed） | 窗口短命，不需要同步 |
//! 因此本模块**刻意不复用** `tiles.rs`：那里围绕 noteId、几何持久化、批量显隐建立的
//! 全部机制在这里都是噪音，硬套只会让两边都难读。
//!
//! ## URL 协议
//! 与磁贴同一套路（见 `features/tiles/tileUrl.ts` 的说明）：同一份前端，
//! URL 带 `?quick=1`，由 `src/main.tsx` 路由到 `QuickNoteApp`。
//! 这里同样**显式拼绝对 URL + `WebviewUrl::External`**，理由与 `tile_url` 完全相同：
//! `WebviewUrl::App("index.html?quick=1")` 的查询串是否保留取决于内部拼接实现。
//!
//! ## 关闭语义（与主窗口的「关闭即隐藏到托盘」区分开）
//! 快速笔记窗口关闭 = 真的关掉那个窗口：`lib.rs` 的 `CloseRequested` 里必须先按
//! `is_quick_note_label` 提前放行，否则它会被"关闭到托盘"逻辑拦下来 ——
//! 表现是"点关闭没反应、窗口还在"，而且用户会以为笔记保存失败。

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 快速笔记窗口 label（全局唯一；`capabilities/quick-note.json` 用它匹配）
pub const QUICK_NOTE_LABEL: &str = "quick-note";

/// URL 查询参数名（与前端 `readQuickNoteFlag` 共用一份约定）
pub const QUICK_NOTE_QUERY_KEY: &str = "quick";

/// 窗口尺寸（设计刻度内的小捕捉框：够写两三行，又不遮挡背后的内容）
pub const QUICK_NOTE_WIDTH: f64 = 460.0;
pub const QUICK_NOTE_HEIGHT: f64 = 264.0;
pub const QUICK_NOTE_MIN_WIDTH: f64 = 340.0;
pub const QUICK_NOTE_MIN_HEIGHT: f64 = 160.0;

const QUICK_NOTE_TITLE: &str = "纸笺 · 快速笔记";

/// 这个 label 是不是快速笔记窗口
pub fn is_quick_note_label(label: &str) -> bool {
    label == QUICK_NOTE_LABEL
}

/// 已存在的快速笔记窗口（关闭后为 None）
pub fn quick_note_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(QUICK_NOTE_LABEL)
}

fn quick_note_url<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let config = app.config();
    let base = if tauri::is_dev() {
        config
            .build
            .dev_url
            .as_ref()
            .map(|url| url.to_string())
            .ok_or_else(|| "开发态缺少 build.devUrl 配置".to_string())?
    } else {
        "tauri://localhost/".to_string()
    };
    let separator = if base.contains('?') { '&' } else { '?' };
    Ok(format!("{base}{separator}{QUICK_NOTE_QUERY_KEY}=1"))
}

/// 打开（或复用）快速笔记窗口。
///
/// 已存在时只 `show + unminimize + set_focus`：**不重建**。
/// 重建会丢掉用户已经敲了一半的内容 —— 那正是这个功能最不能接受的失败方式。
pub fn open_quick_note<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(existing) = quick_note_window(app) {
        let _ = existing.unminimize();
        let _ = existing.show();
        existing
            .set_focus()
            .map_err(|error| format!("聚焦快速笔记窗口失败：{error}"))?;
        return Ok(());
    }

    let url = quick_note_url(app)?;
    let window = WebviewWindowBuilder::new(
        app,
        QUICK_NOTE_LABEL,
        WebviewUrl::External(url.parse().map_err(|error| format!("快速笔记 URL 非法：{error}"))?),
    )
    // 无边框 + 置顶 + 不占任务栏：与磁贴同一形态（前端用 data-tauri-drag-region 拖动）。
    // ⚠️ `decorations(false)` 的代价是「没有系统标题栏」⇒ 拖动必须由前端提供，
    //    并且需要 `core:window:allow-start-dragging` 授权（见 capabilities/quick-note.json）。
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    // 捕捉框不需要最大化：与磁贴同因（注入脚本的 internal_toggle_maximize 路径
    // 不受 capability deny 约束，唯一可靠的护栏就是 is_maximizable() == false）。
    .maximizable(false)
    .minimizable(false)
    .min_inner_size(QUICK_NOTE_MIN_WIDTH, QUICK_NOTE_MIN_HEIGHT)
    .inner_size(QUICK_NOTE_WIDTH, QUICK_NOTE_HEIGHT)
    .center()
    .title(QUICK_NOTE_TITLE)
    .visible(true)
    .focused(true)
    .build()
    .map_err(|error| format!("创建快速笔记窗口失败：{error}"))?;

    // `focused(true)` 在部分 Windows 组合下不足以抢到前台焦点（系统会拒绝后台进程抢焦点），
    // 再显式补一次；失败不致命（用户点一下即可），因此只打印不返回错误。
    if let Err(error) = window.set_focus() {
        eprintln!("[纸笺] 快速笔记窗口聚焦失败（可手动点击窗口）：{error}");
    }

    println!("[纸笺] 快速笔记窗口已创建 → {url}");
    Ok(())
}

/**
 * 在**独立线程**上打开快速笔记窗口 —— 事件处理器（托盘菜单 / 全局快捷键）必须走这里。
 *
 * ## 依据（框架源码原文，不要凭直觉改掉）
 * `tauri-2.11.6/src/webview/webview_window.rs:56-59`（`WebviewWindowBuilder::build` 的文档）：
 * > # Known issues
 * > On Windows, this function deadlocks when used in a **synchronous command and event handlers**...
 * > You should use `async` commands and **separate threads** when creating windows.
 *
 * ## t44 实测（探针 `probe:quick-note` 抓到的就是这个）
 * 第一版把 `cmd_open_quick_note` 写成了**同步**命令 ⇒ 前端 `invoke` 永久挂起、
 * 窗口根本没被创建（探针表现为 `CDP 超时：Runtime.evaluate` + 等不到 `?quick=1` 目标）。
 * 静态门、编译、cargo test 全绿都发现不了它 —— 只有真机跑一遍才会暴露。
 *
 * 因此本函数的语义是「**尽力而为地打开**」：调用方不等待结果，失败只落日志。
 * 需要"拿到创建结果"的场景（前端命令）请用 `async` 命令 + 直接调 `open_quick_note`。
 */
pub fn spawn_open_quick_note<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = open_quick_note(&handle) {
            eprintln!("[纸笺] 打开快速笔记窗口失败：{error}");
        }
    });
}

/// 前端可调的命令：打开快速笔记窗口。
///
/// 谁在用：托盘菜单与全局快捷键都走 `spawn_open_quick_note`（见上）；
/// 本命令留给前端入口（将来若在侧栏/标题栏加入口，`invoke(COMMANDS.openQuickNote)` 即可），
/// 同时让探针 `probe:quick-note` 有一条**可被外部驱动**的确定路径。
///
/// ⚠️ **必须是 `async fn`**：同步命令跑在主线程上，`build()` 会死锁（见上）。
/// 这也解释了本项目其它涉及窗口的命令（`window_show` / `cmd_toggle_tile` / …）
/// 为什么清一色是 `async fn` —— 那不是风格偏好，是 Windows 上的硬约束。
#[tauri::command]
pub async fn cmd_open_quick_note<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    open_quick_note(&app).map(|_| true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_matches_only_the_quick_note_window() {
        assert!(is_quick_note_label(QUICK_NOTE_LABEL));
        // 主窗口 / 磁贴 / 托盘 id 都不得被误判（否则关闭语义与几何处理会串台）
        for label in ["main", "tile-abc", "main-tray", "quick", "quick-note-2", ""] {
            assert!(
                !is_quick_note_label(label),
                "「{label}」不应被识别为快速笔记窗口"
            );
        }
    }

    #[test]
    fn query_key_is_a_plain_ascii_token() {
        // 前端 `URLSearchParams` 与 Rust 拼串共用它；一旦出现需要转义的字符，
        // `?quick=1` 的拼接与解析就会对不上（表现为窗口打开后是主界面）。
        assert!(QUICK_NOTE_QUERY_KEY
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric()));
    }

    #[test]
    fn window_is_smaller_than_main_window_min_size() {
        // 快速笔记的意义就是"不要整个主界面"：它必须显著小于主窗口，
        // 否则这个功能等于又开了一个主窗口（配置改动若破坏这一点，此断言会失败）。
        assert!(QUICK_NOTE_WIDTH <= 640.0);
        assert!(QUICK_NOTE_HEIGHT <= 360.0);
        assert!(QUICK_NOTE_MIN_WIDTH < QUICK_NOTE_WIDTH);
        assert!(QUICK_NOTE_MIN_HEIGHT < QUICK_NOTE_HEIGHT);
    }
}
