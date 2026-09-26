// 纸笺 —— Tauri 2 后端入口库。
//
// 归属：架构师冻结模块边界（任务 01），实现者按文件归属扩展：
//   - lib.rs       应用装配（插件注册、窗口事件、迁移、setup）
//   - tray.rs      系统托盘（任务 05）
//   - shortcuts.rs 全局快捷键 Alt+N / Alt+Shift+Z（任务 05）
//   - window.rs    无边框窗口控制与「关闭→隐藏到托盘」（任务 05）
//
// 约定（与前端契约对应，见 docs/ARCHITECTURE.md）：
//   - 前端事件名常量集中在 src-tauri/src/events.rs，Rust 与 TS 用同一批字符串。
//   - SQLite 迁移由 tauri-plugin-sql 在启动时按 migrations/*.sql 的版本号顺序执行。
//   - 窗口关闭默认拦截为隐藏（后台常驻），仅在托盘不存在或显式退出时真正关闭。

mod events;
mod quick_note;
mod shortcuts;
mod tiles;
mod tray;
mod window;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// SQLite 连接串，必须与前端 src/db/index.ts 的 DB_URL 一致
pub const DB_URL: &str = "sqlite:zhijian.db";

/// **前端**迁移器的版本表名（由 `src/db/index.ts::initDb()` 创建并写入）。
///
/// ⚠️ 容易误解，特此说明（详见 docs/ARCHITECTURE.md §7「双迁移器」）：
///  - Rust 侧 sqlx 用自己的表 `_sqlx_migrations`（含 `checksum`/`success`），**不写这张表**；
///  - 本常量只用于和前端对齐命名，Rust 侧当前并不读写它，因此允许未使用。
#[cfg_attr(not(test), allow(dead_code))]
pub const FRONTEND_MIGRATION_TABLE: &str = "_zj_migrations";

/// 迁移 SQL 列表，由 `migrations/<version>_<name>.sql` 在编译期嵌入
const MIGRATION_SOURCES: &[(i64, &str, &str)] = &[(
    1,
    "init",
    include_str!("../migrations/1_init.sql"),
)];

fn migrations() -> Vec<Migration> {
    MIGRATION_SOURCES
        .iter()
        .map(|(version, description, sql)| Migration {
            version: *version,
            description,
            sql,
            kind: MigrationKind::Up,
        })
        .collect()
}

/// 开机自启时传给自己的参数（t38）。
///
/// 语义与前端那个 `startMinimized` 偏好**刻意分开**：
/// - 本参数 = **Rust 侧**、开机自启专用 ⇒ **零闪窗**（窗口从不 show，直接进托盘）；
/// - `startMinimized` = **前端**路径（等 WebView 起来后再 `hide()`）⇒ 用户手动启动时也会有约 1 秒闪现。
///
/// 为什么不能只靠前端那条路：开机自启场景下"莫名弹出一个窗口"最打扰用户，
/// 而 WebView 加载需要约 1 秒 —— 那 1 秒的闪现正是要避免的东西。
const AUTOSTART_MINIMIZED_ARG: &str = "--minimized";

/// 本次进程是否由「开机自启」拉起（命令行含 `--minimized`）
fn started_minimized() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_MINIMIZED_ARG)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()        // 单实例 + 对话框 + 文件系统 + 打开外部链接
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // t38：开机自动启动。带 `--minimized` 参数写入自启项 ——
        // 目的见 setup 里的 `started_minimized()`：开机拉起时**零闪窗**直接进托盘。
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(AUTOSTART_MINIMIZED_ARG)
                .build(),
        )
        // 全局快捷键（Alt+N 新建 / Alt+Shift+Z 唤起）
        .plugin(shortcuts::plugin())
        // SQLite：preload 的连接串需与前端 Database.load() 的 URL 完全一致
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        // 无边框窗口的关闭拦截（§4.13）：默认隐藏到托盘以支持后台常驻，
        // 但必须给用户留出「真的能退出」的路径。
        .on_window_event(|window, event| {
            // t19：磁贴的移动/缩放要记住几何（只对 tile-* 窗口生效）
            if let Some(tile) = window.app_handle().get_webview_window(window.label()) {
                tiles::handle_window_event(&tile, event);
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // t19：关闭一枚磁贴 = 只关那个窗口，**不**拦截、也不隐藏到托盘
                if tiles::note_id_from_label(window.label()).is_some() {
                    return;
                }
                // t44：快速笔记同理 —— 它是一个短命的捕捉框，
                // 拦截它去"隐藏到托盘"的表现是「点了关闭窗口还在」，用户会以为保存失败。
                if quick_note::is_quick_note_label(window.label()) {
                    return;
                }
                let app = window.app_handle();
                if window::should_hide_on_close(app) {
                    api.prevent_close();
                    // 规则 1/4：隐藏必须 emit WINDOW_HIDDEN（带 reason 与 firstCloseHide），
                    // 前端据此提示「已最小化到系统托盘」——只隐藏无反馈，用户会以为关不掉。
                    let _ = window::hide_main(app, window::HideReason::Close);
                } else {
                    // 规则 2/3：偏好为 false、或**托盘不存在**时，本次关闭就是真退出。
                    // 此处不拦截即放行；前置复位闩锁标志，确保用户稍后重新开启
                    // 「关闭到托盘」时行为能恢复（否则会成为不可逆闩锁）。
                    window::clear_explicit_quit();
                }
            }
        })
        .setup(|app| {
            // 打印事件契约，便于与前端 src/lib/tauri.ts 的 EVENTS 对账
            #[cfg(debug_assertions)]
            events::log_contract();
            // 1) 托盘：后台常驻的载体。失败不致命（例如无桌面环境的测试机），
            //    此时 window::should_hide_on_close 返回 false，关闭按钮会真正退出。
            if let Err(error) = tray::init(app.handle()) {
                eprintln!("[纸笺] 托盘初始化失败，已跳过：{error}");
            }
            // 2) 主窗口
            if started_minimized() {
                // t38：开机自启（`--minimized`）⇒ **不 show**，直接后台常驻。
                //   配套改动：tauri.conf.json 的主窗口 `visible: false`
                //   （否则 Tauri 在 setup 之前就把窗口显示出来了，仍会有约 1 秒空白闪现）。
                //   正常启动时由下面的 window::init() 负责 show()。
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
                println!("[纸笺] 以 --minimized 启动：主窗口保持隐藏（开机自启零闪窗）");
            } else if let Err(error) = window::init(app.handle()) {
                eprintln!("[纸笺] 主窗口初始化失败：{error}");
            }
            // 3) 全局快捷键：Alt+N 新建 / Alt+Shift+Z 唤起。
            //    shortcuts::init 内部已封装「失败只告警、绝不 panic」的语义，
            //    被其它程序占用时应用照常启动（前端本地快捷键兜底）。
            if let Err(error) = shortcuts::init(app.handle()) {
                eprintln!("[纸笺] 全局快捷键初始化异常：{error}");
            }
            // 4) 磁贴（t19）：注册托管状态 + 恢复上次钉住的磁贴。
            //    ⚠️ 必须在 shortcuts::init **之后**：快捷键分发会调用 tiles::*，需要状态已 manage。
            if let Err(error) = tiles::init(app.handle()) {
                eprintln!("[纸笺] 磁贴初始化失败，已跳过：{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::window_show,
            window::window_hide,
            window::window_toggle,
            window::app_version,
            window::cmd_set_close_to_tray,
            window::cmd_close_to_tray_enabled,
            // t17：运行时可自定义全局快捷键（原子重建绑定 + 回传实际生效值）
            shortcuts::cmd_sync_global_shortcuts,
            // t19：桌面便签磁贴
            tiles::cmd_toggle_tile,
            tiles::cmd_list_tiles,
            tiles::cmd_set_tiles_visible,
            // t45：固定磁贴（固定的下次启动自动出现）
            tiles::cmd_set_tile_pinned,
            // t47：取消吸附（把磁贴从吸附组里移出来）
            tiles::cmd_ungroup_tile,
            // t52：「磁贴吸附」总开关（前端偏好 `zhijian.tileSnap` 的行为副本）
            tiles::cmd_set_tile_snap,
            tiles::cmd_tile_snap_enabled,
            // t44：快速笔记（全局唯一的短命捕捉窗）
            quick_note::cmd_open_quick_note,
        ])
        .run(tauri::generate_context!())
        .expect("纸笺启动失败：Tauri 运行时错误");
}
