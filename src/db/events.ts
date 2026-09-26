/**
 * 索引变更信号（t35）—— 让"计数/标签/文件夹"这类**派生视图**永远不需要各自记得刷新。
 *
 * 背景（为什么要加这一层）：
 *   `NoteCounts`（侧栏徽标）来自索引的 `note_tags` / `folder_id` 投影，而 App 把它
 *   缓存在 React state 里，**每次写操作后都要有人显式 `reloadMeta()`**。
 *   这种"每个调用点都得记得刷新"的约定已经出过两次事故：
 *     - t20 / F2：重建索引后侧栏徽标不刷新；
 *     - t35：**打标签后**计数不刷新（编辑器/列表走 `notesStore.update(id,{tags})`，
 *            绕过了 App 的 reloadMeta）⇒ 标签里明明有 1 条笔记却显示 0。
 *   与其在每个入口补一行，不如由**索引层**在真正发生写入时发一次信号，
 *   派生视图订阅一次即可（App 的 `useMeta` 就是这么做的）。
 *
 * 语义（三条都很重要）：
 *   - **只有写索引才通知**：`counts()` / `listAll()` / `tree()` / `list()` 等只读操作
 *     绝不通知 —— 否则订阅者 reload 会自激成死循环；
 *   - **一批写入合并为一次通知**：一次 `notesRepo.create` 会连写 notes 行、标签行、
 *     note_tags 行（多次 `notifyIndexMutated()`）。这里用**尾部防抖**（默认 20ms，
 *     见 {@link INDEX_MUTATION_DEBOUNCE_MS}）把它们合并成一次投递 ——
 *     否则订阅者会为一次用户动作重复拉取好几遍。定时器在每次通知时重置，
 *     所以"写完最后一个索引行使之后的 20ms 静默"才会真正投递。
 *   - **订阅者抛错被隔离**：不影响写入方，也不打断其它订阅者。
 */

/** 订阅回调：索引已发生变化，请重新拉取派生数据 */
export type IndexMutationListener = () => void

/** 尾部防抖窗口（ms）：一次用户动作内的多次索引写入合并为一次通知 */
export const INDEX_MUTATION_DEBOUNCE_MS = 20

const listeners = new Set<IndexMutationListener>()
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * 订阅索引变更；返回取消订阅函数。
 * 典型用法（React）：`useEffect(() => onIndexMutated(reload), [reload])`
 */
export function onIndexMutated(listener: IndexMutationListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前订阅者数量（自检/诊断用） */
export function indexMutationListenerCount(): number {
  return listeners.size
}

/** 立即投递（自检用：跳过防抖窗口；生产中不需要） */
export function flushIndexMutatedNotifications(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  deliver()
}

function deliver(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // 订阅者的问题不得影响写入方，也不得打断其它订阅者
      console.warn('[纸笺] 索引变更订阅者抛错（已忽略）：', error)
    }
  }
}

/**
 * 通知订阅者"索引已变更"（尾部防抖：连续写入只投递一次）。
 * 无订阅者时零开销直接返回。
 */
export function notifyIndexMutated(): void {
  if (listeners.size === 0) return
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    deliver()
  }, INDEX_MUTATION_DEBOUNCE_MS)
}

/** 清空订阅与待投递状态（自检收尾用） */
export function resetIndexMutationListeners(): void {
  listeners.clear()
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}
