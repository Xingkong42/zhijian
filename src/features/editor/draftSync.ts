/**
 * 草稿同步判据（**纯函数**）——决定「上层送来的 note 内容要不要覆盖编辑器草稿」。
 * 归属：编辑器成员（任务 t32，修复「输入被概率性打断」）。
 *
 * ## 背景：为什么原来那条判据会「有概率」出错
 *
 * t16 的写法是在 EditorPane 里做启发式判断：
 * ```ts
 * const externalContent =
 *   note.content !== draft.content && note.content !== lastSentRef.current.content
 * ```
 * 它在「同一时刻只有一次保存在飞」时是对的，但 `notesStore.update` 是异步的
 * （`await initDb()` + `await repo.update`，写盘还会建索引），**两次保存在飞、旧的的后 resolve**
 * 就会命中下面这个时序（本题的复现脚本就是照它写的）：
 *
 * | 时刻 | 动作 | note.content | draft.content | lastSentRef |
 * | --- | --- | --- | --- | --- |
 * | t1 | 打 AAA，Ctrl+S（payload#1） | `A` | `A` | `A` |
 * | t2 | 打 BBB，Ctrl+S（payload#2） | `AB` | `AB` | `AB` |
 * | t3 | 继续打 CCC（未保存） | `AB` | `ABC` | `AB` |
 * | t4 | **payload#1 的回包最后到达** | `A` | `ABC` | `AB` |
 *
 * t4 的判据：`A !== ABC` ✓ 且 `A !== AB` ✓ ⇒ 误判为「外部改写」⇒ `setDraft(A)`
 * ⇒ 经 value prop 整篇回写 CodeMirror ⇒ **正文退回 A、光标跳回首行**。
 * 用户看到的「拼音和汉字同入、光标跳到头、有概率」就是这条路径（乱序回包 + 组合期写入）。
 *
 * ## 现在的判据（宁可收紧，也不打断输入）
 *
 * captain 定的取向：**输入被回退是严重缺陷，外部改写不自动刷新只是小代价**
 *（切笔记 / 重启即可自愈，t15 的 md 真相源支持重启自愈）。因此：
 *
 * 1. `incoming === draft` ⇒ 不采纳（本来就一样，也省掉一次无意义 setState）；
 * 2. **`locallyEdited`（本笔记打开后被本地编辑过）或 `busy`（有未落库/正在落库的改动）⇒ 一律不采纳**
 *    —— 这两条与「保存回包的到达顺序」完全无关，因此不再有概率性；
 * 3. 只有「本篇从未被本地编辑过 且 当前无任何在飞保存」时才采纳外部值
 *    —— 保留了「打开着没动过的笔记能看到外部改动」这一能力，且此时不可能打断输入
 *    （没有输入在途）。
 *
 * 判据只依赖**单调事实**（是否经历过本地编辑 / 是否有在飞保存），不依赖时间与到达顺序。
 *
 * ## t44 补充：`locallyEdited` 挡住的"真外部改动"由**跨窗口广播**单独放行
 *
 * 桌面磁贴与主窗口是两个独立 WebView、各持一份 store 实例。用户实测：在一边打字，
 * 另一边看不到，必须关掉磁贴再打开才刷新。走到本判据时，磁贴→主窗口 的那一半恰好被挡住：
 * 本篇只要被本地编辑过一次，`locallyEdited === true` 就永远为真 ⇒ 磁贴写进来的内容被拒。
 *
 * 因此新增了一条**来源已证实**的通路（不是放宽本判据）：
 *   `store/notes.ts` 广播 `zhijian://note-changed` → 接收窗口重读 → 给编辑器自增
 *   `remoteAdoptToken`（`EditorPaneComponentProps`）→ 编辑器据此把 `locallyEdited` 清零，
 *   于是本判据里只剩 `busy` 一道闸门。
 * 之所以安全：`lib/tauri.ts::onNoteChanged` 在源头过滤了 `source === 本窗口` 的回声，
 * 所以"这次变化是本窗口自己写的"这一可能性已被排除 —— 而这正是 `locallyEdited` 存在的全部理由。
 * 另外那条通路的调用方只在**本窗口没有焦点**时发令牌（焦点独占 ⇒ 用户不可能正在打字），
 * 于是"打断输入"这个本判据最怕的后果在结构上不可能发生。
 *
 * 一句话总结三层各自负责什么：
 *   - `busy`：任何通路下都挡住"有在途输入时被覆盖"（唯一硬闸门）；
 *   - `locallyEdited`：只用于挡住**来源不明**的整篇替换（可能是乱序回包）；
 *   - `remoteAdoptToken`：把"来源已证实是别的窗口"这一信息带进来，解除第二层。
 */

export interface ExternalDraftInput {
  /** 上层（store/DB）送来的最新值 */
  incoming: string
  /** 编辑器当前草稿 */
  draft: string
  /** 本笔记本次打开后是否发生过本地编辑（单调：一旦为 true 不再回落） */
  locallyEdited: boolean
  /** 是否有未落库（防抖等待中）或正在落库的改动 */
  busy: boolean
}

/** 采纳外部值吗？ */
export function shouldAdoptExternalDraft(input: ExternalDraftInput): boolean {
  if (input.incoming === input.draft) return false
  if (input.locallyEdited) return false
  if (input.busy) return false
  return true
}

/**
 * t16 的旧判据（**只用于自检对照**，生产代码不再使用）。
 * 保留在这里是为了让「修复前后对比」可执行、可回归：
 * 自检脚本会用同一条竞态时序证明旧判据会误判、新判据不会。
 */
export function legacyExternalRewriteDetected(input: {
  incoming: string
  draft: string
  lastSent: string
}): boolean {
  return input.incoming !== input.draft && input.incoming !== input.lastSent
}

/**
 * 一条竞态时序的样本（自检用）：时刻 → 三个值的快照。
 * 放在这里而不是测试脚本里，是为了让"哪一条时序会翻车"成为**可读的文档**。
 */
export interface RaceStep {
  label: string
  noteContent: string
  draft: string
  lastSent: string
}

/** 乱序回包时序（本题复现的那一条）：旧 payload 最后到达 */
export const STALE_ECHO_RACE: RaceStep[] = [
  { label: 't1 打 AAA 并保存(payload#1)', noteContent: '基线\nAAA', draft: '基线\nAAA', lastSent: '基线\nAAA' },
  { label: 't2 打 BBB 并保存(payload#2)', noteContent: '基线\nAAABBB', draft: '基线\nAAABBB', lastSent: '基线\nAAABBB' },
  { label: 't3 继续打 CCC（未保存）', noteContent: '基线\nAAABBB', draft: '基线\nAAABBBCCC', lastSent: '基线\nAAABBB' },
  { label: 't4 payload#1 的回包最后到达', noteContent: '基线\nAAA', draft: '基线\nAAABBBCCC', lastSent: '基线\nAAABBB' },
]
