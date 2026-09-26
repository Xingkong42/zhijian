/**
 * TileApp —— 桌面便签磁贴视图（一个窗口只渲染一条笔记）。
 * 归属：编辑器成员（任务 t24）。Rust 侧的窗口创建/位置/生命周期归 t19（system）。
 *
 * 入口契约（captain t24 定死）：
 *   - 磁贴窗口加载同一份前端，URL 带 `?tile=<noteId>`；
 *   - 主入口用 `readTileNoteId(location.search)` 判定渲染 `<TileApp noteId={id} />` 还是 `<App />`。
 *   详见同目录 README.md「接入点」。
 *
 * 设计要点：
 *  1. **复用主编辑器**：正文用 `CodeMirrorEditor`（Live Preview、主题、快捷键与主窗口完全一致），
 *     标题用单行 Input —— 不在磁贴里再写一个编辑器。
 *  2. **自动保存复用 `useAutoSave`**，并且严格遵守 t16 验证过的红线：
 *     保存目标永远是「本次渲染闭包里的 noteId」，绝不现读 store 的 selectedId /
 *     遍历 store.notes —— 磁贴窗口的 store 是独立的，现读只会写错对象。
 *  3. **窗口无边框，但必须能拖**：header 用 `data-tauri-drag-region="deep"`
 *     （Tauri 2.11 语义：子树内任意位置可拖，但遇到按钮等可点击元素会自动让路）。
 *  4. **noteId 失效不白屏**：笔记被删/不存在 → 文案 + 关闭按钮。
 *  5. 颜色只用 `--zj-*` token；尺寸用设计刻度。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, Pin, Unlink, X } from 'lucide-react'
import { Badge, IconButton, Input } from '@/components/ui'
import { COMMANDS, isTauri, onNoteChanged, onTilesChanged } from '@/lib/tauri'
import { cn, errorMessage } from '@/lib/utils'
import { CodeMirrorEditor } from '@/features/editor/CodeMirrorEditor'
import { useAutoSave } from '@/features/editor/useAutoSave'
import { initDb } from '@/db'
import { notesRepo } from '@/db/notes'
import { useNotesStore } from '@/store/notes'
import { listTiles, setTilePinned, ungroupTile } from './tileWindows'
import type { Note, NoteUpdatePatch } from '@/types'
import {
  TILE_AUTO_SAVE_DELAY_MS,
  TILE_LOAD_ERROR_TITLE,
  TILE_MISSING_NOTE_HINT,
  TILE_MISSING_NOTE_TITLE,
} from './tileUrl'
import './tile.css'

/**
 * 入口判定用纯函数在这里一并 re-export：
 * 主入口既可以 `from '@/features/tiles'`，也可以 `from '@/features/tiles/TileApp'`
 * （captain 的 t24 任务书写的是后者）。
 */
export { isTileLocation, readTileNoteId, tileWindowLabel, tileWindowUrl } from './tileUrl'

/* ------------------------- 默认 I/O（可注入以便自检） ------------------------- */

/** 非 Tauri 环境下的统一可读错误（与项目其它入口的文案保持一致口径） */
const NO_DB_MESSAGE = '数据库不可用：当前不在 Tauri 运行环境（请使用 pnpm tauri:dev 启动）'

/**
 * 读单条笔记：`notesRepo.get` 是现有只读接口，磁贴只需要这一条，不惊动全局列表。
 *
 * ⚠️ 必须先判 `isTauri`：浏览器 dev 下 `initDb()`（tauri-plugin-sql 的 Database.load）
 * **不会 reject，而是永久挂起**——不判的话磁贴会一直停在「载入中…」。
 * 主应用走的是同一套判断（App.tsx 里 `if (!isTauri) → unavailable`）。
 */
export async function defaultLoadTileNote(id: string): Promise<Note | null> {
  if (!isTauri) throw new Error(NO_DB_MESSAGE)
  await initDb()
  return notesRepo.get(id)
}

/**
 * 保存补丁：走既有的 store 通道（唯一写入口），并把 store 吞掉的错误还原成异常，
 * 让 `useAutoSave` 的「保存失败」状态与 tooltip 能如实显示。
 * 同样先判 `isTauri`，避免浏览器 dev 下卡在「保存中…」。
 */
export async function defaultSaveTileNote(id: string, patch: NoteUpdatePatch): Promise<void> {
  if (!isTauri) throw new Error(NO_DB_MESSAGE)
  await useNotesStore.getState().update(id, patch)
  const message = useNotesStore.getState().error
  if (message) throw new Error(message)
}

/**
 * 关闭当前窗口（磁贴是独立窗口，直接 close；主窗口的「关闭即隐藏」逻辑不在这里）。
 *
 * ⚠️ system 复核提醒：`getCurrentWindow().close()` 需要 `core:window:allow-close`，
 * 而 `core:default` 只含窗口的**只读**操作 —— 若 `capabilities/tiles.json` 漏了这条授权，
 * 关闭按钮会**静默失败**（不报错、窗口也不关）。这里显式 warn 便于定位，
 * 但不向用户抛异常（点了没反应已经够糟，再弹错更糟）。
 */
function defaultCloseTile(): void {
  if (!isTauri) {
    console.info('[纸笺] 浏览器 dev：关闭磁贴按钮不会真的关窗口（无 Tauri 环境）')
    return
  }
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch((error: unknown) => {
      console.warn(
        '[纸笺] 关闭磁贴失败（检查 capabilities/tiles.json 是否含 core:window:allow-close）：',
        error,
      )
    })
}

/* ------------------- t45：固定状态（固定的磁贴下次启动自动出现） ------------------- */

/**
 * 读这条磁贴的固定状态（权威值在 Rust 的 `tiles.json`，前端不自行缓存）。
 * 返回 null = 读不到（浏览器 dev / 命令不可用）⇒ UI 不假装知道。
 */
export async function defaultLoadTilePinned(noteId: string): Promise<boolean | null> {
  const tiles = await listTiles()
  if (!tiles) return null
  return tiles.find((tile) => tile.noteId === noteId)?.pinned ?? false
}

/** 写固定状态；返回设置后的值，null = 失败（UI 据此提示，而不是让图钉"看起来点动了"） */
export async function defaultSaveTilePinned(
  noteId: string,
  pinned: boolean,
): Promise<boolean | null> {
  return setTilePinned(noteId, pinned)
}

/* ------------------- t47：吸附组（读状态 + 显式解组） ------------------- */

/**
 * 读这条磁贴的吸附组号（0 = 未成组）。权威值同样只在 Rust。
 * 返回 null = 读不到 ⇒ UI **不显示**「取消吸附」按钮（宁可不显示，也不给一个点了没反应的假入口）。
 */
export async function defaultLoadTileGroup(noteId: string): Promise<number | null> {
  const tiles = await listTiles()
  if (!tiles) return null
  return tiles.find((tile) => tile.noteId === noteId)?.group ?? 0
}

/** 取消吸附；返回 true = 之前在组里，null = 命令不可用 */
export async function defaultUngroupTile(noteId: string): Promise<boolean | null> {
  return ungroupTile(noteId)
}

/** 把主窗口叫到前台（复用 Rust 已有的 window_show 命令；同样需要 tiles.json 授权） */
function openMainWindow(): void {
  if (!isTauri) return
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke(COMMANDS.windowShow))
    .catch((error: unknown) => {
      console.warn(
        '[纸笺] 唤起主窗口失败（检查 capabilities/tiles.json 是否含 core:window:allow-show）：',
        error,
      )
    })
}

/* --------------------------------- 组件 --------------------------------- */

export interface TileAppProps {
  /** 这个窗口要渲染的笔记 id（来自 `?tile=` 参数） */
  noteId: string
  /** 读笔记（默认 initDb + notesRepo.get）；自检页注入假数据以便无 DB 环境验证 */
  loadNote?: (id: string) => Promise<Note | null>
  /** 保存补丁（默认 notesStore.update）；自检页注入探针 */
  saveNote?: (id: string, patch: NoteUpdatePatch) => Promise<void>
  /** 关闭窗口（默认 getCurrentWindow().close()）；自检页注入探针 */
  onRequestClose?: () => void
  /**
   * t45：读固定状态（默认走 `cmd_list_tiles` 找自己那条）；自检页注入探针。
   * 返回 null = 读不到（浏览器 dev），UI 不假装知道。
   */
  loadPinned?: (noteId: string) => Promise<boolean | null>
  /** t45：写固定状态（默认 `cmd_set_tile_pinned`）；返回设置后的值，null = 失败 */
  savePinned?: (noteId: string, pinned: boolean) => Promise<boolean | null>
  /**
   * t47：读吸附组号（0 = 未成组）。返回 null = 读不到 ⇒ 不显示「取消吸附」按钮。
   */
  loadGroup?: (noteId: string) => Promise<number | null>
  /** t47：取消吸附（默认 `cmd_ungroup_tile`）；返回 true = 之前在组里 */
  ungroup?: (noteId: string) => Promise<boolean | null>
}

type TileStatus = 'loading' | 'ready' | 'missing' | 'error'

interface TileDraft {
  id: string
  title: string
  content: string
}

export function TileApp({
  noteId,
  loadNote,
  saveNote,
  onRequestClose,
  loadPinned,
  savePinned,
  loadGroup,
  ungroup,
}: TileAppProps) {
  const load = loadNote ?? defaultLoadTileNote
  const save = saveNote ?? defaultSaveTileNote
  const closeTile = onRequestClose ?? defaultCloseTile
  const readPinned = loadPinned ?? defaultLoadTilePinned
  const writePinned = savePinned ?? defaultSaveTilePinned
  const readGroup = loadGroup ?? defaultLoadTileGroup
  const ungroupTileNow = ungroup ?? defaultUngroupTile

  const [status, setStatus] = useState<TileStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState<TileDraft>({ id: noteId, title: '', content: '' })
  /**
   * t45：固定状态。`null` = 还不知道（读不到 / 读取中）——
   * 刻意用三态而不是 `false`：读不到时把图钉画成"未固定"就是在编造状态。
   */
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [pinBusy, setPinBusy] = useState(false)
  /**
   * t47：吸附组号（0 = 未成组）。`null` = 还不知道 —— 同样不猜：
   * 读不到时不显示「取消吸附」按钮（显示了却没反应比不显示更糟）。
   */
  const [group, setGroup] = useState<number | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setLoadError('')
    void load(noteId)
      .then((note) => {
        if (cancelled) return
        if (!note) {
          setStatus('missing')
          return
        }
        setDraft({ id: note.id, title: note.title, content: note.content })
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(errorMessage(error))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [noteId, load])

  /**
   * 自动保存。
   *
   * ⚠️ 红线（t16 用户实测 Bug）：`onFlush` 只写「本次渲染闭包捕获的 noteId」。
   * 这里**刻意不读** `useNotesStore.getState().selectedId`，也不遍历 store.notes：
   * 磁贴窗口有独立的 store 实例，现读会拿到 null / 别的笔记，把 A 的正文写进 B。
   */
  const autoSave = useAutoSave({
    scopeKey: noteId,
    delayMs: TILE_AUTO_SAVE_DELAY_MS,
    onFlush: (payload) => {
      const patch: NoteUpdatePatch = {}
      if (payload.title !== undefined) patch.title = payload.title
      if (payload.content !== undefined) patch.content = payload.content
      if (patch.title === undefined && patch.content === undefined) return
      return save(noteId, patch)
    },
  })

  const scheduleRef = useRef(autoSave.schedule)
  const flushRef = useRef(autoSave.flush)
  scheduleRef.current = autoSave.schedule
  flushRef.current = autoSave.flush

  /** `autoSave` 每次渲染都是新对象，订阅 effect 不能直接依赖它 —— 用 ref 镜像（同上面两个） */
  const hasPendingRef = useRef(autoSave.hasPending)
  hasPendingRef.current = autoSave.hasPending

  /**
   * t44：接收**其它窗口**（主窗口 / 另一块磁贴）对这条笔记的改写 —— 双向实时同步的接收侧。
   *
   * 用户实测的问题：在主窗口笔记里打字，磁贴里看不到；反过来也一样，
   * 必须关掉磁贴再打开才刷新。根因不是"没刷新"，而是**两个窗口是两套 store**：
   * 磁贴窗口的 zustand 实例与主窗口完全独立，A 写库 B 无从得知。
   *
   * 三条守卫（缺一不可，都是为了"绝不弄丢用户刚敲的字"）：
   *  1. `onNoteChanged` 已在 lib 层过滤**自己的回声**（`source === 本窗口 label`）⇒ 只处理别人的改动；
   *  2. **本窗口有焦点就不动**：焦点是独占的，本窗口有焦点就说明用户正在这里敲键盘，
   *     此刻替换正文/标题只会打断输入（正是 t16/t32 修过的「光标跳首行」那一类），
   *     而这时对面窗口没焦点、它自己会刷新 —— 两边都由同一条件保证，不需要额外协商；
   *  3. **本地还有未落库的输入（`hasPending`）就不动**：这些字马上会被写库并广播出去
   *     （后写者胜），此刻若用库里的旧内容覆盖，用户刚打的字会先被抹掉再被写回 —— 真实丢字。
   *
   * 只更新**内容确实变了**的字段，避免无意义 setState 造成输入框/编辑器选区抖动。
   */
  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void onNoteChanged((payload) => {
      if (cancelled || payload.noteId !== noteId) return
      if (typeof document !== 'undefined' && document.hasFocus()) return
      if (hasPendingRef.current) return
      void load(noteId)
        .then((note) => {
          if (cancelled || !note) return
          setDraft((previous) =>
            previous.title === note.title && previous.content === note.content
              ? previous
              : { id: note.id, title: note.title, content: note.content },
          )
        })
        .catch((error: unknown) => {
          // 同步失败不改变已有内容、也不打断编辑：留痕即可（磁贴没有第二个提示位）
          console.warn('[纸笺] 磁贴同步外部改动失败：', error)
        })
    }).then((off) => {
      // 订阅是异步建立的：组件可能在这之前就卸载了，此时必须立刻退订（否则每次开关磁贴叠加一个订阅）
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [noteId, load])

  /**
   * t45：读固定状态（权威值在 Rust，不在本窗口缓存）。
   *
   * 为什么单独一次 IPC：磁贴窗口自己不知道 `tiles.json` 里那条是不是 fixed，
   * 而"这个按钮该不该亮"必须如实 —— 猜一个 false 会让用户以为固定没生效。
   */
  useEffect(() => {
    let cancelled = false
    void readPinned(noteId)
      .then((value) => {
        if (!cancelled) setPinned(value)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn('[纸笺] 读取磁贴固定状态失败：', error)
          setPinned(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [noteId, readPinned])

  /**
   * t47：读吸附组号，并**订阅**状态变化。
   *
   * 为什么需要订阅：吸附/成组发生在 **Rust 侧**（拖动停止后的去抖点），
   * 磁贴自己不做任何动作 —— 不订阅的话，"刚被吸住的磁贴"不会知道该显示「取消吸附」。
   * Rust 在成组/解组时广播 `zhijian://tiles-changed`（与"磁贴被关闭"复用同一个信号）。
   */
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    const refresh = () => {
      void readGroup(noteId)
        .then((value) => {
          if (!cancelled) setGroup(value)
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            console.warn('[纸笺] 读取吸附组失败：', error)
            setGroup(null)
          }
        })
    }
    refresh()
    void onTilesChanged(refresh).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [noteId, readGroup])

  /** t47：显式取消吸附（用户 Q1 选的"拖开自动分开 + 按钮"里的按钮那一半） */
  const handleUngroup = useCallback(async () => {
    if (groupBusy) return
    setGroupBusy(true)
    try {
      const applied = await ungroupTileNow(noteId)
      if (applied === null) {
        console.warn('[纸笺] 取消吸附失败（命令不可用或未授权），按钮保持原状')
        return
      }
      // 以 Rust 为准：它返回"之前在不在组里"，真正的组号由订阅/下一次读取同步
      void readGroup(noteId).then((value) => setGroup(value))
    } catch (error: unknown) {
      console.warn('[纸笺] 取消吸附失败：', error)
    } finally {
      setGroupBusy(false)
    }
  }, [groupBusy, noteId, readGroup, ungroupTileNow])

  /**
   * t45：切换固定。**以 Rust 的返回值为准**（而不是本地取反）：
   * 设置失败时图钉必须弹回原状态，否则用户会以为"固定住了"，下次启动却什么都没出现。
   */
  const handleTogglePinned = useCallback(async () => {
    if (pinBusy) return
    const next = !(pinned ?? false)
    setPinBusy(true)
    try {
      const applied = await writePinned(noteId, next)
      if (applied === null) {
        console.warn('[纸笺] 固定状态写入失败（命令不可用或未授权），图钉保持原状态')
        return
      }
      setPinned(applied)
    } catch (error: unknown) {
      console.warn('[纸笺] 固定状态写入失败：', error)
    } finally {
      setPinBusy(false)
    }
  }, [noteId, pinBusy, pinned, writePinned])

  const handleTitleChange = useCallback((value: string) => {
    setDraft((previous) => (previous.title === value ? previous : { ...previous, title: value }))
    scheduleRef.current({ title: value })
  }, [])

  const handleContentChange = useCallback((text: string) => {
    setDraft((previous) => (previous.content === text ? previous : { ...previous, content: text }))
    scheduleRef.current({ content: text })
  }, [])

  const saveFailed = autoSave.error !== null
  const saveLabel = saveFailed
    ? '保存失败'
    : autoSave.status === 'saving'
      ? '保存中…'
      : autoSave.hasPending
        ? '未保存'
        : '已保存'
  const saveHint = saveFailed
    ? `保存失败：${autoSave.error}`
    : '停止输入后自动保存（Ctrl/Cmd+S 立即保存）'

  return (
    <div
      data-zj-tile=""
      className="zj-tile flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text"
    >
      {/* 拖拽区：deep = 子树内任意位置可拖，按钮自动让路（见 Titlebar.tsx 的说明） */}
      <header
        data-tauri-drag-region="deep"
        data-zj-tile-header=""
        className="flex h-8 shrink-0 select-none items-center gap-2 border-b border-border bg-surface-2 pl-2 pr-1"
      >
        <span className="min-w-0 flex-1 truncate text-2xs text-muted">纸笺磁贴</span>
        {/* t47：取消吸附 —— **只在真的吸在一组时**出现（读不到状态时也不显示）。
            拖动时"拖开即分开"是隐式解组，这个按钮是显式的兜底（用户 Q1 选了"两者都要"）。 */}
        {group !== null && group > 0 ? (
          <IconButton
            icon={Unlink}
            label="取消吸附（与相邻磁贴分开）"
            tooltip
            size="icon-sm"
            variant="ghost"
            disabled={groupBusy}
            data-zj-tile-ungroup={String(group)}
            onClick={() => void handleUngroup()}
          />
        ) : null}
        {/* t45：固定 —— 固定的磁贴下次启动会自动出现；未固定的是本次会话的临时磁贴。
            图标恒为图钉，状态用「高亮 + aria-pressed + tooltip」表达；
            固定状态是**三态**（null = 读不到），读不到时不点亮也不假装"已取消"。 */}
        <IconButton
          icon={Pin}
          label={
            pinned === null
              ? '读取固定状态…'
              : pinned
                ? '已固定：下次启动自动出现（点击取消）'
                : '固定：下次启动自动出现'
          }
          tooltip
          size="icon-sm"
          variant={pinned ? 'secondary' : 'ghost'}
          aria-pressed={pinned === true}
          disabled={pinBusy || pinned === null}
          data-zj-tile-pin={pinned === null ? 'unknown' : pinned ? 'on' : 'off'}
          onClick={() => void handleTogglePinned()}
          className={cn(pinned ? 'text-accent' : undefined)}
        />
        <Badge
          variant={saveFailed ? 'outline' : 'muted'}
          size="sm"
          title={saveHint}
          data-zj-tile-save-status={saveFailed ? 'error' : autoSave.status}
        >
          {saveLabel}
        </Badge>
        <IconButton
          icon={AppWindow}
          label="打开主窗口"
          tooltip
          size="icon-sm"
          data-zj-tile-open-main=""
          onClick={openMainWindow}
        />
        <IconButton
          icon={X}
          label="关闭磁贴"
          tooltip
          size="icon-sm"
          data-zj-tile-close=""
          onClick={closeTile}
        />
      </header>

      {status === 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Input
            bare
            inputSize="sm"
            value={draft.title}
            onChange={(event) => handleTitleChange(event.target.value)}
            onBlur={() => flushRef.current()}
            placeholder="无标题"
            aria-label="磁贴标题"
            data-zj-tile-title=""
            className="h-8 shrink-0 border-b border-border px-3 text-body font-medium"
          />
          <CodeMirrorEditor
            key={draft.id}
            noteId={draft.id}
            value={draft.content}
            onChange={handleContentChange}
            onSaveRequest={() => flushRef.current()}
            placeholder="写点什么…"
            autoFocus={false}
            className="min-h-0 flex-1"
          />
        </div>
      ) : (
        <div
          data-zj-tile-state={status}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
        >
          {status === 'loading' ? (
            <p className="text-meta text-muted">载入中…</p>
          ) : status === 'missing' ? (
            <>
              <p className="text-ui font-medium text-text">{TILE_MISSING_NOTE_TITLE}</p>
              <p className="max-w-56 text-meta text-muted">{TILE_MISSING_NOTE_HINT}</p>
              <IconButton icon={X} label="关闭磁贴" variant="outline" size="icon-sm" onClick={closeTile} />
            </>
          ) : (
            <>
              <p className="text-ui font-medium text-text">{TILE_LOAD_ERROR_TITLE}</p>
              <p
                className={cn('max-w-56 text-meta text-muted', 'break-words')}
                title={loadError}
                data-zj-tile-error=""
              >
                {loadError || '未知原因'}
              </p>
              <IconButton icon={X} label="关闭磁贴" variant="outline" size="icon-sm" onClick={closeTile} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
