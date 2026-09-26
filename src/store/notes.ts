/**
 * notesStore —— 便笺状态（契约见 docs/ARCHITECTURE.md §4.2 / §4.6）。
 *
 * 契约：业务数据一律经 `src/db/**` 落库；store 只做内存缓存与编排，
 * **不直接写 SQL、不 import Database**。§4.2 的字段与方法签名不得改：
 * notes / selectedId / loading / error / init / create / select / update /
 * remove / restore / move / listByFolder / listByTag / clearError。
 *
 * 消费方式：`const notes = useNotesStore((s) => s.notes)`
 *
 * 错误策略：db 层抛出的可读 Error 一律收敛到 `error` 字段供 UI 展示；
 * 唯 `create` / `createNoteFromInput` 在写入 `error` 之后**继续向上抛出** ——
 * 调用方需要拿到新建的 Note 才能滚动到它 / 聚焦标题。
 *
 * 集合上下文（`activeView` / `activeFolderId` / `activeTagId`，**追加字段，非契约字段**）：
 * 用于保证 `create` / `move` / `restore` **不会把当前视图悄悄换成「全部」** ——
 * 用户在某个文件夹 / 标签视图里操作时，列表必须仍是那个集合。
 *
 * ⚠️ 标签命名双语义陷阱（t11 / F6）：本 store 的 `activeTagId` 与 `listByTag(name)` 用的是
 * **标签名**，而 `UiState.activeTagId` / `SidebarProps.onSelectView('tag', tag.id)` 用的是
 * **Tag.id**。`listByTag` 因此做了 **id → 名 容错解析**，两种入参都接受，见 `resolveTagName()`。
 *
 * 初始化：**每个访问数据库的入口都先 `await initDb()`**（t3 内部已 memoize，重复调用≈0 成本）。
 * 否则启动瞬间的全局快捷键（Alt+N → `create()`）会撞上「数据库尚未初始化」。
 */

import { create } from 'zustand'
import type { Note, NoteCreateInput, NoteUpdatePatch, UiView } from '@/types'
import { initDb } from '@/db'
import { notesRepo } from '@/db/notes'
import { tagsRepo } from '@/db/tags'
import { broadcastNoteChanged } from '@/lib/tauri'
import { errorMessage } from '@/lib/utils'

/**
 * t44：跨窗口同步的**唯一出口**（写侧）。
 * ============================================================================
 * 为什么必须放在 store 而不是编辑器 / 磁贴组件里：
 *   主窗口与每个磁贴都是**独立 WebView、各持一份 zustand store 实例**，
 *   一边写库另一边不会自动知道。而所有"改内容"的入口最终都收敛到本文件的
 *   `create` / `update` / `remove` / `restore`（编辑器自动保存、磁贴自动保存、
 *   标签操作、回收站操作都走这里）⇒ 只在这里广播，就不会漏掉某一条写入路径。
 *
 * 约定（与 `src/lib/tauri.ts::onNoteChanged` 配对）：
 *   - 只广播 **id**，不广播内容：内容由接收方**重读**取得，避免出现第二份会失真的副本；
 *     重读路径本身不写库 ⇒ 不会回声、不会成环。
 *   - 广播**永不抛错**（`broadcastNoteChanged` 内部已兜底），因此不会污染
 *     "保存成功/失败"的判定；用 `void` 调用以免给保存链路增加等待。
 *   - **不广播的场合**：`move` / `reorder` 只改 `order`、`select` 只改本地 UI ——
 *     磁贴不显示列表顺序，广播它们纯属噪音。
 *   - 已知未覆盖：设置面板的"导入/数据迁移"（`dataTransfer.ts`）绕过 store 直接写
 *     `notesRepo`，不会逐条广播；它结束时会整体刷新集合，磁贴若正显示其中一条
 *     需要重新打开才更新（低频操作，暂不为此增加广播风暴）。
 */


export interface NotesState {
  notes: Note[]
  selectedId: string | null
  loading: boolean
  error: string | null

  /** 启动加载：await initDb() + 拉取首屏列表（全部，不含回收站） */
  init: () => Promise<void>
  /** 新建笔记并选中；folderId 缺省为 null（收件箱） */
  create: (folderId?: string | null) => Promise<Note>
  /** 选中某条笔记（不落库） */
  select: (id: string | null) => void
  /** 局部更新（标题/正文/置顶/标签…），内部走 notesRepo.update */
  update: (id: string, patch: NoteUpdatePatch) => Promise<void>
  /** 软删除进回收站 */
  remove: (id: string) => Promise<void>
  /** 从回收站恢复 */
  restore: (id: string) => Promise<void>
  /** 拖拽排序 / 跨文件夹移动 */
  move: (id: string, targetIndex: number, folderId?: string | null) => Promise<void>
  /** 切换显示集合为某文件夹 */
  listByFolder: (folderId: string | null) => Promise<void>
  /**
   * 切换显示集合为某标签。**入参接受标签名或 Tag.id**（id 会被解析为名字，
   * 见文件头「标签命名双语义陷阱」）。
   */
  listByTag: (tagName: string) => Promise<void>
  /** 清空错误提示 */
  clearError: () => void

  /* ---- 追加：当前集合上下文（不属于 §4.2 契约，供 store 内部与集成层读取） ---- */
  /** 当前集合类型；'settings' 不会出现（那是 UI 视图，不是笔记集合） */
  activeView: Exclude<UiView, 'settings'>
  /** 'folder' 视图下当前文件夹（null = 收件箱） */
  activeFolderId: string | null
  /** 'tag' 视图下当前**标签名**（始终是名字，不是 id —— 解析在 listByTag 入口完成） */
  activeTagId: string | null
  /** 按当前集合重新取值并覆盖 notes（供集成层在外部改动后刷新） */
  refresh: () => Promise<void>
  /* ---- 追加：标签名缓存（非契约字段），用于 listByTag 的 id→名 解析 ---- */
  knownTagNames: ReadonlySet<string>
}

type NotesCollection = Pick<NotesState, 'activeView' | 'activeFolderId' | 'activeTagId'>

/** 首屏 / 按当前集合取值 —— 一切读取都走这里，保证「视图不变」 */
async function fetchCollection(view: NotesCollection): Promise<Note[]> {
  await initDb()
  switch (view.activeView) {
    case 'folder':
      return notesRepo.listByFolder(view.activeFolderId)
    case 'tag':
      return notesRepo.listByTag(view.activeTagId ?? '')
    case 'trash':
      return notesRepo.listAll({ onlyDeleted: true })
    case 'all':
    default:
      return notesRepo.listAll()
  }
}

/** 某个笔记是否属于给定集合（决定 create / restore 后要不要放进列表） */
function noteBelongs(note: Note, view: NotesCollection): boolean {
  switch (view.activeView) {
    case 'folder':
      return note.deletedAt === null && note.folderId === view.activeFolderId
    case 'tag':
      return note.deletedAt === null && note.tags.includes(view.activeTagId ?? '')
    case 'trash':
      return note.deletedAt !== null
    case 'all':
    default:
      return note.deletedAt === null
  }
}

/**
 * 就地按「置顶优先 + order 升序」重排，与 `notesRepo` 的列表约定
 * （`pinned DESC, sort_order ASC, created_at ASC`）一致。
 *
 * 新建 / 恢复 / 拖拽一律经此函数 —— 直接 `[note, ...notes]` 前插会把未置顶的新笔记
 * 显示在置顶项**之上**，与库里顺序不符（下次 refresh 才跳回来，表现为「顺序自己跳一下」）。
 */
function reorderLocally(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.createdAt - b.createdAt,
  )
}

/** 无集合变更时保持原选中项；否则回落到第一条 */
function nextSelection(state: NotesState, notes: Note[]): string | null {
  if (state.selectedId !== null && notes.some((note) => note.id === state.selectedId)) {
    return state.selectedId
  }
  return notes[0]?.id ?? null
}

export const useNotesStore = create<NotesState>()((set, get) => {
  /** 当前集合上下文快照 */
  const collection = (): NotesCollection => {
    const { activeView, activeFolderId, activeTagId } = get()
    return { activeView, activeFolderId, activeTagId }
  }

  /**
   * id → 标签名 容错解析（F6）。
   *
   * `listByTag` 的调用方可能传 Tag.id（因为 `UiState.activeTagId` 存的是 id），
   * 若不解析就会执行 `notesRepo.listByTag(<uuid>)` 去查 `tags.name = <uuid>`
   * ⇒ **恒空列表、静默失败**（无报错，只是标签视图永远没笔记）。
   *
   * 策略：先按名字解析；名字不存在时再当作 id 查一次 `tagsRepo.list()`。
   * 两级都命中不了时原样返回，由 repo 返回空列表（不制造假结果）。
   */
  const resolveTagName = async (raw: string): Promise<string> => {
    const input = raw.trim()
    if (!input) return input
    await initDb()

    // 名字缓存命中 ⇒ 直接当名字用，常见路径零额外查询
    if (get().knownTagNames.has(input)) return input

    // 未命中：只查一次标签表，同时用于「按名解析」与「按 id 解析」
    const tags = await tagsRepo.list()
    const names = new Set(tags.map((tag) => tag.name))
    set({ knownTagNames: names })

    if (names.has(input)) return input
    return tags.find((tag) => tag.id === input)?.name ?? input
  }

  return {
    notes: [],
    selectedId: null,
    loading: false,
    error: null,

    /* 默认集合：全部（不含回收站） */
    activeView: 'all',
    activeFolderId: null,
    activeTagId: null,
    knownTagNames: new Set<string>(),

    init: async () => {
      set({ loading: true, error: null })
      try {
        // 首屏固定为「全部」——此后由 listByFolder / listByTag 决定集合
        const notes = await fetchCollection({
          activeView: 'all',
          activeFolderId: null,
          activeTagId: null,
        })
        set((state) => ({
          notes,
          loading: false,
          activeView: 'all',
          selectedId: nextSelection(state, notes),
        }))
      } catch (error) {
        set({ loading: false, error: errorMessage(error) })
      }
    },

    create: async (folderId = null) => {
      set({ error: null })
      try {
        // F1：启动瞬间按 Alt+N 时 init() 可能还没跑完，先确保连接就绪
        await initDb()
        const note = await notesRepo.create({ folderId })
        // t44：新建也广播 —— 快速笔记窗口建完就关，主窗口的列表必须知道多了一条
        void broadcastNoteChanged(note.id)
        const state = get()

        if (noteBelongs(note, state)) {
          // 属于当前集合：按置顶规则就地插入（F3：不再裸前插）
          set({ notes: reorderLocally([note, ...state.notes]), selectedId: note.id })
          return note
        }

        // F2：不属于当前集合（最典型是「回收站」视图，或标签视图里建了无标签笔记）。
        // 只改 selectedId 会让编辑器指向一条不在列表里的笔记（空白 + 无高亮），
        // 因此这里把集合切到「全部」并重取，保证选中项一定在列表里。
        const notes = await fetchCollection({
          activeView: 'all',
          activeFolderId: null,
          activeTagId: null,
        })
        set({
          notes,
          activeView: 'all',
          selectedId: note.id,
        })
        return note
      } catch (error) {
        set({ error: errorMessage(error) })
        throw error
      }
    },

    select: (id) => {
      set({ selectedId: id })
    },

    update: async (id, patch) => {
      set({ error: null })
      try {
        await initDb()
        const updated = await notesRepo.update(id, patch)
        // t44：本条内容/标题/标签/删除态已落库 ⇒ 通知其它窗口重读这一条
        void broadcastNoteChanged(id)
        set((state) => {
          // patch 可能改变「是否属于当前集合」——最典型的是 `folderId`（移动到别的文件夹）
          // 与 `deletedAt`（软删除/恢复）。若不重新判定，笔记会**留在不该在的视图里**，
          // 直到下次 refresh 才消失（用户表现为「删了还在 / 移走了还在」）。
          const belongs = noteBelongs(updated, state)
          const withoutUpdated = state.notes.filter((note) => note.id !== id)
          if (!belongs) {
            return {
              notes: withoutUpdated,
              selectedId: state.selectedId === id ? (withoutUpdated[0]?.id ?? null) : state.selectedId,
            }
          }
          // 属于当前集合：就地替换（仍不在列表里时按排序规则插入）
          const next = state.notes.some((note) => note.id === id)
            ? state.notes.map((note) => (note.id === id ? updated : note))
            : reorderLocally([updated, ...state.notes])
          return { notes: next }
        })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    remove: async (id) => {
      set({ error: null })
      try {
        await initDb()
        await notesRepo.remove(id)
        // t44：软删除同样是"这条变了" —— 正显示它的磁贴需要据此提示"已移入回收站"
        void broadcastNoteChanged(id)
        set((state) => {
          const notes = state.notes.filter((note) => note.id !== id)
          return {
            notes,
            selectedId: state.selectedId === id ? (notes[0]?.id ?? null) : state.selectedId,
          }
        })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    restore: async (id) => {
      set({ error: null })
      try {
        await initDb()
        const restored = await notesRepo.restore(id)
        // t44：恢复（`deletedAt: null`）也要广播，否则磁贴会一直停在"已删除"态
        void broadcastNoteChanged(id)
        set((state) => {
          // 当前是回收站视图：恢复后该笔记应离开本集合
          if (state.activeView === 'trash') {
            const notes = state.notes.filter((note) => note.id !== id)
            return {
              notes,
              selectedId: state.selectedId === id ? (notes[0]?.id ?? null) : state.selectedId,
            }
          }
          // 其他视图：若恢复后属于本集合且还不在列表里，按置顶规则插入（F3）
          if (!noteBelongs(restored, state) || state.notes.some((note) => note.id === id)) {
            return {}
          }
          return { notes: reorderLocally([restored, ...state.notes]) }
        })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    move: async (id, targetIndex, folderId) => {
      set({ error: null })
      try {
        await initDb()
        const state = get()

        /**
         * t42（captain 裁定方案 A）：**「全部」视图是跨文件夹的规范序**，
         * 必须走 `notesRepo.reorder()` —— 它只改 `order`、**不刷新 `updatedAt`**。
         *
         * 为什么不能再用 `notesRepo.move`：`move` 只在"该笔记所属文件夹"的子集里重排
         * （`Math.min(targetIndex, others.length)`），无法表达"拖到全局第 k 位"：
         *  - 显示下标 3 拖到 0 → 实际落在 5；
         *  - 独自占一个文件夹的笔记 `others.length === 0` ⇒ order 恒被写成同一个值
         *    ⇒ 用户看到的"松手后自动回归原位"；
         *  - 各文件夹各自重排成 `0..m-1` 重叠值 ⇒ 整块窜位。
         * 而 store 又不能用 `update(id, { order })` 绕过去：它会无条件写 `updated_at`，
         * 污染「最近更新」视图（t11/t15 红线）。
         *
         * 传了 `folderId` 说明是"移动到某个文件夹"而不是纯粹排序，仍走 `move`。
         */
        if (state.activeView === 'all' && folderId === undefined) {
          const ids = state.notes.map((note) => note.id)
          const from = ids.indexOf(id)
          if (from >= 0) {
            const desired = [...ids]
            desired.splice(from, 1)
            // 目标下标夹到合法区间；并且**不允许跨过置顶分区**
            // （显示序恒为「置顶在前」，跨过去的话重新读库会被置顶分区拉回去 ⇒ 又变成"回归原位"）
            const pinnedCount = state.notes.filter((note) => note.pinned).length
            const moving = state.notes[from]
            let to = Math.max(0, Math.min(Math.trunc(targetIndex), desired.length))
            if (moving.pinned) to = Math.min(to, Math.max(0, pinnedCount - 1))
            else to = Math.max(to, pinnedCount)
            desired.splice(Math.min(to, desired.length), 0, id)

            const reordered = await notesRepo.reorder(desired)
            if (reordered.length > 0) {
              // reorder 返回的就是新的显示顺序（md 与索引已同步），无需再猜
              set({ notes: reordered, selectedId: id })
              return
            }
          }
        }

        const moved = await notesRepo.move(id, { targetIndex, folderId })
        set((state) => {
          // 不重新查库：就地重排，避免把「文件夹 / 标签」视图悄悄换成「全部」
          const reordered = reorderLocally(
            state.notes.map((note) => (note.id === id ? moved : note)),
          )
          // 被移出当前集合（跨文件夹 / 取消标签）时从列表移除
          const notes = noteBelongs(moved, state)
            ? reordered
            : reordered.filter((note) => note.id !== id)
          return { notes, selectedId: moved.id }
        })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    listByFolder: async (folderId) => {
      set({ loading: true, error: null })
      try {
        const view: NotesCollection = {
          activeView: 'folder',
          activeFolderId: folderId,
          activeTagId: get().activeTagId,
        }
        const notes = await fetchCollection(view)
        set({ notes, loading: false, ...view, selectedId: notes[0]?.id ?? null })
      } catch (error) {
        set({ loading: false, error: errorMessage(error) })
      }
    },

    listByTag: async (tagName) => {
      set({ loading: true, error: null })
      try {
        // F6：入参可能是 Tag.id，统一解析成标签名后再查
        const name = await resolveTagName(tagName)
        const view: NotesCollection = {
          activeView: 'tag',
          activeFolderId: get().activeFolderId,
          activeTagId: name,
        }
        const notes = await fetchCollection(view)
        set({ notes, loading: false, ...view, selectedId: notes[0]?.id ?? null })
      } catch (error) {
        set({ loading: false, error: errorMessage(error) })
      }
    },

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        const notes = await fetchCollection(collection())
        set((state) => ({ notes, loading: false, selectedId: nextSelection(state, notes) }))
      } catch (error) {
        set({ loading: false, error: errorMessage(error) })
      }
    },

    clearError: () => {
      set({ error: null })
    },
  }
})

/** 当前选中的笔记对象（便捷 selector） */
export const selectCurrentNote = (state: NotesState): Note | null =>
  state.notes.find((note) => note.id === state.selectedId) ?? null

/** 供集成层（main.tsx / App.tsx）显式调用；失败只写 error，不抛 */
export async function initNotes(): Promise<void> {
  await useNotesStore.getState().init()
}

/**
 * 便捷：按 NoteCreateInput 直接落库并进入当前集合（导入 / 模板场景）。
 *
 * F5：失败必须与其它方法一致地收敛进 `error`（原先既不写 error 也不进 store，
 * 与文件头声明的错误策略相矛盾）。写入 error 后仍向上抛出，调用方可自行处理。
 */
export async function createNoteFromInput(input: NoteCreateInput): Promise<Note> {
  try {
    // F1：同样先确保数据库就绪
    await initDb()
    const note = await notesRepo.create(input)
    // t44：与 `create` 动作同样广播 —— 快速笔记窗口正是走这条路径建笔记的，
    // 漏掉它的话「快速笔记建完了，主窗口列不出来」（主窗口此刻通常没有焦点，收不到别的信号）
    void broadcastNoteChanged(note.id)
    const store = useNotesStore

    if (noteBelongs(note, store.getState())) {
      store.setState((state) => ({
        notes: reorderLocally([note, ...state.notes]),
        selectedId: note.id,
      }))
      return note
    }

    // 不属当前集合：与 create() 一致地切到「全部」，保证选中项一定在列表里（F2）
    store.setState({
      activeView: 'all',
      activeFolderId: null,
      activeTagId: null,
      selectedId: note.id,
      error: null,
    })
    const notes = await fetchCollection({
      activeView: 'all',
      activeFolderId: null,
      activeTagId: null,
    })
    store.setState({ notes, selectedId: note.id })
    return note
  } catch (error) {
    // F5：与其它的方法一致地写入 error（原先绕过错误收敛）
    useNotesStore.setState({ error: errorMessage(error) })
    throw error
  }
}

/** 回收站视图的专用入口（视图语义不在 §4.2 契约内，故以独立函数提供） */
export async function listTrash(): Promise<void> {
  const store = useNotesStore
  store.setState({ loading: true, error: null })
  try {
    await initDb()
    const notes = await notesRepo.listAll({ onlyDeleted: true })
    store.setState({
      notes,
      loading: false,
      activeView: 'trash',
      selectedId: notes[0]?.id ?? null,
    })
  } catch (error) {
    store.setState({ loading: false, error: errorMessage(error) })
  }
}

/** 切回「全部」集合（便于设置面板关闭后回到默认视图） */
export async function listAll(): Promise<void> {
  const store = useNotesStore
  store.setState({ loading: true, error: null, activeView: 'all' })
  try {
    const notes = await fetchCollection({
      activeView: 'all',
      activeFolderId: null,
      activeTagId: null,
    })
    store.setState({ notes, loading: false, selectedId: notes[0]?.id ?? null })
  } catch (error) {
    store.setState({ loading: false, error: errorMessage(error) })
  }
}

/** store 的公开类型（集成层需要标注 props 时使用） */
export type NotesStore = typeof useNotesStore

export default useNotesStore
