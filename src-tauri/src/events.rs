//! 前后端事件名常量（FROZEN）。
//!
//! TS 侧对应文件：`src/lib/tauri.ts` 的 `EVENTS` 常量。
//! 新增事件必须两边同时登记，禁止在业务代码里散写字符串字面量。

/// 主窗口被显示（托盘「显示」/ 全局快捷键唤起）
pub const WINDOW_SHOWN: &str = "zhijian://window-shown";

/// 主窗口被隐藏（托盘「隐藏」/ 关闭按钮）
pub const WINDOW_HIDDEN: &str = "zhijian://window-hidden";

/// 托盘或全局快捷键请求「新建笔记」（Alt+N 在窗口聚焦时由前端处理）
pub const NEW_NOTE_REQUESTED: &str = "zhijian://new-note-requested";

/// 托盘「设置」被点击
pub const OPEN_SETTINGS_REQUESTED: &str = "zhijian://open-settings-requested";

/// 托盘「退出」被点击（此时允许真正关闭窗口）
pub const APP_QUIT_REQUESTED: &str = "zhijian://app-quit-requested";

/// 全局快捷键请求「显示/隐藏主窗口」（t17 起可自定义绑定）。
///
/// 说明：`Alt+Shift+Z` 的显隐动作原本完全在 Rust 侧完成、无需通知前端；
/// 但绑定可自定义后，前端设置页需要知道「这个动作刚刚被触发」才能给出反馈，
/// 因此补一条事件。**显隐本身仍由 Rust 执行**（窗口未聚焦时也要能用），
/// 本事件只用于前端反馈，前端不触发时也不影响功能。
pub const TOGGLE_WINDOW_REQUESTED: &str = "zhijian://toggle-window-requested";

/// 磁贴可见性被快捷键切换（t19）。负载：`{ visible: bool }`（camelCase）。
///
/// 实际显隐由 Rust 对所有磁贴窗口完成，本事件仅供主窗口 UI 同步开关状态。
pub const TILES_VISIBILITY_CHANGED: &str = "zhijian://tiles-visibility-changed";

/// 请求把「当前笔记」钉成磁贴（t19）。负载：`{ noteId: string }`（camelCase）。
///
/// 由全局快捷键触发；**noteId 由前端决定**（Rust 不知道"当前笔记"是哪个），
/// 因此前端需要在本事件里回填自己的 `selectedId`。
pub const PIN_CURRENT_NOTE_REQUESTED: &str = "zhijian://pin-current-note-requested";

/// 笔记内容被某个窗口改动（t44）。负载：`{ noteId: string, source: string }`（camelCase）。
///
/// **纯前端事件**（Rust 只负责广播，不参与业务）：磁贴与主窗口是两个独立 WebView，
/// 各自持有独立的 store 实例，一边写入另一边不会自动知道。写入方广播、其它窗口重读该条，
/// 从而让「在磁贴上写字」与「在主窗口写字」互相实时可见（用户第三轮反馈的同步问题）。
/// `source` 是发送方窗口 label（`main` / `tile-*`），接收方据此忽略自己发出的事件。
pub const NOTE_CHANGED: &str = "zhijian://note-changed";

/// **磁贴集合发生了变化**（t45）。空负载。
///
/// 什么时候发：某枚磁贴窗口被销毁时（用户点磁贴的 × / 快捷键 / 程序性关闭）。
/// 为什么需要：Rust 才是"当前有哪些磁贴"的权威（`tiles.json` + 活动窗口），
/// 而主窗口的按钮只在**自己发起的操作**后对账 —— 用户从磁贴那侧关掉时，
/// 主窗口的「取消桌面磁贴」会一直停在旧状态（用户 t45 报障 ①）。
///
/// 负载刻意为空：前端收到就用 `cmd_list_tiles` 重新对账，不在事件里带第二份列表副本。
pub const TILES_CHANGED: &str = "zhijian://tiles-changed";

/// 所有已登记事件名，供测试与文档生成使用
pub const ALL: &[&str] = &[
    WINDOW_SHOWN,
    WINDOW_HIDDEN,
    NEW_NOTE_REQUESTED,
    OPEN_SETTINGS_REQUESTED,
    APP_QUIT_REQUESTED,
    TOGGLE_WINDOW_REQUESTED,
    TILES_VISIBILITY_CHANGED,
    PIN_CURRENT_NOTE_REQUESTED,
    NOTE_CHANGED,
    TILES_CHANGED,
];

/// 启动时打印事件契约，便于与前端 `EVENTS` 常量对账（见 docs/ARCHITECTURE.md §4.9）
pub fn log_contract() {
    for name in ALL {
        println!("[纸笺] event: {name}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_use_app_scheme() {
        assert!(ALL.iter().all(|name| name.starts_with("zhijian://")));
        assert_eq!(ALL.len(), 10);
        // 事件名不得重复（重复会导致前端 listen 语义歧义）
        let mut sorted = ALL.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ALL.len());
    }
}
