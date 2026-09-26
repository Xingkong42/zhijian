/**
 * 编辑器自检页（浏览器验证用，**不参与生产构建**）。
 * 归属：编辑器成员（任务 t4 起）。
 *
 * 用法：pnpm dev 后打开 /src/features/editor/__checks__/harness.html
 * 自检脚本：
 *   - node src/features/editor/__checks__/run-checks.mjs   （纯函数断言，含 TagPicker 逻辑）
 *   - node src/features/editor/__checks__/probe-shiki.mjs  （Shiki 细粒度/双主题）
 *   - 页面内 window.__zjHarness.*                          （真实 UI：Live Preview / 工具栏 / IME / 标签入口）
 *
 * 集成本页的写法就是 t10 集成层应采用的写法：
 *   onContentChange={(content) => updateNote(renderedNote.id, { content })}
 * 即**必须写入本次渲染的 note**，不要现读 store 里的 selectedId。
 * 标签同理：onEditTags={(next) => updateNote(renderedNote.id, { tags: next })}。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import '@/index.css'
import { useThemeStore } from '@/store/theme'
import { useNotesStore } from '@/store/notes'
import type { Note, Tag, ThemeId, ThemeMode } from '@/types'
import { EditorPane } from '../EditorPane'
import type { EditorMode } from '../EditorPane'
import { livePreviewBuildCount } from '../livePreview'

const NOTE_A: Note = {
  id: 'note-a',
  title: '编辑器自检 · A',
  folderId: null,
  tags: ['自检'],
  pinned: false,
  order: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  deletedAt: null,
  content: [
    '# 纸笺 · 编辑器自检',
    '',
    '> 淡雅便笺：留白多于装饰。',
    '',
    '正文里有**加粗**、*斜体*、~~删除线~~、`行内代码` 与 [外链](https://example.com)。',
    '',
    '## GFM 表格',
    '',
    '| 能力 | 状态 | 说明 |',
    '| --- | :--: | --- |',
    '| 表格 | 完成 | remark-gfm |',
    '| 任务列表 | 完成 | checkbox |',
    '',
    '## 任务列表',
    '',
    '- [x] 编辑 / 分栏 / 预览三态',
    '- [ ] 拖拽调整分栏比例',
    '',
    '## 列表与分隔线',
    '',
    '- 无序项一',
    '- 无序项二',
    '',
    '1. 有序项一',
    '2. 有序项二',
    '',
    '### 三级标题',
    '',
    '---',
    '',
    '## 代码块',
    '',
    '```ts',
    'const greet = (name: string): string => `你好，${name}`',
    '```',
    '',
    '```rust',
    'fn main() { println!("纸笺"); }',
    '```',
    '',
    '```unknownlang',
    '回退为纯文本，不应白屏。',
    '```',
  ].join('\n'),
}

const NOTE_B: Note = {
  id: 'note-b',
  title: '第二篇 · B',
  folderId: null,
  tags: [],
  pinned: false,
  order: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  deletedAt: null,
  content: '# 第二篇\n\n这里是 B 的正文，用来验证切换笔记不会串写。\n',
}

type CallbackMode = 'captured' | 'latelinked' | 'store'

const CALLBACK_MODES: CallbackMode[] = ['captured', 'latelinked', 'store']

/** 模拟集成层的标签库（真实集成是 tagsRepo.list()） */
const TAG_CATALOG: Tag[] = [
  { id: 'tag-1', name: '写作', color: '#C9A227', createdAt: 0 },
  { id: 'tag-2', name: '灵感', color: '#5B8C6E', createdAt: 0 },
  { id: 'tag-3', name: '工作', color: '', createdAt: 0 },
]

type TagEditMode = 'spy' | 'store'

interface LogEntry {
  at: number
  text: string
}

interface HarnessApi {
  state: () => unknown
  select: (id: string | null) => void
  setMode: (mode: EditorMode) => void
  setCallbackMode: (mode: CallbackMode) => void
  setTheme: (themeId: ThemeId, mode: ThemeMode) => void
  /** 往 CodeMirror 文档末尾插入文本（走真实的 updateListener → 防抖保存） */
  type: (text: string) => number
  /** 取 CodeMirror 文档内容 */
  doc: () => string | null
  /** 取 CodeMirror EditorView（自检用，便于精确设置选区） */
  view: () => EditorView | null
  /** 预览区 DOM 事实（GFM 表格 / 任务列表 / Shiki 高亮） */
  previewFacts: () => unknown
  /** Live Preview DOM 事实（逐行的隐藏标记 / widget / 样式类） */
  livePreviewFacts: () => unknown
  /** 工具栏 DOM 事实（按钮存在性 + aria-pressed 激活态 + 禁用态） */
  toolbarFacts: () => unknown
  /** 把光标放到第 n 行（1-based），用于验证「光标行显示源码」 */
  goToLine: (lineNumber: number) => boolean
  /** 点一下工具栏按钮（真实 DOM click） */
  clickToolbar: (command: string) => boolean
  /** 模拟中文输入法组合：compositionstart → 组合中写入文档 → compositionend */
  simulateComposition: (text: string) => Promise<unknown>
  /* ---------------- t32：输入被打断的竞态复现 ---------------- */
  /** 编辑器即时事实：doc / 选区 / 焦点 / 组合状态 */
  raceFacts: () => unknown
  /** 模拟「store 的过期回写」：把 note.content 改成某个更早的值（真实场景是乱序 resolve 的旧 payload） */
  setNoteContent: (id: string, content: string) => void
  /** 复现 A：打字 → 保存回包（旧内容）→ 打字 → 再收到旧回包（乱序），观察 doc/选区是否被冲掉 */
  runStaleWriteRace: () => Promise<unknown>
  /** 复现 B：组合中（compositionstart 之后、首次变更之前）收到外部 value 回写 */
  runCompositionClobber: () => Promise<unknown>
  /** t23：标签入口 DOM 事实（按钮徽标 / 面板 / 选项 / 新建行） */
  tagFacts: () => unknown
  /** t23：打开 / 关闭标签面板（真实 DOM click） */
  openTags: () => boolean
  closeTags: () => boolean
  /** t23：在面板搜索框输入（触发 input 事件） */
  setTagQuery: (text: string) => boolean
  /** t23：点某个标签选项（真实 DOM click） */
  clickTagOption: (name: string) => boolean
  /** t23：在搜索框按回车（新建 / 勾选唯一候选） */
  pressTagEnter: () => boolean
  /** t23：切换「标签写入」通道：spy = 走 onEditTags；store = 走 notesStore.update 回退路径 */
  setTagEditMode: (mode: TagEditMode) => void
  /** t23：onEditTags 被调用的记录 + 当前 store 错误（验证回退路径是否真的调到了 store） */
  tagCalls: () => unknown
  /** 「A 里打字后立刻切到 B」的串写自检 */
  runSelfTest: () => Promise<unknown>
}

declare global {
  interface Window {
    __zjHarness?: HarnessApi
  }
}

function Harness() {
  const [notes, setNotes] = useState<Record<string, Note>>({
    [NOTE_A.id]: NOTE_A,
    [NOTE_B.id]: NOTE_B,
  })
  const [selectedId, setSelectedId] = useState<string | null>(NOTE_A.id)
  const [mode, setMode] = useState<EditorMode>('split')
  const [dirty, setDirty] = useState(false)
  const [callbackMode, setCallbackMode] = useState<CallbackMode>('captured')
  const [tagEditMode, setTagEditMode] = useState<TagEditMode>('spy')
  const [tagCalls, setTagCalls] = useState<{ next: string[]; at: number }[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  /**
   * 竞态复现专用模式：把防抖调到 60s，只允许 Ctrl+S 显式冲刷 ——
   * 否则「打字后 500ms 定时器自动落库」会把 note 回写成最新内容，
   * 掩盖掉我们要观察的「旧回包」时序（表现为复现不出来）。
   */
  const [raceMode, setRaceMode] = useState(false)
  const themeId = useThemeStore((state) => state.themeId)
  const themeMode = useThemeStore((state) => state.mode)

  const renderedNote = selectedId ? (notes[selectedId] ?? null) : null

  const push = useCallback((text: string) => {
    setLog((previous) => [...previous.slice(-40), { at: Date.now(), text }])
  }, [])

  const updateNote = useCallback(
    (id: string | null, patch: Partial<Note>) => {
      if (!id) return
      setNotes((previous) => {
        const target = previous[id]
        if (!target) return previous
        return { ...previous, [id]: { ...target, ...patch, updatedAt: Date.now() } }
      })
    },
    [],
  )

  /** 正确的集成写法：闭包捕获「本次渲染的笔记 id」 */
  const capturedContentChange = useCallback(
    (content: string) => {
      updateNote(renderedNote?.id ?? null, { content })
      push(`content→${renderedNote?.id ?? 'null'}（捕获）`)
    },
    [renderedNote?.id, updateNote, push],
  )

  /** 反面教材：回调里现读「当前选中 id」（会把上一篇的内容写进新笔记） */
  const lateLinkedContentChange = useCallback(
    (content: string) => {
      updateNote(selectedId, { content })
      push(`content→${selectedId ?? 'null'}（现读 selectedId）`)
    },
    [selectedId, updateNote, push],
  )

  /** 反面教材 2：回调里现读一个「可变引用 / store」（等价于 store 里现读 selectedId） */
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const storeContentChange = useCallback(
    (content: string) => {
      updateNote(selectedIdRef.current, { content })
      push(`content→${selectedIdRef.current ?? 'null'}（现读 store）`)
    },
    [updateNote, push],
  )

  const handleContentChange =
    callbackMode === 'captured'
      ? capturedContentChange
      : callbackMode === 'latelinked'
        ? lateLinkedContentChange
        : storeContentChange

  const handleTitleChange = useCallback(
    (title: string) => {
      updateNote(renderedNote?.id ?? null, { title })
      push(`title→${renderedNote?.id ?? 'null'}`)
    },
    [renderedNote?.id, updateNote, push],
  )

  const clearDirty = useCallback(() => setDirty(false), [])

  /** t23：模拟集成层落库（真实集成是 notesStore.update(note.id, { tags: next })） */
  const handleEditTags = useCallback(
    (next: string[]) => {
      setTagCalls((previous) => [...previous.slice(-20), { next: [...next], at: Date.now() }])
      updateNote(renderedNote?.id ?? null, { tags: next })
      push(`tags→${renderedNote?.id ?? 'null'} [${next.join('|')}]`)
    },
    [renderedNote?.id, updateNote, push],
  )

  const api = useMemo<HarnessApi>(
    () => ({
      state: () => ({
        selectedId,
        mode,
        callbackMode,
        tagEditMode,
        themeId,
        themeMode,
        notes: Object.fromEntries(
          Object.entries(notes).map(([id, note]) => [
            id,
            { title: note.title, content: note.content, tags: note.tags },
          ]),
        ),
        log: log.slice(-20),
      }),
      select: (id) => setSelectedId(id),
      setMode: (next) => setMode(next),
      setCallbackMode: (next) => setCallbackMode(next),
      setTheme: (id, nextMode) => {
        useThemeStore.getState().setTheme(id)
        useThemeStore.getState().setMode(nextMode)
      },
      type: (text) => {
        const view = findEditorView()
        if (!view) return -1
        view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
        return view.state.doc.length
      },
      doc: () => findEditorView()?.state.doc.toString() ?? null,
      view: () => findEditorView(),
      previewFacts: () => previewFacts(),
      livePreviewFacts: () => livePreviewFacts(),
      toolbarFacts: () => toolbarFacts(),
      tagFacts: () => tagFacts(),
      openTags: () => clickDom('[data-zj-tag-button]'),
      closeTags: () => clickDom('[role="dialog"] button[aria-label="关闭"]'),
      setTagQuery: (text) => {
        const input = document.querySelector<HTMLInputElement>('[data-zj-tag-picker] input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set
        setter?.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      clickTagOption: (name) => clickDom(`[data-zj-tag-option="${name}"]`),
      pressTagEnter: () => {
        const input = document.querySelector<HTMLInputElement>('[data-zj-tag-picker] input')
        if (!input) return false
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        )
        return true
      },
      setTagEditMode: (mode) => setTagEditMode(mode),
      tagCalls: () => ({
        mode: tagEditMode,
        calls: tagCalls,
        storeError: useNotesStore.getState().error,
      }),
      goToLine: (lineNumber) => {
        const view = findEditorView()
        if (!view) return false
        if (lineNumber < 1 || lineNumber > view.state.doc.lines) return false
        const line = view.state.doc.line(lineNumber)
        view.dispatch({ selection: { anchor: line.from } })
        view.focus()
        return true
      },
      clickToolbar: (command) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-zj-toolbar-command="${command}"]`,
        )
        if (!button) return false
        button.click()
        return true
      },
      /**
       * 模拟中文输入法组合：
       *   compositionstart → （组合期间）往文档写一个字 → compositionend
       * 断言点：
       *  1. 组合期间 view.compositionStarted === true；
       *  2. 组合期间**光标行仍然显示源码**，其他行照常渲染（装饰没有被清空）；
       *  3. 组合结束后装饰恢复重建（deferred refresh 生效）。
       */
      simulateComposition: async (text) => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        const view = findEditorView()
        if (!view) return { error: 'no view' }
        const content = view.contentDOM

        const buildsBefore = livePreviewBuildCount()
        const before = livePreviewFacts()
        content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        await wait(30)
        const composing = view.compositionStarted
        const duringBefore = livePreviewFacts()
        const buildsAfterStart = livePreviewBuildCount()

        // 组合期间的文档变化（IME 会这样插入拼音/汉字），连做两次
        view.dispatch({ changes: { from: view.state.selection.main.head, insert: text } })
        await wait(30)
        view.dispatch({ changes: { from: view.state.selection.main.head, insert: text } })
        await wait(30)
        const buildsDuring = livePreviewBuildCount()
        const duringAfter = livePreviewFacts()

        content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        await wait(120)
        const afterComposition = view.compositionStarted
        const buildsAfterEnd = livePreviewBuildCount()
        const after = livePreviewFacts()

        return {
          composingFlagDuring: composing,
          composingFlagAfter: afterComposition,
          /** 组合期间的重建次数增量（必须为 0：只是 map 平移，不重算） */
          buildsDuringComposition: buildsDuring - buildsAfterStart,
          /** 组合结束后的重建次数增量（必须 > 0：deferred refresh 生效） */
          buildsAfterCompositionEnd: buildsAfterEnd - buildsDuring,
          buildsBefore,
          before,
          duringBefore,
          duringAfter,
          after,
        }
      },
      raceFacts: () => raceFacts(),
      setNoteContent: (id, content) => {
        // 模拟 store 的「异步回包」：只改正文，模拟「较旧的那次写入最后返回」
        setNotes((previous) => {
          const target = previous[id]
          if (!target) return previous
          return { ...previous, [id]: { ...target, content, updatedAt: Date.now() } }
        })
      },
      runStaleWriteRace: async () => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        setRaceMode(true)
        setSelectedId('note-a')
        setMode('edit')
        await wait(150)
        const view = findEditorView()
        if (!view) {
          setRaceMode(false)
          return { error: 'no view' }
        }

        // ① 干净基线（光标放到正文里，便于观察"跳回首行"）
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '基线\n' } })
        view.dispatch({ selection: { anchor: 3 } })
        await wait(80)
        const base = raceFacts()

        // ② 输入 AAA → Ctrl+S ⇒ payload#1 = `基线\nAAA`，note 与 lastSentRef 都到它
        window.__zjHarness?.type('AAA')
        await wait(50)
        flushNowViaCtrlS()
        await wait(150)
        const payload1 = findEditorView()?.state.doc.toString() ?? ''
        const afterFirstSave = raceFactsWithDraft()

        // ③ 输入 BBB → Ctrl+S ⇒ payload#2 = `基线\nAAABBB`
        //    ⚠️ 关键：note 与 lastSentRef 都前进到 payload#2，payload#1 才成为"过期回包"
        window.__zjHarness?.type('BBB')
        await wait(50)
        flushNowViaCtrlS()
        await wait(150)
        const afterSecondSave = raceFactsWithDraft()

        // ④ 继续输入 CCC（草稿领先，未经 Ctrl+S 不会落库）
        window.__zjHarness?.type('CCC')
        await wait(60)
        const beforeStale = raceFactsWithDraft()

        // ⑤ 「较旧的那次写入」最后回包：note.content 从 payload#2 退回 payload#1 —— 这是一次**真实**的回退
        //    真实链条：两次 notesStore.update 在飞、第一次后 resolve（写盘 + 索引重建耗时不定）
        window.__zjHarness?.setNoteContent('note-a', payload1)
        await wait(200)
        const afterStale = raceFactsWithDraft()
        setRaceMode(false)

        return {
          base,
          payload1,
          afterFirstSave,
          afterSecondSave,
          beforeStale,
          afterStale,
          /** 判据 1：最新输入是否还在编辑器里 */
          keepsLatest: (afterStale.doc ?? '').includes('BBB') && (afterStale.doc ?? '').includes('CCC'),
          /** 判据 2：光标是否被重置 */
          cursorPreserved: afterStale.anchor === beforeStale.anchor,
          /** 判据 3：正文是否被回退到旧 payload */
          docReverted: (afterStale.doc ?? '') === payload1,
          /** 判据 4：内部草稿（字数徽标可观测）是否也被回退 —— 用于区分"没 adopt"与"adopt 了但没写进 CM" */
          draftRevertedDelta:
            afterStale.draftWords !== beforeStale.draftWords || null,
        }
      },
      runCompositionClobber: async () => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        setSelectedId('note-a')
        setMode('edit')
        await wait(120)
        const view = findEditorView()
        if (!view) return { error: 'no view' }
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '甲\n' } })
        await wait(80)
        view.focus()

        view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        await wait(40)
        const duringStart = {
          ...raceFacts(),
          /** ⚠️ 关键：此时 composing 仍为 false，只有 compositionStarted 为 true */
          composingProp: view.composing,
          compositionStarted: view.compositionStarted,
        }
        // 外部回写（另一处改了这篇笔记 / 乱序回包）
        window.__zjHarness?.setNoteContent('note-a', '外部改过的内容\n')
        await wait(150)
        const afterExternal = raceFacts()
        view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        await wait(80)
        return {
          duringStart,
          afterExternal,
          /** 组合中未被整篇替换 ⇒ 不会出现"拼音与汉字同入" */
          survivedComposition: (afterExternal.doc ?? '').includes('甲'),
        }
      },
      runSelfTest: async () => {
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
        const marker = `@@串写标记${Date.now()}@@`
        const steps: string[] = []

        setCallbackMode('captured')
        setMode('split')
        setSelectedId('note-a')
        await wait(60)
        const beforeA = findEditorView()?.state.doc.toString() ?? ''
        steps.push(`A 初始长度=${beforeA.length}`)

        findEditorView()?.dispatch({
          changes: { from: 0, to: beforeA.length, insert: '# A 草稿\n\n' },
        })
        await wait(30)
        window.__zjHarness?.type(`${marker}\n`)
        steps.push('已向 A 注入标记，并在防抖窗口内切到 B')

        // 关键：防抖计时器（500ms）尚未到点就切笔记
        setSelectedId('note-b')
        await wait(900)

        const after = (window.__zjHarness?.state() as { notes: Record<string, { content: string }> })
          .notes
        const aHas = after['note-a'].content.includes(marker)
        const bHas = after['note-b'].content.includes(marker)
        steps.push(`A 含标记=${aHas} · B 含标记=${bHas}`)

        return {
          pass: aHas && !bHas,
          marker,
          steps,
          notes: after,
          preview: previewFacts(),
        }
      },
    }),
    [selectedId, mode, callbackMode, themeId, themeMode, notes, log],
  )

  window.__zjHarness = api

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-meta">
        <span className="font-medium">编辑器自检页</span>
        <span className="text-muted">（不参与生产构建）</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-h="select-a"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => setSelectedId('note-a')}
          >
            选 A
          </button>
          <button
            type="button"
            data-h="select-b"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => setSelectedId('note-b')}
          >
            选 B
          </button>
          <button
            type="button"
            data-h="select-none"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => setSelectedId(null)}
          >
            取消选择
          </button>
          <button
            type="button"
            data-h="toggle-mode"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => setMode(themeMode === 'dark' ? 'split' : 'preview')}
          >
            切视图
          </button>
          <button
            type="button"
            data-h="toggle-theme"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => {
              const store = useThemeStore.getState()
              store.setMode(store.mode === 'dark' ? 'light' : 'dark')
            }}
          >
            明暗切换
          </button>
          <button
            type="button"
            data-h="callback-mode"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() =>
              setCallbackMode((prev) => {
                const index = CALLBACK_MODES.indexOf(prev)
                return CALLBACK_MODES[(index + 1) % CALLBACK_MODES.length] ?? 'captured'
              })
            }
          >
            回调：{callbackMode}
          </button>
          <button
            type="button"
            data-h="tag-edit-mode"
            className="rounded-zj-sm border border-border px-2 py-0.5 text-meta hover:bg-hover"
            onClick={() => setTagEditMode((prev) => (prev === 'spy' ? 'store' : 'spy'))}
          >
            标签写入：{tagEditMode}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <EditorPane
          note={renderedNote}
          mode={mode}
          dirty={dirty}
          onModeChange={setMode}
          onTitleChange={handleTitleChange}
          onContentChange={handleContentChange}
          onSave={() => {
            clearDirty()
            push('onSave()')
          }}
          onExport={(format) => push(`onExport(${format})`)}
          onCreateNote={() => push('onCreateNote()')}
          showLineNumbers={false}
          autoSaveDelayMs={raceMode ? 60_000 : undefined}
          allTags={TAG_CATALOG}
          onEditTags={tagEditMode === 'spy' ? handleEditTags : undefined}
        />
      </main>

      <footer
        data-h="log"
        className="flex h-24 shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-border bg-surface px-3 py-1 font-mono text-2xs text-muted"
      >
        {log.length === 0 ? <span>（操作日志）</span> : null}
        {log.map((entry, index) => (
          <span key={`${entry.at}-${index}`}>
            {new Date(entry.at).toLocaleTimeString()} {entry.text}
          </span>
        ))}
      </footer>
    </div>
  )
}

/** 从 DOM 找回 CodeMirror 视图（集成代码不需要这么做，仅自检用） */
function findEditorView(): EditorView | null {
  const host = document.querySelector<HTMLElement>('[data-zj-editor-host]')
  if (!host) return null
  return EditorView.findFromDOM(host)
}

/**
 * 编辑器即时事实（t32 竞态复现用）：
 * doc / 选区 / 焦点 / 组合状态 —— 「输入被打断」就是这三项里某几项被冲掉。
 */
function raceFacts() {
  const view = findEditorView()
  if (!view) return { doc: null, anchor: null, head: null, focused: false, composing: false }
  const { state } = view
  const main = state.selection.main
  return {
    doc: state.doc.toString(),
    anchor: main.anchor,
    head: main.head,
    /** 选区是否还在文档末尾附近（光标跳回首行的判据之一） */
    atEnd: main.head >= state.doc.length - 1,
    focused: view.hasFocus,
    composing: view.compositionStarted,
  }
}

/** 编辑器即时事实 + 内部草稿的可观测代理（字数徽标由 draft.content 计算） */
function raceFactsWithDraft() {
  return {
    ...raceFacts(),
    draftWords: document.querySelector('[data-zj-word-count]')?.textContent ?? null,
    saveStatus: document.querySelector('[data-zj-save-status]')?.getAttribute('data-zj-save-status') ?? null,
    noteContent: (window.__zjHarness?.state() as { notes: Record<string, { content: string }> })
      ?.notes?.['note-a']?.content,
  }
}

/** 触发立即保存：走真实的 Ctrl/Cmd+S 键路（CodeMirror keymap → onSaveRequest → flush） */
function flushNowViaCtrlS(): boolean {
  const view = findEditorView()
  if (!view) return false
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
  )
  return true
}

/** 真实 DOM 点击（自检用） */
function clickDom(selector: string): boolean {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return false
  element.click()
  return true
}

/** t23：标签入口的全部可观测事实 */
function tagFacts() {
  const button = document.querySelector<HTMLElement>('[data-zj-tag-button]')
  const dialog = document.querySelector('[role="dialog"]')
  const picker = document.querySelector('[data-zj-tag-picker]')
  const options = Array.from(document.querySelectorAll<HTMLElement>('[data-zj-tag-option]'))
  const createRow = document.querySelector<HTMLElement>('[data-zj-tag-create]')
  const dot = options[0]?.querySelector<HTMLElement>('span[aria-hidden]') ?? null
  return {
    button: button
      ? {
          text: (button.textContent ?? '').trim(),
          count: button.getAttribute('data-zj-tag-count'),
          expanded: button.getAttribute('aria-expanded'),
          overflow: document.querySelector('[data-zj-tag-overflow]')?.textContent ?? null,
          label: button.getAttribute('aria-label'),
        }
      : null,
    dialogOpen: !!dialog,
    dialogTitle: dialog?.querySelector('h2')?.textContent ?? null,
    pickerVisible: !!picker,
    options: options.map((option) => ({
      name: option.getAttribute('data-zj-tag-option'),
      checked: option.getAttribute('aria-checked'),
      role: option.getAttribute('role'),
    })),
    createRow: createRow ? (createRow.textContent ?? '').trim() : null,
    firstDotBackground: dot ? getComputedStyle(dot).backgroundColor : null,
    notice: document.querySelector('[data-zj-tag-picker] p[aria-live]')?.textContent ?? null,
    emptyState: !!document.querySelector('[data-empty-state]'),
    status: document.querySelector('[data-zj-tag-status]')?.getAttribute('data-zj-tag-status') ?? null,
  }
}

interface LiveLineFacts {
  /** DOM 里实际显示的文本（隐藏的标记不会出现） */
  text: string
  /** 行级 live preview 类名 */
  lineClasses: string[]
  bullet: boolean
  number: boolean
  checkbox: string | null
  rule: boolean
  strong: boolean
  em: boolean
  strike: boolean
  code: boolean
  link: boolean
  url: string | null
  isCursorLine: boolean
}

/** Live Preview 的 DOM 事实：逐行报告「隐藏了哪些标记 / 渲染成了什么」 */
function livePreviewFacts() {
  const view = findEditorView()
  const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
  const cursorLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number : -1
  const facts: LiveLineFacts[] = lines.map((element, index) => ({
    text: element.textContent ?? '',
    lineClasses: Array.from(element.classList).filter((name) => name.startsWith('zj-lp-')),
    bullet: !!element.querySelector('.zj-lp-bullet'),
    number: !!element.querySelector('.zj-lp-number'),
    checkbox: element.querySelector<HTMLElement>('.zj-lp-checkbox')?.dataset['checked'] ?? null,
    rule: !!element.querySelector('.zj-lp-hr'),
    strong: !!element.querySelector('.zj-lp-strong'),
    em: !!element.querySelector('.zj-lp-em'),
    strike: !!element.querySelector('.zj-lp-strike'),
    code: !!element.querySelector('.zj-lp-code'),
    link: !!element.querySelector('.zj-lp-link'),
    url: element.querySelector('.zj-lp-url')?.textContent ?? null,
    isCursorLine: index + 1 === cursorLine,
  }))
  return {
    composing: view?.compositionStarted ?? null,
    cursorLine,
    /** 有任意 zj-lp-* 装饰的行数 */
    decoratedLines: facts.filter(
      (line) => line.lineClasses.length > 0 || line.bullet || line.number || line.checkbox || line.rule,
    ).length,
    lines: facts,
  }
}

/** 工具栏 DOM 事实：按钮集合 + 激活态 + 禁用态 */
function toolbarFacts() {
  const toolbar = document.querySelector('[data-zj-toolbar]')
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-zj-toolbar-command]'),
  )
  return {
    exists: !!toolbar,
    role: toolbar?.getAttribute('role') ?? null,
    ariaLabel: toolbar?.getAttribute('aria-label') ?? null,
    commands: buttons.map((button) => button.getAttribute('data-zj-toolbar-command')),
    pressed: buttons
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.getAttribute('data-zj-toolbar-command')),
    disabled: buttons
      .filter((button) => button.disabled)
      .map((button) => button.getAttribute('data-zj-toolbar-command')),
    /** 激活态按钮的背景色（应当来自 --zj-selection，而不是硬编码色值） */
    pressedBg: (() => {
      const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true')
      return pressed ? getComputedStyle(pressed).backgroundColor : null
    })(),
  }
}

/** 预览区 DOM 事实：GFM 表格 / 任务列表 / Shiki 高亮 / 编辑器语法标记 */
function previewFacts() {
  const preview = document.querySelector('[data-zj-preview]')
  const shikiPre = preview?.querySelector('.zj-code-block .shiki')
  const codeSpans = shikiPre?.querySelectorAll('span[style*="--shiki-"]').length ?? 0
  const darkVars = shikiPre?.querySelectorAll('span[style*="--shiki-dark"]').length ?? 0
  const tokenColor = codeSpans > 0 ? getComputedStyle(shikiPre!.querySelector('span')!).color : null
  const boxes = Array.from(preview?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])
  return {
    tables: preview?.querySelectorAll('table').length ?? 0,
    tableHeaderCells: preview?.querySelectorAll('thead th').length ?? 0,
    taskItems: preview?.querySelectorAll('li.task-list-item').length ?? 0,
    checkboxes: boxes.length,
    checkedBoxes: boxes.filter((box) => box.checked).length,
    codeBlocks: preview?.querySelectorAll('[data-zj-code-block]').length ?? 0,
    highlightedBlocks: preview?.querySelectorAll('.zj-code-block .shiki').length ?? 0,
    codeSpans,
    darkVars,
    tokenColor,
    shikiHtml: shikiPre?.outerHTML.slice(0, 160) ?? null,
    markClasses: {
      heading: document.querySelectorAll('.cm-content .zj-md-heading').length,
      headingMark: document.querySelectorAll('.cm-content .zj-md-heading-mark').length,
      strong: document.querySelectorAll('.cm-content .zj-md-strong').length,
      em: document.querySelectorAll('.cm-content .zj-md-em').length,
      strike: document.querySelectorAll('.cm-content .zj-md-strike').length,
      inlineCode: document.querySelectorAll('.cm-content .zj-md-inline-code').length,
      link: document.querySelectorAll('.cm-content .zj-md-link').length,
      listMark: document.querySelectorAll('.cm-content .zj-md-list-mark').length,
      quote: document.querySelectorAll('.cm-content .zj-md-quote').length,
      task: document.querySelectorAll('.cm-content .zj-md-task').length,
      tableCell: document.querySelectorAll('.cm-content .zj-md-table-cell').length,
    },
    editorTextColor: (() => {
      const content = document.querySelector('.cm-content')
      return content ? getComputedStyle(content).color : null
    })(),
    shikiBg: shikiPre ? getComputedStyle(shikiPre.parentElement ?? shikiPre).backgroundColor : null,
  }
}

const container = document.getElementById('root')
if (container) {
  // HMR 会重复执行本模块：复用同一个 root，避免 React 报
  // "createRoot() on a container that has already been passed to createRoot()" ——
  // 这个报错会污染自检页的控制台取证。
  const scope = window as unknown as { __zjHarnessRoot?: Root }
  const root = scope.__zjHarnessRoot ?? createRoot(container)
  scope.__zjHarnessRoot = root
  root.render(<Harness />)
}
