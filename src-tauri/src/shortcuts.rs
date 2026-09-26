//! 全局快捷键（归属：系统集成 / 任务 t6；t17 起支持**运行时重注册**）。
//!
//! | 动作 id | 默认键位 | 行为 |
//! | --- | --- | --- |
//! | `newNote` | `Alt+N` | 显示并聚焦窗口 + emit `NEW_NOTE_REQUESTED`（前端新建笔记） |
//! | `toggleWindow` | `Alt+Shift+Z` | 显示/隐藏主窗口（Rust 直接执行）+ emit `TOGGLE_WINDOW_REQUESTED`（仅反馈） |
//! | `openSettings` | 未注册 | 显示并聚焦窗口 + emit `OPEN_SETTINGS_REQUESTED` |

//!
//! 注册失败（被其它程序占用、无桌面会话等）**不致命**：只打印告警，应用照常启动，
//! 前端的本地快捷键（`src/lib/hotkeys.ts`）仍可兜底。
//!
//! **t17 关键设计（为什么需要「动作注册表」）**：插件的事件回调拿到的只是
//! `(AppHandle, &Shortcut, ShortcutEvent)` —— **不含任何自定义负载**。
//! 原来靠 `if shortcut == &new_note_shortcut()` 硬编码比较，一旦键位可自定义就失效
//! （用户把新建改成 Ctrl+Alt+N 后，回调仍只会匹配旧的 Alt+N）。
//! 因此引入进程内注册表 `ACCELERATOR → action_id`，回调先查表再分发；
//! 表在启动与每次 `cmd_sync_global_shortcuts` 时被重写。
//!
//! 冻结签名：NEW_NOTE_ACCELERATOR / TOGGLE_WINDOW_ACCELERATOR / plugin() /
//! register_all() / unregister_all() / log_contract()；
//! t6 追加 `init()`；t17 追加 `cmd_sync_global_shortcuts()` 与动作注册表。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::{events, tiles, window};

/// 新建笔记：Alt+N —— 前端 `src/lib/hotkeys.ts` 的 `GLOBAL_SHORTCUTS.newNote` 镜像，禁止单边修改
pub const NEW_NOTE_ACCELERATOR: &str = "Alt+N";
/// 显示/隐藏窗口：Alt+Shift+Z —— 前端 `GLOBAL_SHORTCUTS.toggleWindow` 镜像，禁止单边修改
pub const TOGGLE_WINDOW_ACCELERATOR: &str = "Alt+Shift+Z";

/* ------------------------- 动作 id（与前端约定，FROZEN） ------------------------- */

pub const ACTION_NEW_NOTE: &str = "newNote";
pub const ACTION_TOGGLE_WINDOW: &str = "toggleWindow";
pub const ACTION_OPEN_SETTINGS: &str = "openSettings";
/// t19：显示/隐藏**全部**磁贴（Rust 直接对所有磁贴窗口生效，无需前端参与）
pub const ACTION_TOGGLE_TILES: &str = "toggleTiles";
/// t19：把「当前笔记」钉成磁贴 —— noteId 由前端在事件里回填（Rust 不知道当前选中项）
pub const ACTION_PIN_CURRENT_NOTE: &str = "pinNote";
/// t44：快速笔记 —— 打开一个独立的捕捉小窗（不是主界面）
pub const ACTION_QUICK_NOTE: &str = "quickNote";

/// 全部受支持的动作 id（`cmd_sync_global_shortcuts` 会拒绝未知 id）
pub const SUPPORTED_ACTION_IDS: &[&str] = &[
    ACTION_NEW_NOTE,
    ACTION_TOGGLE_WINDOW,
    ACTION_OPEN_SETTINGS,
    ACTION_TOGGLE_TILES,
    ACTION_PIN_CURRENT_NOTE,
    ACTION_QUICK_NOTE,
];

/// 启动时的默认绑定（`openSettings` / `toggleTiles` 默认不占用全局键位）
pub fn default_bindings() -> Vec<(String, Shortcut)> {
    vec![
        (ACTION_NEW_NOTE.to_string(), new_note_shortcut()),
        (ACTION_TOGGLE_WINDOW.to_string(), toggle_window_shortcut()),
    ]
}

/* --------------------------- 动作注册表（进程内） --------------------------- */

/// 动作注册表：**以 `Shortcut` 本身为键**（`global-hotkey` 的 `HotKey` 派生了
/// `PartialEq/Eq/Hash`，字段为 `{mods, key, id}`），值为动作 id。
///
/// ⚠️ **不要改回「用 `into_string()` 做字符串键」**：插件把 Ctrl 序列化成
/// `control`，而用户输入/设置页展示用的是 `Ctrl` —— 两者归一化后不一致，
/// 会导致用户自定义成 `Ctrl+Alt+N` 后**静默不触发**（t17 实现期已踩到此坑，
/// 由单测 `shortcut_canonical_key_matches_registered_one` 守住）。
/// 直接用结构体做键则与插件回调里 `shortcut == &registered` 的相等语义完全一致。
static ACTION_REGISTRY: OnceLock<Mutex<HashMap<CanonicalKey, String>>> = OnceLock::new();

/// 规范化键：只看**修饰键 + 主键**，忽略 `HotKey.id`。
///
/// 忽略 id 是刻意的：`id` 只是 `global-hotkey` 内部的去重编号，
/// 参与比较会让「同一组合键的不同构造」被判为不同，反而不稳。
/// `Code` 是 `keyboard-types` 的 `Copy + Eq + Hash` 枚举；`Modifiers` 是 bitflags。
type CanonicalKey = (u32 /* mods bits */, Code);

fn canonical_key(shortcut: &Shortcut) -> CanonicalKey {
    (shortcut.mods.bits(), shortcut.key)
}

fn registry() -> &'static Mutex<HashMap<CanonicalKey, String>> {
    ACTION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 把插件序列化形式转成**给人看**的可读键位（仅用于展示/回传，不参与匹配）。
///
/// 例：`control+alt+KeyN` → `ctrl+alt+n`、`shift+alt+KeyZ` → `shift+alt+z`
fn to_display_form(serialized: &str) -> String {
    serialized
        .replace("control", "ctrl")
        .replace("Key", "")
        .to_lowercase()
}

/// 用给定绑定**整体替换**动作注册表
fn replace_registry(bindings: &[(String, Shortcut)]) {
    let mut map = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.clear();
    for (action_id, shortcut) in bindings {
        map.insert(canonical_key(shortcut), action_id.clone());
    }
}

/// 查表：本次被按下的快捷键对应哪个动作
fn resolve_action(shortcut: &Shortcut) -> Option<String> {
    let map = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.get(&canonical_key(shortcut)).cloned()
}

/// 当前注册表快照（可读键位 → 动作 id；诊断 / 测试用）
#[cfg_attr(not(test), allow(dead_code))]
pub fn registry_snapshot() -> HashMap<String, String> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .map(|((mods, code), action)| {
            let shortcut = Shortcut {
                mods: Modifiers::from_bits_truncate(*mods),
                key: *code,
                id: 0,
            };
            (to_display_form(&shortcut.into_string()), action.clone())
        })
        .collect()
}

pub fn new_note_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::KeyN)
}

pub fn toggle_window_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyZ)
}

/// 本应用**默认**声明的全部全局快捷键（注册/注销的兜底依据）
pub fn all_shortcuts() -> [Shortcut; 2] {
    [new_note_shortcut(), toggle_window_shortcut()]
}

/// 按动作 id 分发（查表之后调用）
fn dispatch_action<R: Runtime>(app: &AppHandle<R>, action_id: &str) {
    match action_id {
        ACTION_NEW_NOTE => {
            // Alt+N：唤起窗口（未聚焦时也能用）+ 请求前端新建
            let _ = window::show_main(app);
            let _ = app.emit(events::NEW_NOTE_REQUESTED, ());
        }
        ACTION_TOGGLE_WINDOW => {
            // 显隐由 Rust 直接完成（窗口未聚焦时也必须生效），事件仅用于前端反馈
            let _ = window::toggle_visible(app);
            let _ = app.emit(events::TOGGLE_WINDOW_REQUESTED, ());
        }
        ACTION_OPEN_SETTINGS => {
            let _ = window::show_main(app);
            let _ = app.emit(events::OPEN_SETTINGS_REQUESTED, ());
        }
        ACTION_TOGGLE_TILES => {
            // 显隐由 Rust 直接对所有磁贴窗口完成；事件只用于主窗口 UI 同步
            let _ = tiles::set_all_visible_emit(app, None);
        }
        ACTION_PIN_CURRENT_NOTE => {
            // ⚠️ Rust **不知道**「当前笔记」是哪个（那是前端 store 的事实）。
            // 因此只唤起窗口并请求前端回填 noteId —— 刻意不在 Rust 侧缓存"当前笔记"，
            // 否则就制造了第二份可能过期的真相源（与 §4.13 同一原则）。
            let _ = window::show_main(app);
            let _ = app.emit(events::PIN_CURRENT_NOTE_REQUESTED, PinNoteHint::default());
        }
        ACTION_QUICK_NOTE => {
            // t44：**不唤起主窗口** —— 这正是本功能的意义（用户："而不是整个程序界面"）。
            // 窗口的创建/复用/聚焦全在 Rust 完成，因此**不需要新事件**：
            // 前端没有任何必须参与的事（新笔记由窗口自身保存时创建）。
            // ⚠️ 必须走 spawn 版本：全局快捷键的回调属于"事件处理器"，
            //    在这里直接 `build()` 会在 Windows 上死锁（框架文档原文见
            //    `quick_note::spawn_open_quick_note`）。
            crate::quick_note::spawn_open_quick_note(app);
        }
        other => eprintln!("[纸笺] 未知的动作 id，已忽略：{other}"),
    }
}

/// `PIN_CURRENT_NOTE_REQUESTED` 的负载。
///
/// **实际负载是 `{"noteId":null}`，不是 `{}`** —— `Option<String>` 未加
/// `skip_serializing_if`，serde 会始终输出该键（前端 TS 侧
/// `PinCurrentNotePayload { noteId: string | null }` 与此一致，读 undefined 与 null 都容错）。
/// 语义是「前端收到即用自己的 `selectedId` 回填」；Rust 刻意不缓存选中项
/// （否则会出现第二个真相源）。若将来 Rust 侧能确定 noteId（例如磁贴窗口自身触发），
/// 在此填值即可，不需要改事件名或前端契约。
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinNoteHint {
    note_id: Option<String>,
}

fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEventLike) {
    // 只在按下时触发，避免 press/release 双触发导致新建两条笔记
    if event != ShortcutEventLike::Pressed {
        return;
    }
    match resolve_action(shortcut) {
        Some(action_id) => dispatch_action(app, &action_id),
        // 注册表未命中：可能是启动注册与建表之间的极短窗口，保持静默以免噪音
        None => {}
    }
}

/// 便于单元测试的事件投影
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShortcutEventLike {
    Pressed,
    Released,
}

/// 构造已注册全局快捷键的插件
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            let kind = match event.state() {
                ShortcutState::Pressed => ShortcutEventLike::Pressed,
                ShortcutState::Released => ShortcutEventLike::Released,
            };
            on_shortcut(app, shortcut, kind);
        })
        .build()
}

/* --------------------- t17：运行时重注册（IPC 命令） --------------------- */

/// 前端下发的单条绑定：`{ id, accelerator }`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub id: String,
    /// 可读形式，如 `Alt+N` / `Ctrl+Shift+K`；空串 = 该动作不绑定
    pub accelerator: String,
}

/// 实际生效的绑定（回传给前端展示，**以真实生效值而非用户输入为准**）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBinding {
    pub id: String,
    /// 归一化后的可读键位（插件序列化形式，如 `alt+KeyN`）
    pub accelerator: String,
}

/// 注册失败的绑定（键位被占用 / 非法等），带中文原因
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedBinding {
    pub id: String,
    pub accelerator: String,
    pub reason: String,
}

/// `cmd_sync_global_shortcuts` 的返回：**永不返回 Err**，失败收集在 `failed` 里
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSyncReport {
    pub applied: Vec<AppliedBinding>,
    pub failed: Vec<FailedBinding>,
}

/// 解析一条绑定；返回 `Err(中文原因)` 表示**输入非法**
fn parse_binding(binding: &ShortcutBinding) -> Result<Option<Shortcut>, String> {
    let accelerator = binding.accelerator.trim();
    // 空串 = 显式解绑该动作（允许，且不算失败）
    if accelerator.is_empty() {
        return Ok(None);
    }
    if !SUPPORTED_ACTION_IDS.contains(&binding.id.as_str()) {
        return Err(format!(
            "未知的动作 id「{}」（支持：{}）",
            binding.id,
            SUPPORTED_ACTION_IDS.join(", ")
        ));
    }
    accelerator
        .parse::<Shortcut>()
        .map(Some)
        .map_err(|error| format!("键位「{accelerator}」无法解析：{error}"))
}

/// **原子地**重建全局快捷键绑定（t17）。
///
/// 语义与保证：
///  1. 先做**纯校验**（id 合法 / 键位可解析 / 请求内无重复键位）——
///     任一输入非法则**整体拒绝**，且**不触碰**当前已注册的快捷键
///     （否则用户把键位改坏会连默认的 Alt+N 一起丢）；
///  2. 校验通过后才 `unregister_all()` 并逐条注册；被别的程序占用等运行时失败
///     收集进 `failed`，**不 panic、不返回 Err**（沿用 `init()` 的「失败只告警」约定）；
///  3. 无论成败都重写动作注册表，使回调按**最新请求**分发；
///  4. 返回 `applied`（实际生效）与 `failed`（含中文原因），供设置页如实展示。
#[tauri::command]
pub fn cmd_sync_global_shortcuts<R: Runtime>(
    app: AppHandle<R>,
    bindings: Vec<ShortcutBinding>,
) -> ShortcutSyncReport {
    // ---- 1) 纯校验，全部通过才允许动已注册的绑定 ----
    let mut parsed: Vec<(String, Option<Shortcut>)> = Vec::with_capacity(bindings.len());
    let mut failures: Vec<FailedBinding> = Vec::new();
    // 键用 canonical_key（结构体语义），**不要用字符串比较** —— 见 registry 注释
    let mut seen: HashMap<CanonicalKey, String> = HashMap::new();

    for binding in &bindings {
        match parse_binding(binding) {
            Ok(shortcut) => {
                if let Some(shortcut) = &shortcut {
                    let key = canonical_key(shortcut);
                    if let Some(previous_id) = seen.get(&key) {
                        failures.push(FailedBinding {
                            id: binding.id.clone(),
                            accelerator: binding.accelerator.trim().to_string(),
                            reason: format!("与「{previous_id}」的键位重复"),
                        });
                        continue;
                    }
                    seen.insert(key, binding.id.clone());
                }
                parsed.push((binding.id.clone(), shortcut));
            }
            Err(reason) => failures.push(FailedBinding {
                id: binding.id.clone(),
                accelerator: binding.accelerator.trim().to_string(),
                reason,
            }),
        }
    }

    if !failures.is_empty() {
        eprintln!(
            "[纸笺] 快捷键同步被拒绝（{} 条非法/冲突），已保留原有绑定：{:?}",
            failures.len(),
            failures
        );
        return ShortcutSyncReport {
            applied: Vec::new(),
            failed: failures,
        };
    }

    // ---- 2) 校验通过：先重写注册表，再重建注册 ----
    let registry_pairs: Vec<(String, Shortcut)> = parsed
        .iter()
        .filter_map(|(id, shortcut)| shortcut.map(|s| (id.clone(), s)))
        .collect();
    replace_registry(&registry_pairs);

    unregister_all(&app);

    let mut applied = Vec::with_capacity(parsed.len());
    let mut failed = Vec::new();
    for (id, shortcut) in parsed {
        let Some(shortcut) = shortcut else {
            // 空串：显式不绑定，既不算成功也不算失败
            continue;
        };
        match app.global_shortcut().register(shortcut) {
            Ok(()) => applied.push(AppliedBinding {
                id,
                accelerator: to_display_form(&shortcut.into_string()),
            }),
            Err(error) => failed.push(FailedBinding {
                id,
                accelerator: to_display_form(&shortcut.into_string()),
                reason: format!("注册失败（可能已被其它程序占用）：{error}"),
            }),
        }
    }

    println!(
        "[纸笺] 全局快捷键已同步：{} 条生效，{} 条失败",
        applied.len(),
        failed.len()
    );
    ShortcutSyncReport { applied, failed }
}

/// 注册本应用需要的全局快捷键；返回失败的快捷键列表（不阻断启动）
///
/// 幂等：已经处于注册状态（`is_registered`）的快捷键直接跳过，
/// 避免重复注册报错 / 覆盖别的处理器。
pub fn register_all<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let manager = app.global_shortcut();
    let mut failed = Vec::new();
    for shortcut in all_shortcuts() {
        if manager.is_registered(shortcut) {
            println!("[纸笺] 全局快捷键已注册，跳过：{shortcut}");
            continue;
        }
        if let Err(error) = manager.register(shortcut) {
            failed.push(format!("{shortcut}: {error}"));
        }
    }
    failed
}

/// 注销全部全局快捷键（重新注册前或退出前调用）
pub fn unregister_all<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.global_shortcut().unregister_all();
}

/// 某个快捷键当前是否已由本应用注册（设置面板的「冲突提示」可用）
///
/// 注意：本函数只在 Tauri 运行时内可调用；前端对应
/// `@tauri-apps/plugin-global-shortcut` 的 `isRegistered()`。
///
/// 目前尚无 Rust 侧调用方（设置面板走的是 JS 侧 `isRegistered()`），
/// 保留为集成期的公开 API，故显式豁免 dead_code。
#[allow(dead_code)]
pub fn is_registered<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> bool {
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        return false;
    };
    app.global_shortcut().is_registered(shortcut)
}

/// 按 t6 契约提供的统一初始化入口（lib.rs 的 `setup` 内调用）。
///
/// **注册失败绝不 panic、也绝不返回 Err** —— 失败只打印告警并记录在返回值里，
/// 应用照常启动：窗口聚焦时前端的本地 Alt+N 兜底仍然可用，设置面板也会显示冲突提示。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    log_contract();

    // t17：启动即用**默认绑定**填充动作注册表，否则回调无法把键位映射到动作。
    // 前端稍后（设置页就绪时）会用 cmd_sync_global_shortcuts 覆盖为用户自定义值。
    replace_registry(&default_bindings());

    let failures = register_all(app);
    if failures.is_empty() {
        println!("[纸笺] 全局快捷键已注册：{NEW_NOTE_ACCELERATOR} / {TOGGLE_WINDOW_ACCELERATOR}");
        return Ok(());
    }

    for failure in &failures {
        // 被别的程序占用 / 系统限制时只告警：应用继续运行
        eprintln!("[纸笺] 全局快捷键注册失败（可能已被占用）：{failure}");
    }
    eprintln!(
        "[纸笺] 共有 {}/{} 个全局快捷键不可用；窗口聚焦时前端本地快捷键可兜底",
        failures.len(),
        all_shortcuts().len()
    );
    Ok(())
}

/// 启动时打印快捷键契约，便于与前端 `src/lib/hotkeys.ts` 的 GLOBAL_SHORTCUTS 对账
pub fn log_contract() {
    println!(
        "[纸笺] global shortcuts: {NEW_NOTE_ACCELERATOR}={}, {TOGGLE_WINDOW_ACCELERATOR}={}",
        new_note_shortcut(),
        toggle_window_shortcut()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// global-hotkey 用 DOM 风格序列化快捷键：小写、字母键写成 `KeyN`、修饰键顺序为
    /// `shift+alt+…`。因此契约常量（面向用户/前端的 "Alt+N"）需归一化 —— 去空格、小写、
    /// 去掉 `key` 前缀、按键名排序 —— 后再比较。
    fn normalize(accelerator: &str) -> String {
        let mut parts: Vec<String> = accelerator
            .replace(' ', "")
            .to_lowercase()
            .replace("key", "")
            .split('+')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        parts.sort();
        parts.join("+")
    }

    #[test]
    fn shortcuts_have_expected_accelerators() {
        assert_eq!(
            normalize(&new_note_shortcut().into_string()),
            normalize(NEW_NOTE_ACCELERATOR)
        );
        assert_eq!(
            normalize(&toggle_window_shortcut().into_string()),
            normalize(TOGGLE_WINDOW_ACCELERATOR)
        );
    }

    #[test]
    fn all_shortcuts_lists_both() {
        let all = all_shortcuts();
        assert_eq!(all.len(), 2);
        assert!(all.contains(&new_note_shortcut()));
        assert!(all.contains(&toggle_window_shortcut()));
    }

    #[test]
    fn pressed_only_triggers() {
        assert_ne!(ShortcutEventLike::Pressed, ShortcutEventLike::Released);
    }

    /* ------------------------- t17：动作注册表 ------------------------- */

    /// 把用户输入解析成 `Shortcut`（与命令里的解析路径一致）
    fn sc(accelerator: &str) -> Shortcut {
        accelerator
            .parse::<Shortcut>()
            .unwrap_or_else(|e| panic!("「{accelerator}」应可解析：{e}"))
    }

    /// 注册表是**进程级全局状态**，而 cargo 默认并行跑测试 —— 多个用例同时改写它
    /// 会互相踩（实测 5 次运行里 2 次失败）。这里用一个测试专用互斥锁把
    /// 「改写 + 断言」整段串行化，保证测试确定通过。返回的 guard 需存活到断言结束。
    static REGISTRY_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn set_registry_for_test(bindings: &[(String, Shortcut)]) -> std::sync::MutexGuard<'static, ()> {
        let guard = REGISTRY_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        replace_registry(bindings);
        guard
    }

    #[test]
    fn shortcut_canonical_key_matches_registered_one() {
        // ⚠️ 这条是 t17 的核心回归：注册表必须用**结构体**匹配，
        // 不能用 into_string() 字符串匹配 —— 插件把 Ctrl 序列化成 `control`，
        // 而用户输入是 `Ctrl`，字符串归一化会让自定义键位**静默不触发**。
        let _guard = set_registry_for_test(&[(ACTION_NEW_NOTE.to_string(), sc("Ctrl+Alt+N"))]);
        let registered = sc("Ctrl+Alt+N");

        // 回调拿到的那个 Shortcut（同解析路径）必须命中
        assert_eq!(
            resolve_action(&sc("Ctrl+Alt+N")).as_deref(),
            Some(ACTION_NEW_NOTE),
            "同一组合键必须命中注册表"
        );
        // 证明字符串形式确实不同（即：若按字符串匹配就会失败）
        assert_ne!(
            registered.into_string(),
            "ctrl+alt+n",
            "插件序列化形式与可读形式不同 —— 这正是不能用字符串做键的原因"
        );
        // 展示形式已归一化为可读键位（**修饰键顺序由插件规范化为 shift→alt→…，
        // 不能断言用户输入的书写顺序**，那是插件的序列化细节）
        assert_eq!(to_display_form(&registered.into_string()), "ctrl+alt+n");

        // 不同主键不得命中
        assert_eq!(resolve_action(&sc("Ctrl+Alt+M")), None);

        // 不同修饰键组合必须落到不同的 canonical key（结构体语义的要点）
        assert_ne!(
            canonical_key(&sc("Ctrl+Alt+N")),
            canonical_key(&sc("Alt+N")),
            "Ctrl+Alt+N 与 Alt+N 必须是不同的键"
        );
    }

    #[test]
    fn default_bindings_are_unique_and_cover_the_shipped_actions() {
        let _guard = set_registry_for_test(&default_bindings());
        let bindings = default_bindings();
        // 默认只注册「已上线」的两个动作；openSettings / toggleTiles 默认不占全局键位
        let ids: Vec<&str> = bindings.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&ACTION_NEW_NOTE));
        assert!(ids.contains(&ACTION_TOGGLE_WINDOW));
        assert!(!ids.contains(&ACTION_OPEN_SETTINGS));

        let mut keys: Vec<CanonicalKey> =
            bindings.iter().map(|(_, s)| canonical_key(s)).collect();
        keys.sort_by_key(|(m, c)| (*m, format!("{c:?}")));
        keys.dedup();
        assert_eq!(keys.len(), bindings.len(), "默认键位不得互相冲突");

        // 默认键位必须与前端 `GLOBAL_SHORTCUTS` 镜像**语义等价**：
        // 用 canonical_key 比较（而非展示字符串），避免被插件的书写顺序细节绊倒
        assert_eq!(
            canonical_key(&default_bindings()[0].1),
            canonical_key(&sc(NEW_NOTE_ACCELERATOR))
        );
        assert_eq!(
            canonical_key(&default_bindings()[1].1),
            canonical_key(&sc(TOGGLE_WINDOW_ACCELERATOR))
        );
        // 展示形式可读（供设置页回显），仅断言「包含必要的键名」
        let toggle_display = to_display_form(&sc(TOGGLE_WINDOW_ACCELERATOR).into_string());
        assert!(
            toggle_display.contains("alt") && toggle_display.contains("shift") && toggle_display.ends_with('z'),
            "展示形式应含 alt/shift/z，实际={toggle_display}"
        );
    }

    #[test]
    fn registry_replaces_whole_map() {
        // 整体替换语义：旧绑定必须消失
        let _guard = set_registry_for_test(&[(ACTION_NEW_NOTE.to_string(), sc("Ctrl+Alt+N"))]);
        let snapshot = registry_snapshot();
        assert_eq!(
            snapshot.get("ctrl+alt+n").map(String::as_str),
            Some(ACTION_NEW_NOTE),
            "快照应使用可读键位：{snapshot:?}"
        );
        // 默认的 Alt+N 已不在表中
        assert!(!snapshot.contains_key("alt+n"), "旧绑定应被整体替换：{snapshot:?}");
    }

    #[test]
    fn unbound_accelerator_resolves_to_none() {
        let _guard = set_registry_for_test(&default_bindings());
        assert_eq!(
            resolve_action(&sc("Ctrl+Alt+Q")),
            None,
            "未绑定的键不应命中任何动作"
        );
    }

    /// 命令里的「请求内重复键位」预检逻辑（提取为纯函数以便单测）
    fn find_duplicate(bindings: &[(String, Shortcut)]) -> Option<String> {
        let mut seen: HashMap<CanonicalKey, String> = HashMap::new();
        for (id, shortcut) in bindings {
            let key = canonical_key(shortcut);
            if let Some(previous) = seen.get(&key) {
                return Some(format!("{id} 与 {previous} 重复"));
            }
            seen.insert(key, id.clone());
        }
        None
    }

    #[test]
    fn duplicate_accelerators_are_detected() {
        // 注意：两种写法必须被判为同一个键（结构体语义，不是字符串）
        let conflict = vec![
            (ACTION_NEW_NOTE.to_string(), sc("Ctrl+K")),
            (ACTION_OPEN_SETTINGS.to_string(), sc("Ctrl+K")),
        ];
        assert!(find_duplicate(&conflict).is_some(), "同一键位的两条绑定应判为冲突");

        let ok = vec![
            (ACTION_NEW_NOTE.to_string(), sc("Ctrl+K")),
            (ACTION_OPEN_SETTINGS.to_string(), sc("Ctrl+L")),
        ];
        assert!(find_duplicate(&ok).is_none(), "不同键位不应判为冲突");
    }

    /* --------------------- t17：输入校验（纯函数层） --------------------- */

    fn binding(id: &str, accelerator: &str) -> ShortcutBinding {
        ShortcutBinding {
            id: id.to_string(),
            accelerator: accelerator.to_string(),
        }
    }

    #[test]
    fn parse_binding_accepts_known_actions_and_empty_means_unbind() {
        // 任意已支持 id 都应可解析（含 toggleTiles / pinNote）
        for id in SUPPORTED_ACTION_IDS {
            let parsed = parse_binding(&binding(id, "Alt+N"));
            assert!(parsed.is_ok(), "id={id} 应被接受：{:?}", parsed.err());
        }
        // 空串 = 显式解绑：Ok(None)，既不是错误也不算成功
        let unbound = parse_binding(&binding(ACTION_TOGGLE_TILES, "   "));
        assert!(matches!(unbound, Ok(None)), "空白应按「不绑定」处理");
    }

    #[test]
    fn parse_binding_rejects_unknown_id_and_bad_accelerator() {
        let unknown = parse_binding(&binding("notAnAction", "Alt+N"));
        assert!(unknown.is_err(), "未知 id 必须被拒绝");
        assert!(
            unknown.unwrap_err().contains("未知的动作 id"),
            "拒绝原因应是中文可读文案"
        );

        let bad = parse_binding(&binding(ACTION_NEW_NOTE, "NotARealKey+++"));
        assert!(bad.is_err(), "非法键位必须被拒绝");
        assert!(
            bad.unwrap_err().contains("无法解析"),
            "拒绝原因应说明无法解析"
        );
    }
}
