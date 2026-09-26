/**
 * 磁贴自检页（浏览器验证用，**不参与生产构建**）。
 * 归属：编辑器成员（任务 t24）。
 *
 * 用法：
 *   pnpm dev
 *   - 主界面形态：/src/features/tiles/__checks__/harness.html
 *   - 磁贴形态：  同地址 + `?tile=note-a`（页面顶部会打印 readTileNoteId 的真实结果）
 *
 * 本页在同一个文档里挂载 `<TileApp>`，并用**注入的 I/O**（loadNote / saveNote / onRequestClose）
 * 代替数据库与 Tauri 窗口 —— 因此可以在纯浏览器里验证
 * 「URL → 渲染 → 编辑 → 防抖保存」的完整链路，以及 A→B 串写红线与失效笔记态。
 */

import { Component, useCallback, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import '@/index.css'
import { useThemeStore } from '@/store/theme'
import type { Note, NoteUpdatePatch, ThemeId, ThemeMode } from '@/types'
import { TileApp, defaultLoadTileNote } from '../TileApp'
import { readTileNoteId } from '../tileUrl'

/* ------------------------------ 假数据 ------------------------------ */

function makeNote(id: string, title: string, content: string): Note {
  return {
    id,
    title,
    content,
    folderId: null,
    tags: [],
    pinned: false,
    order: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
  }
}

const NOTE_A = makeNote('note-a', '磁贴 A', '# 磁贴 A\n\n这是 A 的正文。\n')
const NOTE_B = makeNote('note-b', '磁贴 B', 'B 的正文。\n')

interface SaveCall {
  id: string
  patch: NoteUpdatePatch
  at: number
}

interface TileApi {
  /** 页面加载时的 URL 参数解析结果（真实 location.search） */
  urlNoteId: () => string | null
  state: () => unknown
  /** 挂载某个 noteId（模拟磁贴窗口打开） */
  mount: (noteId: string) => void
  /** 把某个 noteId 设为「不存在」（模拟笔记被删） */
  setMissing: (noteId: string, missing: boolean) => void
  /** 让某个 noteId 的读取失败 */
  setLoadError: (noteId: string, message: string | null) => void
  /** DOM 事实 */
  facts: () => unknown
  /** 改标题（走原生 setter + input 事件，React 受控组件会收到） */
  typeTitle: (text: string) => boolean
  /** 往正文末尾插入文本（走 CodeMirror 的 dispatch，等于真实输入） */
  typeBody: (text: string) => boolean
  /** 正文当前内容 */
  body: () => string | null
  /** 「在 A 里打字后立刻切到 B」的串写红线自检 */
  runCrossWriteTest: () => Promise<unknown>
  /** 一次性跑完「改标题 → Ctrl+S 立即保存」链路（自包含，避免多次往返被 HMR 重载打断） */
  runFlushE2E: () => Promise<unknown>
  /** 立刻冲刷（等价 Ctrl+S） */
  flushNow: () => boolean
  /** 保存调用记录 */
  calls: () => unknown
  /** 关闭按钮被点的次数 */
  closeCount: () => number
  /** true = 不注入 I/O，走 TileApp 的默认实现（initDb + notesRepo.get）—— 浏览器里应落到错误态 */
  setRealIo: (value: boolean) => void
  /** 直接探针：调用默认读笔记实现（默认 initDb + notesRepo.get），返回成功/错误而不抛 */
  realLoad: (noteId: string) => Promise<unknown>
  setTheme: (themeId: ThemeId, mode: ThemeMode) => void
}

declare global {
  interface Window {
    __zjTileHarness?: TileApi
  }
}

/** 顶层错误边界：自检页也不该白屏 */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[磁贴自检] 渲染出错：', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <pre className="p-4 text-meta text-text">{`渲染出错：${this.state.error.message}`}</pre>
      )
    }
    return this.props.children
  }
}

function Harness() {
  const [mountedId, setMountedId] = useState<string>('note-a')
  const [missingIds, setMissingIds] = useState<string[]>([])
  const [errorIds, setErrorIds] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, Note>>({
    [NOTE_A.id]: NOTE_A,
    [NOTE_B.id]: NOTE_B,
  })
  const [calls, setCalls] = useState<SaveCall[]>([])
  const [realIo, setRealIo] = useState(false)
  const closeCountRef = useRef(0)
  const themeId = useThemeStore((state) => state.themeId)
  const themeMode = useThemeStore((state) => state.mode)
  const urlNoteId = useMemo(() => readTileNoteId(window.location.search), [])

  const loadNote = useCallback(
    async (id: string): Promise<Note | null> => {
      if (errorIds[id]) throw new Error(errorIds[id])
      if (missingIds.includes(id)) return null
      return notes[id] ?? null
    },
    [errorIds, missingIds, notes],
  )

  /** 保存探针：既记录调用，也把补丁落到本地 notes（模拟落库成功） */
  const saveNote = useCallback(async (id: string, patch: NoteUpdatePatch) => {
    setCalls((previous) => [...previous.slice(-30), { id, patch, at: Date.now() }])
    setNotes((previous) => {
      const target = previous[id]
      if (!target) return previous
      return { ...previous, [id]: { ...target, ...patch, updatedAt: Date.now() } }
    })
  }, [])

  const api = useMemo<TileApi>(
    () => ({
      urlNoteId: () => urlNoteId,
      state: () => ({ mountedId, missingIds, errorIds, themeId, themeMode, notes, calls }),
      mount: (noteId) => setMountedId(noteId),
      setMissing: (noteId, missing) =>
        setMissingIds((previous) =>
          missing ? [...new Set([...previous, noteId])] : previous.filter((id) => id !== noteId),
        ),
      setLoadError: (noteId, message) =>
        setErrorIds((previous) => {
          if (message === null) {
            const next = { ...previous }
            delete next[noteId]
            return next
          }
          return { ...previous, [noteId]: message }
        }),
      facts: () => tileFacts(),
      typeTitle: (text) => {
        const input = document.querySelector<HTMLInputElement>('[data-zj-tile-title]')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set
        setter?.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      typeBody: (text) => {
        const view = findEditorView()
        if (!view) return false
        view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
        return true
      },
      body: () => findEditorView()?.state.doc.toString() ?? null,
      runCrossWriteTest: async () => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        const marker = `@@磁贴串写${Date.now()}@@`

        // 1) 钉在 A：改标题 + 正文，然后**在防抖窗口内**切到 B
        setMountedId('note-a')
        await wait(80)
        window.__zjTileHarness?.typeTitle('A 改过的标题')
        window.__zjTileHarness?.typeBody(`\n${marker}\n`)
        await wait(40)
        setMountedId('note-b')
        await wait(900)

        const after = (
          window.__zjTileHarness?.state() as {
            notes: Record<string, { title: string; content: string }>
          }
        ).notes
        return {
          marker,
          aHasMarker: after['note-a'].content.includes(marker),
          aHasTitle: after['note-a'].title === 'A 改过的标题',
          bHasMarker: after['note-b'].content.includes(marker),
          bTitle: after['note-b'].title,
          calls: (window.__zjTileHarness?.calls() as { calls: SaveCall[] }).calls.slice(-4),
        }
      },
      /**
       * 立刻冲刷。走**真实的 Ctrl/Cmd+S 路径**：CodeMirror 的 keymap → onSaveRequest →
       * useAutoSave.flush()（不依赖 500ms 计时器，因此不受后台标签页的计时器节流影响）。
       */
      runFlushE2E: async () => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        const before = (window.__zjTileHarness?.calls() as { calls: SaveCall[] }).calls.length
        setMountedId('note-a')
        await wait(120)
        const typedTitle = window.__zjTileHarness?.typeTitle('Ctrl+S 标题') ?? false
        const typedBody = window.__zjTileHarness?.typeBody('\nCtrl+S 正文\n') ?? false
        await wait(60)
        const pendingStatus = tileFacts().saveStatus
        const flushed = window.__zjTileHarness?.flushNow() ?? false
        await wait(200)
        const after = window.__zjTileHarness?.calls() as { calls: SaveCall[] }
        const notes = (window.__zjTileHarness?.state() as { notes: Record<string, Note> }).notes
        return {
          typedTitle,
          typedBody,
          pendingStatus,
          flushed,
          addedCalls: after.calls.length - before,
          lastCall: after.calls.slice(-1),
          noteTitle: notes['note-a'].title,
          noteTail: notes['note-a'].content.slice(-12),
          finalStatus: tileFacts().saveStatus,
        }
      },
      flushNow: () => {
        const view = findEditorView()
        if (!view) return false
        view.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
        )
        return true
      },
      calls: () => ({ calls }),
      closeCount: () => closeCountRef.current,
      setRealIo: (value) => setRealIo(value),
      realLoad: async (noteId) => {
        try {
          const note = await defaultLoadTileNote(noteId)
          return { ok: true, noteId: note ? note.id : null }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      setTheme: (id, mode) => {
        useThemeStore.getState().setTheme(id)
        useThemeStore.getState().setMode(mode)
      },
    }),
    [urlNoteId, mountedId, missingIds, errorIds, themeId, themeMode, notes, calls],
  )

  window.__zjTileHarness = api

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-meta">
        <span className="font-medium">磁贴自检页</span>
        <span className="text-muted">（不参与生产构建）</span>
        <span className="ml-2 rounded-zj-sm border border-border px-2 py-0.5 font-mono text-2xs text-muted" data-h="url-param">
          readTileNoteId(location.search) = {urlNoteId === null ? 'null（主窗口形态）' : urlNoteId}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {['note-a', 'note-b'].map((id) => (
            <button
              key={id}
              type="button"
              data-h={`mount-${id}`}
              className="rounded-zj-sm border border-border px-2 py-0.5 hover:bg-hover"
              onClick={() => setMountedId(id)}
            >
              挂载 {id}
            </button>
          ))}
          <button
            type="button"
            data-h="mount-missing"
            className="rounded-zj-sm border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => {
              setMissingIds(['note-a', 'note-b'])
              setMountedId('note-a')
            }}
          >
            笔记不存在
          </button>
          <button
            type="button"
            data-h="mount-error"
            className="rounded-zj-sm border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => {
              setErrorIds({ 'note-a': '数据库不可用：当前不在 Tauri 运行环境' })
              setMountedId('note-a')
            }}
          >
            读取失败
          </button>
          <button
            type="button"
            data-h="toggle-theme"
            className="rounded-zj-sm border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => {
              const store = useThemeStore.getState()
              store.setMode(store.mode === 'dark' ? 'light' : 'dark')
            }}
          >
            明暗切换
          </button>
          <button
            type="button"
            data-h="toggle-real-io"
            className="rounded-zj-sm border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => setRealIo((previous) => !previous)}
          >
            真实 I/O：{realIo ? '开（浏览器下应报错态）' : '关（注入探针）'}
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-start justify-center gap-4 p-4">
        {/* 320×240 = 磁贴窗口默认尺寸，外框只是为了让它在网页里看起来像一个小窗 */}
        <div
          data-h="tile-frame"
          className="h-60 w-80 shrink-0 overflow-hidden rounded-zj border border-border shadow-zj"
        >
          <Boundary>
            {/* realIo=true 时不注入 I/O：走 TileApp 的默认实现（initDb + notesRepo.get），
                浏览器下应落到「读不到这条笔记」错误态而不是白屏。 */}
            <TileApp
              key={realIo ? `${mountedId}-real` : mountedId}
              noteId={mountedId}
              loadNote={realIo ? undefined : loadNote}
              saveNote={realIo ? undefined : saveNote}
              onRequestClose={() => {
                closeCountRef.current += 1
              }}
            />
          </Boundary>
        </div>

        <div className="flex min-h-0 w-72 flex-col gap-1 text-meta text-muted">
          <span className="font-medium text-text">保存调用（最近 6 条）</span>
          {calls.slice(-6).map((call, index) => (
            <span key={`${call.at}-${index}`} className="truncate font-mono text-2xs">
              {call.id} ← {Object.keys(call.patch).join('+')}
            </span>
          ))}
          {calls.length === 0 ? <span>（暂无）</span> : null}
        </div>
      </main>
    </div>
  )
}

/* ------------------------------ DOM 事实 ------------------------------ */

function findEditorView(): EditorView | null {
  const host = document.querySelector<HTMLElement>('[data-zj-editor-host]')
  if (!host) return null
  return EditorView.findFromDOM(host)
}

function tileFacts() {
  const header = document.querySelector<HTMLElement>('[data-zj-tile-header]')
  const title = document.querySelector<HTMLInputElement>('[data-zj-tile-title]')
  const saveBadge = document.querySelector<HTMLElement>('[data-zj-tile-save-status]')
  const stateArea = document.querySelector<HTMLElement>('[data-zj-tile-state]')
  const editorHost = document.querySelector<HTMLElement>('[data-zj-editor-host]')
  return {
    /** 拖拽区：必须存在且值为 deep（Tauri 2.11 的「子树内任意位置可拖」） */
    dragRegion: header?.getAttribute('data-tauri-drag-region') ?? null,
    headerExists: !!header,
    titleValue: title?.value ?? null,
    titlePlaceholder: title?.getAttribute('placeholder') ?? null,
    saveStatus: saveBadge?.getAttribute('data-zj-tile-save-status') ?? null,
    saveLabel: saveBadge?.textContent ?? null,
    closeButton: !!document.querySelector('[data-zj-tile-close]'),
    openMainButton: !!document.querySelector('[data-zj-tile-open-main]'),
    editorHostId: editorHost?.getAttribute('data-zj-editor-host') ?? null,
    bodyText: document.querySelector('.cm-content')?.textContent ?? null,
    stateArea: stateArea?.getAttribute('data-zj-tile-state') ?? null,
    stateText: stateArea?.textContent ?? null,
    loadError: document.querySelector('[data-zj-tile-error]')?.textContent ?? null,
    /** 磁贴根节点的计算背景色（应为 token 值，不是硬编码） */
    tileBg: (() => {
      const root = document.querySelector('[data-zj-tile]')
      return root ? getComputedStyle(root).backgroundColor : null
    })(),
  }
}

const container = document.getElementById('root')
if (container) {
  // HMR 复用同一个 root，避免 "createRoot() on a container that has already been passed…" 噪声
  const scope = window as unknown as { __zjTileHarnessRoot?: Root }
  const root = scope.__zjTileHarnessRoot ?? createRoot(container)
  scope.__zjTileHarnessRoot = root
  root.render(
    <Boundary>
      <Harness />
    </Boundary>,
  )
}
