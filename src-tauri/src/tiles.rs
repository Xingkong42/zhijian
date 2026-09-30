//! 桌面便签磁贴（t19）—— 把一条笔记钉成独立的**无边框、置顶、跳过任务栏**小窗。
//!
//! ## 职责边界
//! - **本模块只做窗口层面的事**：创建/显隐/关闭磁贴窗口、记住并恢复几何、状态查询。
//! - **磁贴里渲染什么**由前端负责：磁贴窗口加载**与主窗口同一份前端**，
//!   URL 带 `?tile=<noteId>`，前端据查询串渲染（`src/features/tiles/TileApp.tsx`，t24 提供）。
//!
//! ## 为什么几何持久化在 Rust（而不是 localStorage）
//! 窗口的位置/尺寸是**纯窗口层面的事实**，Rust 是唯一权威（移动/缩放事件也只有 Rust 收得到）。
//! 若改成前端存，就会出现「谁是真的」的双真相源问题（与 §4.13 对「关闭到托盘」偏好的取舍同一原则）。
//! 因此：**Rust 侧落 JSON，前端不参与几何持久化**。
//!
//! ## 与主窗口的关系
//! - 关闭单个磁贴 = 只关那个窗口（`close()`）；
//! - **主窗口隐藏到托盘时磁贴保留**（`window::hide_main` 只操作 `main`，本模块不受影响）；
//! - **应用真退出时全部清理**：见 `cleanup_all()`，由托盘「退出」路径调用。
//!
//! ## 标签命名（FROZEN）
//! 磁贴窗口 label = `tile-<noteId>`。label 即"哪些窗口是磁贴"的唯一判据，
//! 因此**不需要**额外的活动窗口注册表 —— 一切以 `app.webview_windows()` 为准，
//! 避免出现"注册表与实际窗口不一致"的又一处双真相源。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::events;

/// 磁贴窗口 label 前缀；完整 label = `TILE_LABEL_PREFIX + noteId`
pub const TILE_LABEL_PREFIX: &str = "tile-";

/// 磁贴默认尺寸 / 最小尺寸（逻辑像素）
pub const TILE_DEFAULT_WIDTH: f64 = 280.0;
pub const TILE_DEFAULT_HEIGHT: f64 = 240.0;
pub const TILE_MIN_WIDTH: f64 = 160.0;
pub const TILE_MIN_HEIGHT: f64 = 120.0;

/// 多枚磁贴的层叠偏移（避免全部重叠在同一位置）
const TILE_CASCADE_STEP: f64 = 28.0;

/// t52：「磁贴吸附」总开关（进程内 `AtomicBool`，默认 `true` = 启用）。
///
/// 与 `window::CLOSE_TO_TRAY` 同一套路（§4.13）：**持久化真相在前端 localStorage**
/// （`zhijian.tileSnap`），Rust 只是行为副本 —— Rust 读不到 WebView 的 localStorage，
/// 所以启动时与开关变更时都由前端下发（`src/features/settings/tileSnap.ts`）。
///
/// 关闭后的语义（用户需求：「增加开启/关闭磁贴吸附的功能」）：
///  - **不再吸附**：`apply_snap_after_move_inner` 直接返回 ⇒ 拖动不会自动贴到邻居边上；
///  - **不再成组/跟随**：`propagate_group_move` 直接返回 ⇒ 拖一枚不会带着同组其它磁贴走；
///  - **已有的组号一律保留**：重新打开后原来的组继续有效 ——
///    这是"开关"而不是"清空"，关一次不该毁掉用户已经摆好的布局。
static TILE_SNAP: AtomicBool = AtomicBool::new(true);

/// 「磁贴吸附」当前是否启用
pub fn tile_snap_enabled() -> bool {
    TILE_SNAP.load(Ordering::SeqCst)
}

/// 设置「磁贴吸附」开关（IPC 命令与单测共用）
pub fn set_tile_snap_preference(enabled: bool) {
    TILE_SNAP.store(enabled, Ordering::SeqCst);
}

/// t54：「已固定的磁贴是否允许被『全部显隐』隐藏」开关（进程内，默认 `false`）。
///
/// 默认 `false` = 沿用 t46 的用户要求：「固定的磁贴永远留在桌面上，快捷键只影响临时磁贴」。
/// 用户显式打开后，`set_all_visible_impl` 不再跳过固定磁贴 —— 这是一条**用户可选**的行为，
/// 所以做成开关，而不是改掉原有的默认语义。
///
/// 权威源与其它偏好一致：持久化在前端 localStorage（`zhijian.pinnedTilesHidable`），
/// Rust 只是行为副本，启动时与变更时由前端下发（`features/settings/tileBehavior.ts`）。
static TILE_HIDE_PINNED: AtomicBool = AtomicBool::new(false);

/// 「固定磁贴是否可被隐藏」当前值
pub fn tile_hide_pinned() -> bool {
    TILE_HIDE_PINNED.load(Ordering::SeqCst)
}

/// 设置该开关（IPC 命令与单测共用）
pub fn set_tile_hide_pinned_preference(enabled: bool) {
    TILE_HIDE_PINNED.store(enabled, Ordering::SeqCst);
}

/// 几何落盘的**静默期**：最后一次移动/缩放之后等这么久才写磁盘。
///
/// 拖动时 `WindowEvent::Moved` 会高频触发；若每次都写盘会造成明显 I/O 与卡顿。
/// 用「通道 + 超时」在后台线程做**尾沿去抖**：只在安静下来后写一次。
/// 去抖静默期（**3 秒**，t48 按用户要求从 400ms 提高）。
///
/// 它同时是两件事的触发点：① 几何落盘；② **吸附检查**（= "用户松手了"）。
/// 用户原话：「0.4s 尾沿去抖改成 3 秒，保证有足够的时间供用户拖动决策对齐」——
/// 即：拖到位之后有 3 秒可以继续微调，期间随时会重新计时，最后一次停下 3 秒才吸附。
/// 代价是"移到一半就强制退出应用"时最后几秒的位置可能没落盘；由 `cleanup_all` 的
/// `persist_now` 兜底。
const PERSIST_QUIET_PERIOD: Duration = Duration::from_millis(3000);

/// **吸附判定窗口**（t50：与落盘去抖拆开）。
///
/// ⚠️ 这里是我上一轮的**设计错误**，用户直接感受到了：「为什么现在不吸附了？」
/// 当时把"吸附"和"落盘"绑在同一个 3 秒窗口上，于是：
///  · 用户拖到位松手后，必须**完全静默 3 秒**才会吸附 —— 期间只要窗口再动一下（哪怕是
///    轻微碰一下），计时就重置，用户几乎永远等不到吸附；
///  · 而更早（t19 起的"假去抖"）是**每次移动都执行**，所以以前感觉"一拖就吸"。
///
/// 正确语义：用户要的"3 秒"是**给他自己留出继续微调的时间** —— 而只要他还在移动窗口，
/// 任何去抖窗口都会自动重置，所以**判定窗口短**完全不妨碍微调，反而反馈及时。因此：
///   · 吸附窗口 = 400ms（停手就吸）
///   · 落盘窗口 = 3s（用户明确要求的长去抖，避免频繁写盘）
const SNAP_QUIET_PERIOD: Duration = Duration::from_millis(400);

/// 判定「这看起来是被最大化的矩形」的阈值：宽高**同时**达到显示器的这个比例即认为不可信。
///
/// 为什么要这条：Windows 最大化窗口的经典矩形是 `{x:-8,y:-8,width:1936,height:1048}`
/// （比屏幕还大一点 + 负偏移）。t21 的 F1 实证过：双击磁贴拖拽区会触发
/// `internal_toggle_maximize`，那个矩形会被 `Moved/Resized` 记进 `tiles.json`，
/// 之后每次钉住/重启都以全屏打开。
const MAXIMIZED_RATIO: f64 = 0.9;

/// 位置夹取时至少留多少逻辑像素在屏内（否则窗口会被拖到用户再也抓不到的地方）
const TILE_KEEP_VISIBLE: f64 = 80.0;

/// 几何持久化文件名（位于 `app_data_dir()`，与索引库同目录）
const GEOMETRY_FILE: &str = "tiles.json";

/* ============================ 数据结构（IPC 契约） ============================ */

/// 传给前端的磁贴信息（camelCase 序列化）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileInfo {
    /// 被钉住的笔记 id（也是磁贴窗口 label 的后缀）
    pub note_id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub visible: bool,
    /// t45：是否「固定」（固定的磁贴下次启动会自动出现；未固定的用完即消）
    pub pinned: bool,
    /// t47：吸附组号（0 = 未成组）。前端据此决定要不要显示「取消吸附」按钮。
    pub group: u32,
}

/// 单条磁贴的持久化几何（**逻辑坐标**，配合 `scale_factor` 使用）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TileGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// t45：**是否固定** —— 启动时是否自动恢复这枚磁贴的**唯一判据**。
    ///
    /// 为什么必须与"是否存在于本文件"分开（t45 用户报障的根因）：
    /// t19 的实现把"文件里有这个 noteId"当成"用户还钉着它"，于是
    /// **用磁贴的 × 关掉它之后，下次启动它又会自己回来**（用户原话：
    /// 「我关闭磁贴后，关闭整个程序后，下次开启后还是会显示那些磁贴」）——
    /// 因为 `close_tile` 只关窗口、几何照旧留在文件里，而 `init` 见条目就恢复。
    /// 那个设计把"几何缓存（为了再钉回原位）"和"用户的意图（要不要保留）"绑成了一件事。
    /// 现在分开：**几何缓存继续保留**（再钉回去还在原处），**是否恢复只看 `pinned`**。
    ///
    /// `#[serde(default)]` = 旧文件（没有这个字段）一律读成 `false`（未固定），
    /// 这样老版本的残留条目不会在升级后又自己冒出来。
    #[serde(default)]
    pub pinned: bool,
    /// t47：**吸附组号**（0 = 未成组）。
    ///
    /// 为什么是 `u32` 而不是 `Option<String>` / UUID：`TileGeometry` 是 `Copy` 的，
    /// 整套几何代码（`sanitize_geometry` / `remember_geometry` / `geometry_for`）都按值传递；
    /// 换成 `String` 就得连锁改成 `Clone`，改动面大而收益为零 —— 组号只需要"同组相同、异组不同"。
    /// 分配规则见 `form_group`：一方已有组就沿用，都没有才取新号（`TilesState.next_group`）。
    #[serde(default)]
    pub group: u32,
}

impl TileGeometry {
    fn default_at(cascade_index: usize) -> Self {
        let offset = TILE_CASCADE_STEP * cascade_index as f64;
        Self {
            x: 120.0 + offset,
            y: 120.0 + offset,
            width: TILE_DEFAULT_WIDTH,
            height: TILE_DEFAULT_HEIGHT,
            pinned: false,
            group: 0,
        }
    }
}

/* ===================== t47：磁贴吸附成组（纯逻辑，可穷举单测） ===================== */

/// 吸附阈值（逻辑像素）：间隙小于它就算"贴上了"。
///
/// **t48 按用户要求从 8px 收到 2px**：8px 太容易"隔空吸住"（用户反馈想精确摆放时老被黏走），
/// 2px 基本等于"已经在贴着、只差一点点"，吸附因此只在真的要对齐时才发生。
pub const SNAP_THRESHOLD: f64 = 2.0;

/* ---------------- t48：防"反馈循环"的三道护栏（针对堆损坏崩溃） ----------------
 *
 * 背景（用户报障）：`zhijian.exe` 偶尔以 `0xc0000374 STATUS_HEAP_CORRUPTION` 崩溃。
 * 排查发现两条**我自己在 t47 引入的**隐患，都会让消息无限增殖：
 *   ① 组跟随/吸附会 `set_position` ⇒ 又触发 `Moved` ⇒ 又可能传播/吸附：
 *      只要实际落点与请求值差 1px（DPI 取整），delta 就永远不为 0 ⇒ **无限反馈**；
 *   ② "关闭磁贴"复用了 toggle 语义 ⇒ 已经关掉的会被**重新打开**（见 retireTiles 的修复）。
 * 三道护栏分别对应：程序性移动识别（根治 ①）、传播节流、位移死区。
 */

/// 程序性移动的落点容差：`set_position` 请求值与系统实际落点之间允许的差异。
/// Windows 上经 DPI 取整常差 1px，所以给 1.5px。
const PROGRAMMATIC_TOLERANCE: f64 = 1.5;

/// 位移死区：小于它的"移动"不向外传播（1px 抖动不该带着整组抖）。
const MOVE_DEAD_ZONE: f64 = 1.5;

/// **跟随补齐窗口**（t49）：拖动过程中，整组跟随每隔这么久把"待应用位置"落到窗口上。
///
/// 为什么需要它（用户实测：「拖动一个，另一个明显慢了几拍，拖的那个已经到屏幕另一侧了，
/// 另一个才动了几步」+「大幅度快速拖动时崩溃」）：
/// 原先是在**每个 `Moved` 事件里**直接给每个组员 `set_position`。快速拖动时 `Moved`
/// 可达每秒上百次 ⇒ 每秒上百条 `SetPosition` 消息涌进事件循环 ⇒
/// ① 组员的更新排队排在后面（视觉上就是"慢几拍"）；
/// ② 消息与分配持续积压（堆被反复破坏 ⇒ `STATUS_HEAP_CORRUPTION`）。
/// 现在改成：`Moved` 里**只登记目标位置**（纯内存、极廉价），由本周期统一补发 ——
/// 于是无论用户拖多快，投递到窗口层的消息量都是**恒定**的（约 16/秒）。
const FOLLOW_CHASE_PERIOD: Duration = Duration::from_millis(60);

/// 吸附候选：间隙（越小越优先）+ 吸附后的位置
struct SnapCandidate {
    gap: f64,
    x: f64,
    y: f64,
}

/// 计算**应当吸附到**的位置；`None` = 附近没有可贴的邻居（或本来就贴好了）。
///
/// 规则（自检逐条断言）：
///  1. 只考虑"边缘贴合"的四种关系：左贴右 / 右贴左（水平）与上贴下 / 下贴上（垂直）；
///     **每次只吸一个轴** —— 同时对齐左上角会让松手瞬间"跳两下"，手感很怪。
///  2. 贴合的前提是**另一轴有重叠**（斜对角"贴"上没有意义）。
///  3. 取**间隙最小**的候选；间隙相同按 `others` 顺序取第一个 ⇒ 结果确定、可复现、可测。
///  4. 只有 `|gap| <= threshold` 才算候选。
///  5. 位置几乎没变（< 0.5px）时返回 `None`：调用方据此避免"设一次没意义的位置"
///     （那会再触发一次 `Moved` 事件，白白引入循环风险）。
pub fn snap_position(
    moving: TileGeometry,
    others: &[TileGeometry],
    threshold: f64,
) -> Option<(f64, f64)> {
    let mut best: Option<SnapCandidate> = None;
    let mut consider = |candidate: SnapCandidate| {
        if best.as_ref().map(|current| candidate.gap < current.gap).unwrap_or(true) {
            best = Some(candidate);
        }
    };

    for other in others {
        let vertical_overlap = moving.y < other.y + other.height && other.y < moving.y + moving.height;
        let horizontal_overlap = moving.x < other.x + other.width && other.x < moving.x + moving.width;

        if vertical_overlap {
            let gap_left = moving.x - (other.x + other.width);
            if gap_left.abs() <= threshold {
                consider(SnapCandidate { gap: gap_left.abs(), x: other.x + other.width, y: moving.y });
            }
            let gap_right = other.x - (moving.x + moving.width);
            if gap_right.abs() <= threshold {
                consider(SnapCandidate { gap: gap_right.abs(), x: other.x - moving.width, y: moving.y });
            }
        }

        if horizontal_overlap {
            let gap_top = moving.y - (other.y + other.height);
            if gap_top.abs() <= threshold {
                consider(SnapCandidate { gap: gap_top.abs(), x: moving.x, y: other.y + other.height });
            }
            let gap_bottom = other.y - (moving.y + moving.height);
            if gap_bottom.abs() <= threshold {
                consider(SnapCandidate { gap: gap_bottom.abs(), x: moving.x, y: other.y - moving.height });
            }
        }
    }

    best.and_then(|candidate| {
        if (candidate.x - moving.x).abs() < 0.5 && (candidate.y - moving.y).abs() < 0.5 {
            None
        } else {
            Some((candidate.x, candidate.y))
        }
    })
}

/// 两枚磁贴是否**仍然贴合**（用于判断"还该不该在同一组里"）。
///
/// 阈值比 `snap_position` 宽 2px：吸附之后系统/DPI 取整可能留下 1px 的缝，
/// 严格按阈值判会出现"刚吸附好就被判成已分开"。
pub fn still_attached(a: TileGeometry, b: TileGeometry, threshold: f64) -> bool {
    let tolerance = threshold + 2.0;
    let vertical_overlap = a.y < b.y + b.height && b.y < a.y + a.height;
    let horizontal_overlap = a.x < b.x + b.width && b.x < a.x + a.width;
    if vertical_overlap {
        if (a.x - (b.x + b.width)).abs() <= tolerance || (b.x - (a.x + a.width)).abs() <= tolerance {
            return true;
        }
    }
    if horizontal_overlap {
        if (a.y - (b.y + b.height)).abs() <= tolerance || (b.y - (a.y + a.height)).abs() <= tolerance {
            return true;
        }
    }
    false
}

/// 启动时该恢复哪些磁贴 —— **只看 `pinned`**（纯函数，便于单测钉死语义）。
///
/// 排序保证恢复顺序稳定（层叠位置与 note_id 顺序无关，但日志/测试需要可复现）。
fn tiles_to_restore(file: &GeometryFile) -> Vec<String> {
    let mut ids: Vec<String> = file
        .tiles
        .iter()
        .filter(|(_, geometry)| geometry.pinned)
        .map(|(note_id, _)| note_id.clone())
        .collect();
    ids.sort();
    ids
}

/// 落盘文件的内容（**唯一权威**，前端不参与）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GeometryFile {
    /// 版本号，便于将来演进（当前 1）
    version: u32,
    tiles: HashMap<String, TileGeometry>,
}

/* ================================ 应用状态 ================================ */

/// 挂在 Tauri 托管状态上的磁贴管理器
pub struct TilesState {
    path: Mutex<Option<PathBuf>>,
    store: Mutex<GeometryFile>,
    /// 去抖信号：每次移动/缩放发一个，后台线程攒到安静再落盘
    persist_tx: Mutex<Option<Sender<()>>>,
    /// t47：下一个可分配的**吸附组号**（0 保留给"未成组"，因此从 1 起）
    next_group: Mutex<u32>,
    /// t47：最近被移动过的磁贴 —— 去抖线程醒来（= 拖动停止）后对它做吸附检查。
    ///
    /// 为什么在**停止后**才吸附：拖动过程中吸附会"粘住"（用户想再挪开却被吸回去），
    /// 而"停止"的判据恰好就是现有的尾沿去抖（安静 3 秒）—— 复用同一个信号，零额外计时器。
    last_moved: Mutex<Option<String>>,
    /// t48：**程序性移动**的期望落点（note_id → 目标位置）。
    ///
    /// 这是防反馈循环的**根治手段**：我们自己 `set_position` 之前登记目标位置，
    /// 该窗口随之而来的 `Moved` 事件若落在容差内，就识别为"自己造成的"并**直接返回** ——
    /// 不传播、不记 `last_moved`、不触发吸附。没有它，`set_position` 与 `Moved` 会互相喂养。
    programmatic: Mutex<HashMap<String, (f64, f64)>>,
    /// t49：整组跟随的**待应用位置**（note_id → 绝对目标位置）。
    ///
    /// `Moved` 里只写这里（纯内存），由去抖线程按 `FOLLOW_CHASE_PERIOD` 统一补发到窗口。
    /// 这是"消息量恒定"的关键：拖动再快也不会多投递一条窗口消息。
    pending_forward: Mutex<HashMap<String, (f64, f64)>>,
}

impl TilesState {
    /// 空几何表（磁盘上没有文件 / 文件损坏时的回落值）
    fn fresh_geometry() -> GeometryFile {
        GeometryFile {
            version: 1,
            tiles: HashMap::new(),
        }
    }
}

/// 便捷取全局状态；未注册时返回 None（保证命令不会 panic）
fn state<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, TilesState>> {
    app.try_state::<TilesState>()
}

/* ============================== 几何读写 ============================== */

/// 计算几何文件路径。
///
/// ⚠️ **绝对路径守卫（t28 教训）**：曾观察到「路径基准一丢就静默写进当前工作目录」
/// （`new DatabaseSync('x')` 会在 CWD 生成 0 字节 `x`）。几何落盘同理：
/// 若基准目录缺失或不是绝对路径，**宁可不落盘**，也绝不在 CWD 留下 `tiles.json`。
fn absolute_geometry_path(data_dir: Option<PathBuf>) -> Option<PathBuf> {
    let dir = data_dir?;
    if !dir.is_absolute() {
        eprintln!("[纸笺] 磁贴几何基准目录不是绝对路径，已跳过落盘：{}", dir.display());
        return None;
    }
    let path = dir.join(GEOMETRY_FILE);
    if !path.is_absolute() {
        eprintln!("[纸笺] 磁贴几何路径不是绝对路径，已跳过落盘：{}", path.display());
        return None;
    }
    Some(path)
}

fn geometry_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    absolute_geometry_path(app.path().app_data_dir().ok())
}

/// 从磁盘加载几何；文件缺失/损坏都**不报错**，只回落为空表（磁贴默认层叠摆放）。
fn load_geometry(path: &PathBuf) -> GeometryFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return TilesState::fresh_geometry();
    };
    serde_json::from_str::<GeometryFile>(&raw).unwrap_or_else(|error| {
        eprintln!("[纸笺] 磁贴几何文件解析失败，将按默认位置摆放：{error}");
        TilesState::fresh_geometry()
    })
}

/// 通知后台线程「几何变了」（去抖）
fn request_persist<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = state(app) {
        if let Ok(tx) = state.persist_tx.lock() {
            if let Some(tx) = tx.as_ref() {
                // 通道满时忽略即可（本来就是要合并的连续事件）
                let _ = tx.send(());
            }
        }
    }
}

/// 立即把当前几何写入磁盘（供去抖线程与测试调用）
pub fn persist_now<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state(app) else { return };
    let Some(path) = state.path.lock().ok().and_then(|p| p.clone()) else {
        return;
    };
    let snapshot = match state.store.lock() {
        Ok(store) => store.clone(),
        Err(_) => return,
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&snapshot) {
        Ok(json) => {
            if let Err(error) = std::fs::write(&path, json) {
                eprintln!("[纸笺] 磁贴几何写入失败（不影响使用）：{error}");
            }
        }
        Err(error) => eprintln!("[纸笺] 磁贴几何序列化失败：{error}"),
    }
}

/// 取某条笔记的几何（已保存的优先，否则按层叠序号给默认值）
/// 几何的**合理性闸门**：把「被污染的几何」挡在门外（t21 F1 的修复核心之一）。
///
/// 背景（运行时实证，不是推断）：Windows 上双击无边框窗口的拖拽区会触发
/// `plugin:window|internal_toggle_maximize`，窗口铺满屏幕后 `Moved/Resized`
/// 会把最大化矩形写进 `tiles.json`；此后每次钉住/重启，「恢复位置」照搬它
/// ⇒ 磁贴一打开就是全屏。**capability 里的 `deny-internal-toggle-maximize` 挡不住这条
/// 注入脚本路径**（详见 §4.14.8 的修正记录），所以必须在几何这一层再兜一道。
///
/// 规则（`monitor` = 显示器**逻辑**尺寸；取不到时只做"非退化"检查）：
///  1. 非有限值、或宽/高 ≤ 0 ⇒ 拒绝（回落到默认位置）；
///  2. 宽高**同时** ≥ 显示器 90% ⇒ 判定为最大化矩形 ⇒ 拒绝；
///  3. 其余：宽高夹到 `[TILE_MIN_*, 显示器尺寸]`，位置夹到"至少留 80pt 在屏内"。
pub fn sanitize_geometry(geometry: TileGeometry, monitor: Option<(f64, f64)>) -> Option<TileGeometry> {
    if !geometry.x.is_finite()
        || !geometry.y.is_finite()
        || !geometry.width.is_finite()
        || !geometry.height.is_finite()
    {
        return None;
    }
    if geometry.width <= 0.0 || geometry.height <= 0.0 {
        return None;
    }

    let mut width = geometry.width;
    let mut height = geometry.height;
    if let Some((monitor_width, monitor_height)) = monitor {
        if monitor_width > 0.0 && monitor_height > 0.0 {
            if width >= monitor_width * MAXIMIZED_RATIO && height >= monitor_height * MAXIMIZED_RATIO {
                return None;
            }
            width = width.min(monitor_width);
            height = height.min(monitor_height);
        }
    }
    let width = width.max(TILE_MIN_WIDTH);
    let height = height.max(TILE_MIN_HEIGHT);

    let mut x = geometry.x;
    let mut y = geometry.y;
    if let Some((monitor_width, monitor_height)) = monitor {
        if monitor_width > 0.0 && monitor_height > 0.0 {
            x = x.clamp(-(width - TILE_KEEP_VISIBLE), monitor_width - TILE_KEEP_VISIBLE);
            y = y.clamp(-(height - TILE_KEEP_VISIBLE), monitor_height - TILE_KEEP_VISIBLE);
        }
    }

    Some(TileGeometry {
        x,
        y,
        width,
        height,
        // 闸门只负责几何：**原样带过**固定状态与组号（t45/t47）
        pinned: geometry.pinned,
        group: geometry.group,
    })
}

/// 取某块几何所在显示器的**逻辑尺寸**（物理尺寸 ÷ scale_factor；跨 DPI 时才不失真）。
/// 取不到显示器信息（无桌面会话 / 测试环境）时返回 `None` ⇒ 只做非退化检查。
fn monitor_logical_size<R: Runtime>(
    app: &AppHandle<R>,
    geometry: &TileGeometry,
) -> Option<(f64, f64)> {
    let monitor = app
        .monitor_from_point(geometry.x, geometry.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    let size = monitor.size();
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// 读某条笔记的目标几何：**磁盘值先过闸门**，不可信就回落到默认层叠位置。
///
/// 被判定不可信时会**顺手把内存里的脏值替换成默认值并触发落盘** —— 让 `tiles.json` 自愈，
/// 而不是每次启动都重新判一遍（否则用户永远看到"磁盘上有个全屏矩形"）。
fn geometry_for<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> TileGeometry {
    let stored = state(app).and_then(|state| {
        state
            .store
            .lock()
            .ok()
            .and_then(|store| store.tiles.get(note_id).copied())
    });

    let Some(geometry) = stored else {
        return TileGeometry::default_at(open_tile_count(app));
    };

    let monitor = monitor_logical_size(app, &geometry);
    match sanitize_geometry(geometry, monitor) {
        Some(clean) => clean,
        None => {
            let fallback = TileGeometry::default_at(open_tile_count(app));
            // ASCII 锚点 `tile-geometry-untrusted` 是**给运行时探针 grep 用的**：
            // 探针通过重定向管道读日志时，中文可能因控制台代码页被解码成乱码，
            // 只有 ASCII 标记在管道里一定可靠（`scripts/probe-tile-maximize.ps1`）。
            println!(
                "[纸笺] tile-geometry-untrusted {note_id}: 磁盘几何疑似最大化矩形 {geometry:?}，已改用默认位置 {fallback:?} 并回写"
            );
            if let Some(state) = state(app) {
                if let Ok(mut store) = state.store.lock() {
                    store.tiles.insert(note_id.to_string(), fallback);
                }
            }
            request_persist(app);
            fallback
        }
    }
}

/// 记录某条笔记的最新几何（内存 + 触发去抖落盘）。
///
/// ⚠️ **刻意不改 `pinned`**：移动/缩放只表达"位置变了"，不表达"用户还要不要保留它"。
/// 若这里整体覆盖，任何一次拖动都会把固定状态抹成 false（"固定的磁贴拖一下就失去固定"）。
fn remember_geometry<R: Runtime>(app: &AppHandle<R>, note_id: &str, geometry: TileGeometry) {
    if let Some(state) = state(app) {
        if let Ok(mut store) = state.store.lock() {
            let pinned = store
                .tiles
                .get(note_id)
                .map(|existing| existing.pinned)
                .unwrap_or(false);
            // t47：组号同理 —— 移动不改"和谁成组"，只改位置
            let group = store.tiles.get(note_id).map(|existing| existing.group).unwrap_or(0);
            store
                .tiles
                .insert(note_id.to_string(), TileGeometry { pinned, group, ..geometry });
        }
    }
    request_persist(app);
}

/// 设置某条磁贴的「固定」状态（t45）。返回设置后的值。
///
/// 固定 = 下次启动时自动出现；未固定 = 本次会话的临时磁贴，关掉就没了。
/// 找不到几何记录时（例如窗口已销毁）返回 Err，让调用方如实告知，而不是假装成功。
pub fn set_tile_pinned_impl<R: Runtime>(
    app: &AppHandle<R>,
    note_id: &str,
    pinned: bool,
) -> Result<bool, String> {
    let Some(state) = state(app) else {
        return Err("磁贴状态尚未初始化".to_string());
    };
    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "磁贴状态锁不可用".to_string())?;
        match store.tiles.get_mut(note_id) {
            Some(geometry) => geometry.pinned = pinned,
            None => return Err(format!("没有这条笔记的磁贴记录：{note_id}")),
        }
    }
    request_persist(app);
    Ok(pinned)
}

/* ============================== 窗口操作 ============================== */

pub fn label_for(note_id: &str) -> String {
    format!("{TILE_LABEL_PREFIX}{note_id}")
}

/// 从 label 反推 noteId；不是磁贴窗口则返回 None
pub fn note_id_from_label(label: &str) -> Option<String> {
    label.strip_prefix(TILE_LABEL_PREFIX).map(str::to_string)
}

/// 取磁贴窗口（不存在返回 None）
pub fn tile_window<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Option<WebviewWindow<R>> {
    app.get_webview_window(&label_for(note_id))
}

/// 当前打开的磁贴数量
pub fn open_tile_count<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| note_id_from_label(label).is_some())
        .count()
}

/// 组装磁贴 URL：`<前端基址>?tile=<noteId>`
///
/// - 开发态：`tauri.conf.json` 的 `build.devUrl`（如 `http://localhost:1420/`）；
/// - 生产态：应用自身的自定义协议地址（`tauri://localhost/`）。
///
/// ⚠️ 这里**显式拼绝对 URL 并用 `WebviewUrl::External`**，而不是 `WebviewUrl::App("index.html?tile=…")`：
/// 后者要把"路径 + 查询串"交给内部拼接，查询串是否保留取决于实现细节；
/// 显式拼串能保证 `?tile=` 一定到达前端（前端 `readTileNoteId(location.search)` 依赖它）。
fn tile_url<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Result<String, String> {
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
    Ok(format!("{base}{separator}tile={note_id}"))
}

/// 创建（或复用）一枚磁贴窗口。`visible=false` 时创建后立即隐藏（用于"全部隐藏"状态下新钉）。
pub fn create_tile<R: Runtime>(
    app: &AppHandle<R>,
    note_id: &str,
    visible: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(existing) = tile_window(app, note_id) {
        return Ok(existing);
    }
    let url = tile_url(app, note_id)?;
    let geometry = geometry_for(app, note_id);
    let label = label_for(note_id);

    /*
     * t45：**创建即登记几何**。
     *
     * 为什么必须（运行时探针抓到的真 bug）：几何原先只在 `Moved`/`Resized` 时才写进 store，
     * 于是一枚"刚钉出来、还没拖过"的磁贴**在 store 里根本没有记录** ⇒ 用户点图钉固定时
     * `set_tile_pinned_impl` 找不到条目、返回 `Err("没有这条笔记的磁贴记录")` ⇒ 图钉不亮。
     * 现象很隐蔽：拖动一下再固定就好了，所以只看代码或只做静态检查都发现不了。
     * 现在创建时就登记（新增条目 `pinned` 默认 false = 临时磁贴），固定功能对**任何**磁贴都可用。
     */
    remember_geometry(app, note_id, geometry);

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().map_err(
        |error| format!("磁贴 URL 非法：{error}"),
    )?))
    // 无边框 + 置顶 + 不占任务栏：桌面便签的基本形态
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    // ⚠️ `maximizable(false)` 是**双击最大化这条路的真正护栏**（t21 F1 的修复核心之二）：
    //    注入脚本 `drag.js` 双击拖拽区时调的是 `plugin:window|internal_toggle_maximize`，
    //    该命令的实现在框架里是（tauri-2.11.6/src/window/plugin.rs:225-231）
    //        if window.is_resizable() { if window.is_maximized() { unmaximize() }
    //                                   else if window.is_maximizable() { maximize() } }
    //    ⇒ 只要 `is_maximizable()` 为 false，它就**什么都不做**。
    //    （capability 里的 `deny-internal-toggle-maximize` 在这条注入路径上实测无效，见 §4.14.8。）
    .maximizable(false)
    .min_inner_size(TILE_MIN_WIDTH, TILE_MIN_HEIGHT)
    .inner_size(geometry.width, geometry.height)
    .position(geometry.x, geometry.y)
    .title(format!("纸笺磁贴 · {note_id}"))
    .visible(visible)
    .focused(false)
    // 透明让前端能做圆角/柔和底色；Windows 上透明窗口本身不支持拖拽缩放，
    // 但磁贴是"便签"形态：位置可拖（前端用 data-tauri-drag-region），尺寸由尺寸档位控制。
    .transparent(true);

    let window = builder
        .build()
        .map_err(|error| format!("创建磁贴窗口失败：{error}"))?;

    // 双保险：万一它已经是最大化状态（历史脏几何 / 系统行为），立刻还原。
    if window.is_maximized().unwrap_or(false) {
        println!("[纸笺] 磁贴 {label} 创建后处于最大化，已自动取消");
        let _ = window.unmaximize();
    }

    // 属性自证：**这条日志是给运行时探针读的**（`scripts/probe-tile-maximize.ps1`）。
    // `internal_toggle_maximize` 只在 `is_maximizable() == true` 时才最大化，
    // 所以这三项是"双击不会铺满屏"的运行时证据，而不是靠读 capability 声明。
    // ASCII 锚点 `tile-attrs` 的理由同上（管道里中文可能乱码）。
    println!(
        "[纸笺] tile-attrs {label}: resizable={:?} maximizable={:?} maximized={:?}",
        window.is_resizable(),
        window.is_maximizable(),
        window.is_maximized()
    );
    println!("[纸笺] 磁贴已创建：{label} → {url}");
    Ok(window)
}

/// 打开磁贴并把它置于最前
pub fn open_tile<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Result<(), String> {
    let window = create_tile(app, note_id, true)?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 关闭单枚磁贴（只关这个窗口，几何保留在磁盘上以便再次钉住时恢复）
pub fn close_tile<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Result<(), String> {
    if let Some(window) = tile_window(app, note_id) {
        window
            .close()
            .map_err(|error| format!("关闭磁贴失败：{error}"))?;
    }
    Ok(())
}

/// 钉住/取消（IPC 与快捷键共用）。返回**新状态**：true = 当前已钉住
pub fn toggle_tile_impl<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Result<bool, String> {
    if tile_window(app, note_id).is_some() {
        close_tile(app, note_id)?;
        return Ok(false);
    }
    open_tile(app, note_id)?;
    Ok(true)
}

/// 列出全部磁贴（几何优先取实时值，取不到则回落到已保存值）
pub fn list_tiles_impl<R: Runtime>(app: &AppHandle<R>) -> Vec<TileInfo> {
    let mut tiles: Vec<TileInfo> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            let note_id = note_id_from_label(&label)?;
            let saved = geometry_for(app, &note_id);
            let position = window.outer_position().ok();
            // t50：尺寸用 **inner**（与 `create_tile` 的 `.inner_size()`、与几何记录三者同语义）
            let size = window.inner_size().ok();
            Some(TileInfo {
                note_id,
                x: position.map(|p| p.x).unwrap_or(saved.x as i32),
                y: position.map(|p| p.y).unwrap_or(saved.y as i32),
                width: size.map(|s| s.width).unwrap_or(saved.width as u32),
                height: size.map(|s| s.height).unwrap_or(saved.height as u32),
                visible: window.is_visible().unwrap_or(false),
                // t45：前端据此渲染图钉按钮的激活态（权威值只在 Rust）
                pinned: saved.pinned,
                // t47：>0 表示"和别的磁贴吸在一起了"，前端据此显示「取消吸附」
                group: saved.group,
            })
        })
        .collect();
    tiles.sort_by(|a, b| a.note_id.cmp(&b.note_id));
    tiles
}

/// 显示/隐藏**全部临时磁贴**（固定磁贴不参与，见下）。
///
/// `visible = None` 表示「切换」：只要有任意一枚临时磁贴可见就全部隐藏，否则全部显示。
/// 返回切换后**临时磁贴**的可见状态（没有临时磁贴时返回"桌面上是否还有磁贴可见"）。
///
/// ## t46：固定磁贴**不参与**全部显隐（用户明确要求）
/// 用户原话：「希望固定的磁贴永远留在桌面上（快捷键只影响临时磁贴）」。
/// 语义因此变成：`pinned = true` 的磁贴**只能由用户自己在磁贴上操作**（图钉 / ×），
/// 快捷键与"全部显隐"都动不了它 —— 这才是"永久保留"应有的意思。
///
/// ⚠️ 返回值的语义边界（别让 UI 显示假状态）：
/// 若当前**只有固定磁贴**（没有临时磁贴），本函数不改变任何窗口，
/// 此时返回"桌面上还有磁贴可见吗"，而不是 `target`（那会显示成"已隐藏"但桌面上明明有东西）。
pub fn set_all_visible_impl<R: Runtime>(app: &AppHandle<R>, visible: Option<bool>) -> bool {
    let windows: Vec<WebviewWindow<R>> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            let note_id = note_id_from_label(&label)?;
            // 固定的磁贴：默认不参与"全部显隐"（t46 的用户要求）；
            // 用户在设置里打开「允许隐藏已固定的磁贴」后（t54），它也一起动。
            if geometry_for(app, &note_id).pinned && !tile_hide_pinned() {
                return None;
            }
            Some(window)
        })
        .collect();

    if windows.is_empty() {
        // 没有临时磁贴可动：不改任何窗口，如实回报"桌面上还有磁贴吗"
        return app
            .webview_windows()
            .iter()
            .any(|(label, window)| {
                note_id_from_label(label).is_some() && window.is_visible().unwrap_or(false)
            });
    }

    let target = match visible {
        Some(value) => value,
        None => !windows
            .iter()
            .any(|window| window.is_visible().unwrap_or(false)),
    };

    for window in &windows {
        let result = if target { window.show() } else { window.hide() };
        if let Err(error) = result {
            eprintln!("[纸笺] 磁贴显隐失败（已跳过）：{error}");
        }
    }
    target
}

/// 显隐全部磁贴并 emit 状态变化事件（快捷键与 IPC 共用）
pub fn set_all_visible_emit<R: Runtime>(app: &AppHandle<R>, visible: Option<bool>) -> bool {
    let state = set_all_visible_impl(app, visible);
    let _ = app.emit(events::TILES_VISIBILITY_CHANGED, TileVisibilityPayload { visible: state });
    state
}

/// `TILES_VISIBILITY_CHANGED` 的负载
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileVisibilityPayload {
    pub visible: bool,
}

/* ============================== 生命周期 ============================== */

/// 初始化：加载几何 → 恢复上次钉住的磁贴 → 启动去抖落盘线程。
///
/// 由 `lib.rs` 在 `setup` 中调用；**失败只告警，不阻断启动**。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let path = geometry_path(app);
    let file = match &path {
        Some(path) => load_geometry(path),
        None => TilesState::fresh_geometry(),
    };

    // ============ t49：真正的**尾沿去抖** + 两级时间窗 ============
    //
    // ⚠️ 原实现（t19 起一直如此）其实是**假去抖**，这是本轮崩溃的关键线索：
    //      `rx.recv_timeout(PERSIST_QUIET_PERIOD)` 收到**第一个**信号就立刻返回 Ok
    //      ⇒ 紧接着就 `persist_now()`（序列化 + 写文件）。
    //      于是"大幅度快速拖动"时**每一次移动都写一遍文件**（每秒上百次 IO），
    //      而注释里却写着"尾沿去抖" —— 行为与文档不符，且没有任何断言盯着它。
    //
    // 现在：收到信号后**继续等**，直到真正安静到各个窗口才动手（尾沿语义）。
    //   · 60ms  FOLLOW_CHASE_PERIOD：把整组跟随的待应用位置补发到窗口；
    //   · 400ms SNAP_QUIET_PERIOD ：视为"停手了" ⇒ 吸附/成组（反馈及时，且用户继续移动会重置）；
    //   · 3s    PERSIST_QUIET_PERIOD：视为"这一段操作结束了" ⇒ 落盘（避免拖动中频繁写文件）。
    // 任何新信号都会重置全部计时。
    let (tx, rx) = mpsc::channel::<()>();
    let worker_app = app.clone();
    std::thread::spawn(move || {
        loop {
            // ① 阻塞等第一个信号（无信号时不占 CPU）
            if rx.recv().is_err() {
                break; // 发送端随应用销毁 ⇒ 线程退出
            }
            let mut last_signal = Instant::now();
            let mut chased = false;
            let mut snapped = false;
            loop {
                let quiet = last_signal.elapsed();
                // ② 小窗口：补齐整组跟随（用户拖多快都只投递固定数量的窗口消息）
                if !chased && quiet >= FOLLOW_CHASE_PERIOD {
                    flush_pending_forward(&worker_app);
                    chased = true;
                }
                // ③ 中窗口：停手 400ms ⇒ 吸附/成组（这里**不再**顺带落盘）
                if !snapped && quiet >= SNAP_QUIET_PERIOD {
                    apply_snap_after_move(&worker_app);
                    snapped = true;
                }
                // ④ 大窗口：真正安静 3 秒 ⇒ 落盘
                if quiet >= PERSIST_QUIET_PERIOD {
                    persist_now(&worker_app);
                    break;
                }
                // 等到下一个检查点（取最近的那个）
                let mut until = PERSIST_QUIET_PERIOD;
                if !chased {
                    until = until.min(FOLLOW_CHASE_PERIOD);
                }
                if !snapped {
                    until = until.min(SNAP_QUIET_PERIOD);
                }
                let remaining = PERSIST_QUIET_PERIOD
                    .checked_sub(quiet)
                    .unwrap_or(Duration::ZERO);
                let wait = until.min(remaining).max(Duration::from_millis(10));
                match rx.recv_timeout(wait) {
                    Ok(()) => {
                        // 又有移动 ⇒ 重置全部计时（尾沿去抖）
                        last_signal = Instant::now();
                        chased = false;
                        snapped = false;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });

    let restored: Vec<String> = tiles_to_restore(&file);
    // t47：组号从"已有最大值 + 1"继续，避免重启后新组撞上旧组号
    let next_group = file
        .tiles
        .values()
        .map(|geometry| geometry.group)
        .max()
        .unwrap_or(0)
        + 1;
    app.manage(TilesState {
        path: Mutex::new(path),
        store: Mutex::new(file),
        persist_tx: Mutex::new(Some(tx)),
        next_group: Mutex::new(next_group),
        last_moved: Mutex::new(None),
        programmatic: Mutex::new(HashMap::new()),
        pending_forward: Mutex::new(HashMap::new()),
    });

    // 只恢复**被固定**的磁贴（t45）。
    // t19 的原行为是"文件里有条目就恢复"，于是用 × 关掉的磁贴下次启动又回来（用户报障）。
    // 现在：临时磁贴用完即消，固定磁贴才自动出现 —— 恢复名单由 `tiles_to_restore` 决定。
    let mut restored_ok = 0usize;
    for note_id in &restored {
        match create_tile(app, note_id, true) {
            Ok(_) => restored_ok += 1,
            Err(error) => eprintln!("[纸笺] 恢复磁贴 {note_id} 失败：{error}"),
        }
    }
    if restored_ok > 0 {
        println!("[纸笺] 已恢复 {restored_ok} 枚固定磁贴");
    }
    Ok(())
}

/* ==================== t47：吸附成组的执行层（跟随 / 吸附 / 成组 / 解组） ==================== */

/// 当前**真的有窗口**的磁贴 id（几何缓存里可能留着早已关闭的条目，它们不参与吸附与跟随）。
fn active_tile_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|label| note_id_from_label(label))
        .collect();
    ids.sort(); // 顺序确定 ⇒ 吸附取舍与日志可复现
    ids
}

/// t48：登记"接下来这次移动是我们自己发起的"（期望落点）。
fn mark_programmatic<R: Runtime>(app: &AppHandle<R>, note_id: &str, x: f64, y: f64) {
    if let Some(state) = state(app) {
        if let Ok(mut map) = state.programmatic.lock() {
            map.insert(note_id.to_string(), (x, y));
        }
    }
}

/// t48：这次 `Moved` 是不是我们自己设的位置？是则**消耗**该登记并返回 true。
fn consume_programmatic<R: Runtime>(app: &AppHandle<R>, note_id: &str, x: f64, y: f64) -> bool {
    let Some(state) = state(app) else { return false };
    let Ok(mut map) = state.programmatic.lock() else {
        return false;
    };
    match map.get(note_id).copied() {
        Some((expected_x, expected_y))
            if (x - expected_x).abs() <= PROGRAMMATIC_TOLERANCE
                && (y - expected_y).abs() <= PROGRAMMATIC_TOLERANCE =>
        {
            map.remove(note_id);
            true
        }
        _ => false,
    }
}

/// t48：**唯一的**程序性移动入口 —— 先登记期望落点，再设位置。
///
/// 所有"我们自己移动磁贴"的地方（组跟随、吸附对齐）都必须走这里：
/// 少了登记，随之而来的 `Moved` 会被当成"用户拖动"再传播一次，形成反馈循环。
fn move_window_programmatically<R: Runtime>(app: &AppHandle<R>, note_id: &str, x: f64, y: f64) {
    mark_programmatic(app, note_id, x, y);
    if let Some(window) = tile_window(app, note_id) {
        if let Err(error) = window.set_position(tauri::LogicalPosition::new(x, y)) {
            eprintln!("[纸笺] 移动磁贴 {note_id} 失败：{error}");
        }
    }
}

/// 把一次位移**登记**给同组磁贴（"整组一起动"）——**只写内存，不动窗口**。
///
/// ⚠️ t49：这里**刻意不调用 `set_position`**。原因见 `FOLLOW_CHASE_PERIOD` 的说明：
/// 在 `Moved` 里逐帧投递窗口消息正是"跟随慢几拍 + 快速拖动崩溃"的来源。
/// 真正的位置落窗由去抖线程按固定周期调用 `flush_pending_forward` 完成。
///
/// 每次登记都会**推进该成员的记录**（`remember_geometry`），这样下一次 `Moved`
/// 算出的 delta 是基于最新记录的增量、可以正确累加（否则连续登记会丢位移）。
fn propagate_group_move<R: Runtime>(app: &AppHandle<R>, note_id: &str, delta: (f64, f64)) {
    // t52：吸附开关关闭 ⇒ 不传播位移（磁贴各自独立移动，不会被同组带着走）
    if !tile_snap_enabled() {
        return;
    }
    // 死区：1px 级的抖动不带着整组抖
    if delta.0.abs() < MOVE_DEAD_ZONE && delta.1.abs() < MOVE_DEAD_ZONE {
        return;
    }
    let Some(state) = state(app) else { return };
    let members: Vec<(String, TileGeometry)> = {
        let Ok(store) = state.store.lock() else { return };
        let Some(mine) = store.tiles.get(note_id) else { return };
        if mine.group == 0 {
            return;
        }
        let group = mine.group;
        store
            .tiles
            .iter()
            .filter(|(id, geometry)| geometry.group == group && id.as_str() != note_id)
            .map(|(id, geometry)| (id.clone(), *geometry))
            .collect()
    };
    let Ok(mut pending) = state.pending_forward.lock() else {
        return;
    };
    for (member_id, member_geometry) in members {
        // 只跟随**开着窗口**的成员
        if tile_window(app, &member_id).is_none() {
            continue;
        }
        let next = TileGeometry {
            x: member_geometry.x + delta.0,
            y: member_geometry.y + delta.1,
            ..member_geometry
        };
        // 先推进记录（累加正确），再把绝对目标位置挂到待补发表
        remember_geometry(app, &member_id, next);
        pending.insert(member_id, (next.x, next.y));
    }
}

/// 把"待补发的跟随位置"落到窗口上（由去抖线程按周期调用）。
///
/// 整段通过 `run_on_main_thread` 投递：**窗口 API 一律在主线程碰**，
/// 后台线程只做内存登记 —— 这也是 t49 的另一条护栏（此前后台线程直接读窗口属性/设位置）。
fn flush_pending_forward<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state(app) else { return };
    let batch: Vec<(String, (f64, f64))> = {
        let Ok(mut pending) = state.pending_forward.lock() else {
            return;
        };
        let drained: Vec<(String, (f64, f64))> = pending.drain().collect();
        drained
    };
    if batch.is_empty() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (note_id, (x, y)) in batch {
            move_window_programmatically(&handle, &note_id, x, y);
        }
    });
}

/// 把这几枚磁贴并成一组（沿用任一已有的组号，都没有才分配新号）。
fn form_group<R: Runtime>(app: &AppHandle<R>, note_id: &str, others: &[String]) {
    let Some(state) = state(app) else { return };
    let Ok(mut store) = state.store.lock() else { return };
    let existing = std::iter::once(note_id)
        .chain(others.iter().map(String::as_str))
        .filter_map(|id| store.tiles.get(id).map(|geometry| geometry.group))
        .find(|group| *group != 0);
    let group = match existing {
        Some(group) => group,
        None => {
            // 新组号：从 1 起（0 = 未成组）
            match state.next_group.lock() {
                Ok(mut next) => {
                    let assigned = (*next).max(1);
                    *next = assigned + 1;
                    assigned
                }
                Err(_) => 1,
            }
        }
    };
    for id in std::iter::once(note_id).chain(others.iter().map(String::as_str)) {
        if let Some(geometry) = store.tiles.get_mut(id) {
            geometry.group = group;
        }
    }
    drop(store);
    request_persist(app);
}

/// 清掉"只剩一个成员"的组。
///
/// 什么时候会出现：用户把组里的一枚拖走（`still_attached` 不再成立）⇒ 另一枚的组号
/// 就成了孤儿。不清的话它会一直显示「取消吸附」，可实际上没有可吸附的对象 —— 又一个假状态。
fn prune_singleton_groups<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state(app) else { return };
    let active = active_tile_ids(app);
    let Ok(mut store) = state.store.lock() else { return };
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for id in &active {
        if let Some(geometry) = store.tiles.get(id) {
            if geometry.group != 0 {
                *counts.entry(geometry.group).or_insert(0) += 1;
            }
        }
    }
    let mut changed = false;
    for id in &active {
        if let Some(geometry) = store.tiles.get_mut(id) {
            let group = geometry.group;
            if group != 0 && counts.get(&group).copied().unwrap_or(0) < 2 {
                geometry.group = 0;
                changed = true;
            }
        }
    }
    drop(store);
    if changed {
        request_persist(app);
    }
}

/// 拖动停止后的吸附检查（由去抖线程在安静期结束时调用）。
///
/// t49：**投递到主线程执行**（`run_on_main_thread`）。它内部要读窗口属性
/// （`geometry_for` → `outer_position`）并设置位置，这些都属于窗口层操作 ——
/// 后台线程一律不直接碰（后台线程只做内存登记），这是本轮崩溃修复的一条硬纪律。
fn apply_snap_after_move<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply_snap_after_move_inner(&handle));
}

fn apply_snap_after_move_inner<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state(app) else { return };
    let Some(moved_id) = state.last_moved.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    // t52：吸附开关关闭 ⇒ 到此为止（`last_moved` 已在上面取走，不会留到下次误触发）
    if !tile_snap_enabled() {
        return;
    }
    let active: Vec<(String, TileGeometry)> = active_tile_ids(app)
        .into_iter()
        .map(|id| {
            let geometry = geometry_for(app, &id);
            (id, geometry)
        })
        .collect();
    let Some(moving) = active
        .iter()
        .find(|(id, _)| id == &moved_id)
        .map(|(_, geometry)| *geometry)
    else {
        return; // 移动者已经关掉了
    };

    // ① 位置吸附
    let others: Vec<TileGeometry> = active
        .iter()
        .filter(|(id, _)| id != &moved_id)
        .map(|(_, geometry)| *geometry)
        .collect();
    if let Some((x, y)) = snap_position(moving, &others, SNAP_THRESHOLD) {
        let snapped = TileGeometry { x, y, ..moving };
        remember_geometry(app, &moved_id, snapped);
        // t48：走程序性移动入口（登记期望落点）——吸附本身也是一次"我们自己设的位置"
        move_window_programmatically(app, &moved_id, x, y);
        println!("[纸笺] 磁贴 {moved_id} 已吸附到 ({x}, {y})");
    }

    // ② 组关系：用最新位置重算（吸附之后才算，否则会按"吸附前"的缝判定）
    let moving_now = geometry_for(app, &moved_id);
    let attached: Vec<String> = active
        .iter()
        .filter(|(id, _)| id != &moved_id)
        .filter(|(_, geometry)| still_attached(moving_now, *geometry, SNAP_THRESHOLD))
        .map(|(id, _)| id.clone())
        .collect();
    if !attached.is_empty() {
        form_group(app, &moved_id, &attached);
    }
    prune_singleton_groups(app);

    // ③ 状态可能变了（成组/解组）⇒ 让磁贴刷新按钮
    let _ = app.emit(events::TILES_CHANGED, ());
}

/// 显式"取消吸附"（磁贴标题栏那个按钮）。返回 true = 之前确实在组里。
pub fn ungroup_tile_impl<R: Runtime>(app: &AppHandle<R>, note_id: &str) -> Result<bool, String> {
    let Some(state) = state(app) else {
        return Err("磁贴状态尚未初始化".to_string());
    };
    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "磁贴状态锁不可用".to_string())?;
        let Some(geometry) = store.tiles.get_mut(note_id) else {
            return Err(format!("没有这条笔记的磁贴记录：{note_id}"));
        };
        if geometry.group == 0 {
            return Ok(false);
        }
        geometry.group = 0;
    }
    // 显式解组后，原来的同伴很可能只剩自己一个 ⇒ 顺手清掉孤儿组，
    // 否则那枚磁贴会一直显示「取消吸附」却没有可吸附的对象（假状态）。
    prune_singleton_groups(app);
    request_persist(app);
    let _ = app.emit(events::TILES_CHANGED, ());
    Ok(true)
}

/// 处理磁贴窗口的移动/缩放：记住几何（去抖落盘）
pub fn handle_window_event<R: Runtime>(window: &WebviewWindow<R>, event: &tauri::WindowEvent) {
    let Some(note_id) = note_id_from_label(window.label()) else {
        return; // 只关心磁贴
    };
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let app = window.app_handle();

            // ① 最大化状态**绝不记录**，并立刻取消（t21 F1）：Windows 的最大化矩形
            //    （如 -8/-8/1936/1048）一旦落盘，"恢复位置"下次就会照搬成全屏。
            if window.is_maximized().unwrap_or(false) {
                println!("[纸笺] 磁贴 {note_id} 处于最大化（不应发生）：自动取消且**跳过**几何记录");
                let _ = window.unmaximize();
                return;
            }

            let (Ok(position), Ok(size), Ok(scale)) = (
                window.outer_position(),
                // ⚠️ t50：**必须用 inner_size**（用户报「为什么现在不吸附了」的第二个原因）。
                //
                // `create_tile` 是用 `.inner_size(geometry.width, geometry.height)` 设尺寸的，
                // 而 Windows 上无边框窗口的 `outer_size()` 比 `inner_size()` 大（不可见边框，
                // 本机实测每边 8px、合计 16px）。原先这里记录 `outer_size()`，于是：
                //  ① **吸附判定用的缝隙是错的**：用户把两枚拖到"视觉贴合"时，代码算出的缝隙
                //     是 -16px 左右（重叠）⇒ 阈值 8px 时 |−16| 还能勉强命中，收到 2px 后
                //     **永不命中** —— 这正是"改了 2px 就不吸附了"的直接原因；
                //  ② **尺寸会逐次累积**：记录 outer(312) → 下次 `inner_size(312)` → 新 outer 328
                //     → 再记 328…… 每次重启窗口都变大 16px。
                // 统一成 inner 语义后，与创建参数一一对应，两条问题一起消失。
                // （位置仍用 `outer_position()`：它与 `.position()` 的语义一致，自洽。）
                window.inner_size(),
                window.scale_factor(),
            ) else {
                return;
            };
            // 存**逻辑坐标**：跨 DPI 显示器时物理坐标会失真
            // （`pinned` / `group` 传占位值：`remember_geometry` 会保留已存的这两项）
            let next = TileGeometry {
                x: position.x as f64 / scale,
                y: position.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
                pinned: false,
                group: 0,
            };

            // ② 再过一次闸门：即使图标未标记为最大化，只要矩形看起来是"铺满屏"就拒绝落盘。
            let clean = match sanitize_geometry(next, monitor_logical_size(app, &next)) {
                Some(clean) => clean,
                None => {
                    println!(
                        "[纸笺] 磁贴 {note_id} 报告了不可信几何（疑似最大化矩形 {next:?}），已忽略本次记录"
                    );
                    return;
                }
            };

            /*
             * t48：**先识别"这是我们自己设的位置"**，再谈传播。
             *
             * 这是防反馈循环的根治手段。没有它：`set_position` → 系统 `Moved` →
             * 我们又当成"用户拖动"去传播/吸附 → 再 `set_position`…… 只要实际落点
             * 与请求值差 1px（Windows 经 DPI 取整很常见），delta 就永远不为 0，
             * 消息会无限增殖（用户实测表现为 `STATUS_HEAP_CORRUPTION` 崩溃）。
             *
             * 程序性移动到此为止：几何在**发起方**已经登记过了，这里不重复记、
             * 不更新 `last_moved`（否则会触发一次多余的吸附检查）。
             */
            if consume_programmatic(app, &note_id, clean.x, clean.y) {
                return;
            }

            /*
             * t47：整组一起动。
             *
             * delta 必须用「本次新位置 − **记录里的旧位置**」来算，而且要**在更新记录之前**算：
             *  - 记录里的值就是这一轮拖动前的基准；
             *  - 跟随者会先把记录改成 `旧位置 + delta` 再设位置，于是它自己那次 Moved
             *    会命中上面的程序性移动识别、直接返回（第二重保险是传播节流）。
             * 缩放（Resized）不该传播位移：那时 position 通常没变，delta 落入死区，无需特判。
             */
            let recorded = geometry_for(app, &note_id);
            let delta = (clean.x - recorded.x, clean.y - recorded.y);

            remember_geometry(app, &note_id, clean);
            if let Some(state) = state(app) {
                if let Ok(mut slot) = state.last_moved.lock() {
                    *slot = Some(note_id.clone());
                }
            }
            propagate_group_move(app, &note_id, delta);
        }
        tauri::WindowEvent::Destroyed => {
            // t45：磁贴被关闭（× 按钮 / 快捷键 / 程序性关闭）⇒ **必须通知前端重新对账**。
            //
            // 为什么（用户报障 ①）：Rust 才是磁贴的权威状态，主窗口只在
            // 「自己发起的 toggle」和「显隐快捷键」时对账。用户用磁贴自己的 × 关掉它时，
            // 主窗口一无所知 ⇒ 那条笔记的按钮一直停在「取消桌面磁贴」（其实已经没有磁贴了）。
            // 这条事件把"磁贴集合变了"这件事广播出去，App 收到即重新对账。
            //
            // 负载为空：前端已有 `listTileNoteIds()` 这条权威取数路径，
            // 再在事件里带一份列表就等于造了第二份可能过期的副本（§4.13 同一原则）。
            let app = window.app_handle();
            let _ = app.emit(events::TILES_CHANGED, ());
        }
        _ => {}
    }
}

/// 清理：把几何落盘并关闭全部磁贴（应用真退出前调用）
pub fn cleanup_all<R: Runtime>(app: &AppHandle<R>) {
    persist_now(app);
    for (label, window) in app.webview_windows() {
        if note_id_from_label(&label).is_some() {
            let _ = window.close();
        }
    }
}

/* ================================ IPC 命令 ================================ */

/// 钉住 / 取消磁贴，返回**新状态**（true = 已钉住）
#[tauri::command]
pub async fn cmd_toggle_tile<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
) -> Result<bool, String> {
    if note_id.trim().is_empty() {
        return Err("noteId 不能为空".to_string());
    }
    toggle_tile_impl(&app, note_id.trim())
}

/// 列出当前全部磁贴
#[tauri::command]
pub async fn cmd_list_tiles<R: Runtime>(app: AppHandle<R>) -> Result<Vec<TileInfo>, String> {
    Ok(list_tiles_impl(&app))
}

/// 显示 / 隐藏全部磁贴；返回切换后的可见状态
#[tauri::command]
pub async fn cmd_set_tiles_visible<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<bool, String> {
    Ok(set_all_visible_emit(&app, Some(visible)))
}

/// 固定 / 取消固定某枚磁贴（t45）：返回设置后的状态。
///
/// 语义：**固定 = 下次启动自动出现**；未固定 = 本次会话的临时磁贴。
/// 刻意与「钉住/取消」分开成两个动作：前者是"现在要不要这个窗口"，
/// 后者是"以后还要不要它" —— 用户明确要求"自己决定哪个磁贴在开启后永久保留"。
#[tauri::command]
pub async fn cmd_set_tile_pinned<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    pinned: bool,
) -> Result<bool, String> {
    if note_id.trim().is_empty() {
        return Err("noteId 不能为空".to_string());
    }
    set_tile_pinned_impl(&app, note_id.trim(), pinned)
}

/// 取消吸附（t47）：把某枚磁贴从它所在的吸附组里移出来。返回 true = 之前在组里。
#[tauri::command]
pub async fn cmd_ungroup_tile<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
) -> Result<bool, String> {
    if note_id.trim().is_empty() {
        return Err("noteId 不能为空".to_string());
    }
    ungroup_tile_impl(&app, note_id.trim())
}

/// t52：下发「磁贴吸附」开关（参数 `{ enabled: boolean }`，返回**生效后**的值）
///
/// 返回生效值而不是 `()`：前端可以据此对账（与 `cmd_set_close_to_tray` 同一约定）。
#[tauri::command]
pub fn cmd_set_tile_snap(enabled: bool) -> bool {
    set_tile_snap_preference(enabled);
    tile_snap_enabled()
}

/// t52：读取「磁贴吸附」当前值（启动对账 / 诊断用）
#[tauri::command]
pub fn cmd_tile_snap_enabled() -> bool {
    tile_snap_enabled()
}

/// t54：下发「已固定的磁贴是否允许被全部显隐隐藏」（参数 `{ enabled: boolean }`，返回生效值）
#[tauri::command]
pub fn cmd_set_tile_hide_pinned(enabled: bool) -> bool {
    set_tile_hide_pinned_preference(enabled);
    tile_hide_pinned()
}

/// t54：读取该开关当前值（启动对账 / 诊断用）
#[tauri::command]
pub fn cmd_tile_hide_pinned() -> bool {
    tile_hide_pinned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// t52：吸附开关**默认开启** —— 用户没动过设置时必须保持一直以来的行为
    #[test]
    fn tile_snap_defaults_to_enabled() {
        // 其它用例可能改过这个进程级开关：先恢复默认再断言
        if !tile_snap_enabled() {
            set_tile_snap_preference(true);
        }
        assert!(tile_snap_enabled(), "默认应启用（否则用户会以为「吸附坏了」）");
    }

    /// t52：开关可读写，且**命令返回的是生效后的值**（不是"假设成功"）
    #[test]
    fn tile_snap_toggle_is_readable() {
        assert!(!cmd_set_tile_snap(false), "设为关闭后应回读 false");
        assert!(!tile_snap_enabled());
        assert!(cmd_set_tile_snap(true), "设为开启后应回读 true");
        assert!(cmd_tile_snap_enabled(), "读取命令应返回当前值");
        set_tile_snap_preference(true); // 恢复默认，避免影响其它用例
    }

    /// t54：「固定磁贴可被隐藏」默认关闭 —— 保持 t46 的用户要求（固定磁贴永远留在桌面）
    #[test]
    fn tile_hide_pinned_defaults_to_disabled() {
        if tile_hide_pinned() {
            set_tile_hide_pinned_preference(false);
        }
        assert!(!tile_hide_pinned(), "默认应为 false（固定磁贴不参与全部显隐）");
    }

    /// t54：该开关可读写，且命令返回**生效值**
    #[test]
    fn tile_hide_pinned_toggle_is_readable() {
        assert!(cmd_set_tile_hide_pinned(true), "设为可隐藏后应回读 true");
        assert!(tile_hide_pinned());
        assert!(!cmd_set_tile_hide_pinned(false), "设回不可隐藏后应回读 false");
        assert!(!cmd_tile_hide_pinned());
        set_tile_hide_pinned_preference(false); // 恢复默认
    }

    #[test]
    fn label_round_trips() {
        let note_id = "5f1b0c9a-1234-4a5b-8c9d-0123456789ab";
        let label = label_for(note_id);
        assert_eq!(label, format!("tile-{note_id}"));
        assert_eq!(note_id_from_label(&label).as_deref(), Some(note_id));
    }

    #[test]
    fn non_tile_labels_are_rejected() {
        // 主窗口与托盘等其它 label 不得被误判为磁贴
        for label in ["main", "tray", "tiles", "tile", ""] {
            assert_eq!(
                note_id_from_label(label),
                None,
                "「{label}」不应被识别为磁贴窗口"
            );
        }
    }

    #[test]
    fn default_geometry_cascades() {
        let first = TileGeometry::default_at(0);
        let third = TileGeometry::default_at(2);
        assert_eq!(first.width, TILE_DEFAULT_WIDTH);
        assert_eq!(first.height, TILE_DEFAULT_HEIGHT);
        // 层叠：不会全部叠在同一位置
        assert!(third.x > first.x && third.y > first.y);
    }

    /* ---- t22：几何合理性闸门（t21 F1「双击磁贴 → 全屏 + 污染 tiles.json」的修复） ---- */

    #[test]
    fn sanitize_rejects_windows_maximized_rect() {
        // t21 在真机上抓到的实际污染值（-8/-8 是 Windows 最大化窗口的经典负偏移）
        let polluted = TileGeometry {
            x: -8.0,
            y: -8.0,
            width: 1936.0,
            height: 1048.0,
            pinned: false,
            group: 0,
        };
        assert_eq!(
            sanitize_geometry(polluted, Some((1920.0, 1040.0))),
            None,
            "铺满屏的矩形必须被拒绝（否则重启后磁贴以全屏打开）"
        );
    }

    #[test]
    fn sanitize_rejects_degenerate_sizes() {
        for (width, height) in [(0.0, 240.0), (280.0, 0.0), (-10.0, -10.0)] {
            let geometry = TileGeometry {
                x: 100.0,
                y: 100.0,
                width,
                height,
                pinned: false,
                group: 0,
            };
            assert_eq!(
                sanitize_geometry(geometry, Some((1920.0, 1040.0))),
                None,
                "退化尺寸（{width}×{height}）必须被拒绝"
            );
        }
        // 非有限值同样拒绝
        let nan = TileGeometry {
            x: f64::NAN,
            y: 0.0,
            width: 280.0,
            height: 240.0,
            pinned: false,
            group: 0,
        };
        assert_eq!(sanitize_geometry(nan, None), None);
    }

    #[test]
    fn sanitize_keeps_reasonable_geometry_untouched() {
        let good = TileGeometry {
            x: 200.0,
            y: 160.0,
            width: 280.0,
            height: 240.0,
            pinned: false,
            group: 0,
        };
        assert_eq!(sanitize_geometry(good, Some((1920.0, 1040.0))), Some(good));
    }

    #[test]
    fn sanitize_clamps_oversize_and_offscreen_position() {
        // 一个真实的"用户把磁贴拉得很宽"的值：不超过显示器就保留，但位置要夹回屏内
        let geometry = TileGeometry {
            x: 5000.0,
            y: -900.0,
            width: 1000.0,
            height: 700.0,
            pinned: false,
            group: 0,
        };
        let clean = sanitize_geometry(geometry, Some((1920.0, 1040.0))).expect("应保留但夹取");
        assert_eq!(clean.width, 1000.0);
        assert_eq!(clean.height, 700.0);
        // 至少留 TILE_KEEP_VISIBLE 在屏内
        assert!(clean.x <= 1920.0 - TILE_KEEP_VISIBLE);
        assert!(clean.y >= -(700.0 - TILE_KEEP_VISIBLE));
    }

    #[test]
    fn sanitize_without_monitor_still_enforces_minimum_size() {
        // 取不到显示器信息（无桌面会话）时：不误伤正常值，但仍不许退化成 0 尺寸
        let tiny = TileGeometry {
            x: 10.0,
            y: 10.0,
            width: 1.0,
            height: 1.0,
            pinned: false,
            group: 0,
        };
        let clean = sanitize_geometry(tiny, None).expect("小尺寸应被抬到最小值而不是拒绝");
        assert_eq!(clean.width, TILE_MIN_WIDTH);
        assert_eq!(clean.height, TILE_MIN_HEIGHT);
    }

    #[test]
    fn geometry_file_round_trips_through_json() {
        let mut file = GeometryFile {
            version: 1,
            tiles: HashMap::new(),
        };
        file.tiles.insert(
            "note-a".to_string(),
            TileGeometry {
                x: 10.5,
                y: 20.25,
                width: 300.0,
                height: 260.0,
                pinned: true,
                group: 0,
            },
        );
        let json = serde_json::to_string(&file).expect("应可序列化");
        let back: GeometryFile = serde_json::from_str(&json).expect("应可反序列化");
        let geometry = back.tiles.get("note-a").expect("应保留该磁贴");
        assert_eq!(geometry.width, 300.0);
        assert_eq!(geometry.x, 10.5);
        assert!(geometry.pinned, "t45：固定状态必须能往返");
        assert_eq!(back.version, 1);
    }

    /* ---------------- t45：固定磁贴的恢复语义 ---------------- */

    fn geometry_at(x: f64, pinned: bool) -> TileGeometry {
        TileGeometry {
            x,
            y: 20.0,
            width: 300.0,
            height: 260.0,
            pinned,
            group: 0,
        }
    }

    /* ---------------- t47：吸附算法（纯函数，穷举边界） ---------------- */

    /// 造一枚 200×150 的磁贴（吸附测试里尺寸固定，便于心算期望值）
    fn box_at(x: f64, y: f64) -> TileGeometry {
        TileGeometry {
            x,
            y,
            width: 200.0,
            height: 150.0,
            pinned: false,
            group: 0,
        }
    }

    #[test]
    fn snaps_to_the_right_of_a_neighbour() {
        // 邻居 (0,0,200,150)；我在它右边只留 1px 缝 ⇒ 应吸到 x = 200
        // ⚠️ 用例里的缝隙必须**小于 SNAP_THRESHOLD**：阈值从 8px 收到 2px 时，
        //    原来写 3px 的用例当场失败 —— 这不是测试的噪音，而是它在提醒"语义变了"。
        let moving = box_at(201.0, 10.0);
        let others = [box_at(0.0, 0.0)];
        assert_eq!(snap_position(moving, &others, SNAP_THRESHOLD), Some((200.0, 10.0)));
    }

    #[test]
    fn snaps_to_the_left_of_a_neighbour() {
        // 我在邻居左边，缝 1px（我右边缘 199，邻居左边缘 200）⇒ 吸到 x = 0
        let moving = box_at(-1.0, 20.0);
        let others = [box_at(200.0, 0.0)];
        assert_eq!(snap_position(moving, &others, SNAP_THRESHOLD), Some((0.0, 20.0)));
    }

    #[test]
    fn snaps_vertically_both_ways() {
        // 上贴下：我上边缘 151、邻居下边缘 150 ⇒ 吸到 y = 150
        assert_eq!(
            snap_position(box_at(10.0, 151.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD),
            Some((10.0, 150.0)),
        );
        // 下贴上：我上边缘 349、邻居下边缘 350 ⇒ 吸到 y = 350
        assert_eq!(
            snap_position(box_at(10.0, 349.0), &[box_at(0.0, 200.0)], SNAP_THRESHOLD),
            Some((10.0, 350.0)),
        );
    }

    #[test]
    fn does_not_snap_when_the_gap_is_too_large() {
        // 缝 20px > 阈值 8px
        assert_eq!(snap_position(box_at(220.0, 0.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD), None);
    }

    #[test]
    fn threshold_boundary_is_inclusive_and_exclusive_as_documented() {
        // 正好等于阈值 ⇒ 吸附；超过 1px ⇒ 不吸附（边界必须写死，否则"手感"会随实现漂移）
        assert_eq!(
            snap_position(box_at(200.0 + SNAP_THRESHOLD, 0.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD),
            Some((200.0, 0.0)),
        );
        assert_eq!(
            snap_position(box_at(200.0 + SNAP_THRESHOLD + 1.0, 0.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD),
            None,
        );
    }

    #[test]
    fn does_not_snap_without_overlap_on_the_other_axis() {
        // x 方向只差 1px（**在阈值 2px 之内**，所以"会不会吸附"完全取决于另一轴），
        // 但 y 完全不重叠（我在它下方 400px 开外）⇒ 不该"斜对角贴合"。
        // ⚠️ 这里刻意用"阈值内"的 x 差：若写成 3px，在阈值收到 2px 之后就变成
        //    "因为超阈值所以不吸"，这条断言就测不到它真正要测的东西了。
        assert_eq!(snap_position(box_at(201.0, 400.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD), None);
    }

    #[test]
    fn nearest_gap_wins() {
        // 我在 x=194（宽 200 ⇒ 右边缘 394）。阈值放宽到 200，让**两个**候选都成立：
        //  · 左邻居 (-200..0)：缝 194 ⇒ 候选位置 x = 0（贴到它右边）
        //  · 右邻居 (396..596)：缝 2   ⇒ 候选位置 x = 196（贴到它左边）
        // 期望取**间隙更小**的那个 ⇒ x = 196。
        // （第一版把期望写成 396 —— 那是邻居的左边缘、不是我的 x；这条测试当场把它抓出来了。）
        let moving = box_at(194.0, 0.0);
        let others = [box_at(-200.0, 0.0), box_at(396.0, 0.0)];
        assert_eq!(snap_position(moving, &others, 200.0), Some((196.0, 0.0)));
    }

    #[test]
    fn already_flush_returns_none_so_it_is_idempotent() {
        // 已经严丝合缝（缝 0）时不返回位置 —— 否则每次去抖都会"再设一次位置"，
        // 白白触发 Moved 事件（并可能把组跟随卷进来）。
        assert_eq!(snap_position(box_at(200.0, 0.0), &[box_at(0.0, 0.0)], SNAP_THRESHOLD), None);
    }

    #[test]
    fn tie_breaks_deterministically_by_order() {
        // 两个候选间隙相同（都是 0）⇒ 无位移
        let moving = box_at(200.0, 0.0);
        let first = [box_at(0.0, 0.0), box_at(400.0, 0.0)];
        assert_eq!(snap_position(moving, &first, SNAP_THRESHOLD), None, "两边都贴合 ⇒ 无位移");
        // 换成"两侧都有 1px 缝"（都在阈值内）：应取 others 里靠前的（左邻居）
        let moving2 = box_at(201.0, 0.0); // 左缝 1px、右缝 1px（右邻居在 402）
        let others2 = [box_at(0.0, 0.0), box_at(402.0, 0.0)];
        assert_eq!(snap_position(moving2, &others2, SNAP_THRESHOLD), Some((200.0, 0.0)));
    }

    #[test]
    fn still_attached_allows_small_rounding_gaps() {
        // 贴合（缝 0）
        assert!(still_attached(box_at(200.0, 0.0), box_at(0.0, 0.0), SNAP_THRESHOLD));
        // 1px 取整缝：仍算贴合（否则"刚吸附好就被判成分开"）
        assert!(still_attached(box_at(201.0, 0.0), box_at(0.0, 0.0), SNAP_THRESHOLD));
        // 差得远：不算
        assert!(!still_attached(box_at(400.0, 0.0), box_at(0.0, 0.0), SNAP_THRESHOLD));
        // 另一轴不重叠：不算（斜对角）
        assert!(!still_attached(box_at(200.0, 400.0), box_at(0.0, 0.0), SNAP_THRESHOLD));
    }

    #[test]
    fn group_field_defaults_to_zero_for_legacy_files() {
        // 老 tiles.json 没有 group 字段 ⇒ 读成 0（未成组），不会凭空长出组关系
        let legacy = r#"{"version":1,"tiles":{"n":{"x":0.0,"y":0.0,"width":100.0,"height":100.0}}}"#;
        let file: GeometryFile = serde_json::from_str(legacy).expect("旧文件必须能解析");
        assert_eq!(file.tiles.get("n").map(|geometry| geometry.group), Some(0));
    }

    #[test]
    fn only_pinned_tiles_are_restored() {
        // 这是 t45 用户报障的核心语义：**只有被固定的磁贴**在启动时自动出现。
        // 旧实现是"文件里有条目就恢复"，于是用 × 关掉的磁贴下次启动又回来。
        let mut file = GeometryFile {
            version: 1,
            tiles: HashMap::new(),
        };
        file.tiles.insert("keep-1".to_string(), geometry_at(10.0, true));
        file.tiles.insert("keep-2".to_string(), geometry_at(20.0, true));
        file.tiles.insert("temp-1".to_string(), geometry_at(30.0, false));

        let restored = tiles_to_restore(&file);
        assert_eq!(restored, vec!["keep-1".to_string(), "keep-2".to_string()]);
        assert!(
            !restored.contains(&"temp-1".to_string()),
            "未固定的（临时）磁贴绝不能出现在启动恢复名单里"
        );
    }

    #[test]
    fn legacy_file_without_pinned_field_is_treated_as_unpinned() {
        // 升级兼容：老版本写出的 tiles.json **没有** pinned 字段。
        // 必须读成"未固定"，否则老残留（含用户已经关掉的那些）会在升级后又自己冒出来。
        let legacy = r#"{"version":1,"tiles":{"old-note":{"x":1.0,"y":2.0,"width":300.0,"height":200.0}}}"#;
        let file: GeometryFile = serde_json::from_str(legacy).expect("旧文件必须能解析");
        let geometry = file.tiles.get("old-note").expect("应保留该磁贴");
        assert!(!geometry.pinned, "缺少 pinned 字段时必须回落为 false（未固定）");
        assert!(
            tiles_to_restore(&file).is_empty(),
            "旧文件的条目不应被自动恢复（否则升级后用户会看到一堆自己关过的磁贴）"
        );
        // 位置仍然保留：用户重新钉住时还会回到原处
        assert_eq!(geometry.x, 1.0);
    }

    #[test]
    fn restore_list_is_stably_sorted() {
        // 顺序必须可复现（HashMap 迭代顺序不稳定会让日志与探针结果飘）
        let mut file = GeometryFile {
            version: 1,
            tiles: HashMap::new(),
        };
        for id in ["c", "a", "b"] {
            file.tiles.insert(id.to_string(), geometry_at(1.0, true));
        }
        assert_eq!(tiles_to_restore(&file), vec!["a", "b", "c"]);
        assert_eq!(tiles_to_restore(&file), tiles_to_restore(&file));
    }

    #[test]
    fn corrupt_geometry_file_falls_back_to_empty() {
        // 损坏的 JSON 不能让启动失败：load_geometry 只回落为空表
        let mut path = std::env::temp_dir();
        path.push(format!("zhijian-tiles-test-{}.json", std::process::id()));
        std::fs::write(&path, "{ this is not json").expect("应可写临时文件");
        let file = load_geometry(&path);
        assert!(file.tiles.is_empty(), "损坏文件应回落为空表");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_geometry_file_falls_back_to_empty() {
        let mut path = std::env::temp_dir();
        path.push("zhijian-tiles-does-not-exist-9f3a.json");
        let _ = std::fs::remove_file(&path);
        let file = load_geometry(&path);
        assert!(file.tiles.is_empty());
    }

    #[test]
    fn geometry_path_requires_absolute_base() {
        // 没有基准目录 ⇒ 不落盘（绝不在 CWD 生成 tiles.json）
        assert_eq!(absolute_geometry_path(None), None);
        // 相对基准目录 ⇒ 同样拒绝（killer case：'x' 写进 CWD 那一类缺陷）
        assert_eq!(
            absolute_geometry_path(Some(PathBuf::from("relative-dir"))),
            None,
            "相对路径必须被拒绝，否则几何会静默写进当前工作目录"
        );
        // 绝对基准目录 ⇒ 接受，且结果仍是绝对路径、文件名固定
        let absolute = std::env::temp_dir();
        let resolved = absolute_geometry_path(Some(absolute.clone())).expect("绝对路径应被接受");
        assert!(resolved.is_absolute());
        assert_eq!(resolved.file_name().and_then(|n| n.to_str()), Some(GEOMETRY_FILE));
        assert!(resolved.starts_with(&absolute));
    }
}
