/**
 * CodeMirrorEditor —— CodeMirror 6 的 Markdown 编辑器封装。
 * 归属：编辑器成员（任务 t4）。
 *
 * 契约要点：
 *  1. **不串写**：`noteId` 变化 = 换文档。视图在 noteId 变化时被销毁重建
 *     （历史记录随之清空），绝不会把上一篇的正文留给下一篇；EditorPane 另外还会
 *     给它加 `key={note.id}` 做双保险。
 *  2. **主题跟随 token**：浅深与 5 套主题都只改 <html> 上的属性，编辑器样式全部
 *     用 var(--zj-*) 表达，切主题不重建 EditorView、不重渲染。
 *  3. **自动保存由上层编排**：本组件只把「内容变化」回调出去（含 Ctrl/Cmd+S 的立即保存
 *     请求），防抖落库由 useAutoSave / EditorPane 负责。
 */

import { useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { Ref } from 'react'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { indentUnit } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import type { KeyBinding } from '@codemirror/view'
import { cn } from '@/lib/utils'
import { editorTheme } from './editorTheme'
import { livePreview } from './livePreview'
import { markdownCommandSpec } from './markdownCommands'
import type { MarkdownCommandId } from './markdownCommands'
import { markdownHighlight } from './markdownHighlight'

/** 命令式句柄：给自检脚本、以及「选中笔记后聚焦编辑器」这类集成需求用 */
export interface CodeMirrorEditorHandle {
  /** 底层 EditorView（未挂载时为 null） */
  getView: () => EditorView | null
  focus: () => void
  /** 整篇替换（进入撤销历史） */
  setContent: (text: string) => void
  /** 在光标处插入文本 */
  insertAtCursor: (text: string) => void
}

export interface CodeMirrorEditorProps {
  /** 文档作用域（笔记 id）：变化即重建文档 */
  noteId: string
  value: string
  onChange: (value: string) => void
  /** Ctrl/Cmd+S：请求立即落库 */
  onSaveRequest: () => void
  ref?: Ref<CodeMirrorEditorHandle>
  /** 行号（docs/DESIGN.md §5 默认不显示，这里可选打开） */
  showLineNumbers?: boolean
  readOnly?: boolean
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /**
   * 视图就绪 / 销毁（工具栏需要 EditorView 才能派发格式化命令）。
   * 销毁时回调 null，调用方记得清理自己的引用。
   */
  onViewReady?: (view: EditorView | null) => void
  /**
   * 视图每次更新（含选区/文档变化）—— 工具栏据此刷新按钮激活态。
   * 注意：这是**每次 CM 更新**都会调用，调用方自己要做廉价比较，避免多余渲染。
   */
  onViewUpdate?: (view: EditorView) => void
}

/* --------------------------- Markdown 编辑命令 --------------------------- */

/**
 * Markdown 编辑命令（t16 起改为共享 markdownCommands.ts 的纯函数实现，
 * 快捷键与工具栏按钮走同一批命令，行为不会漂移）。
 */
function runCommand(id: MarkdownCommandId): (view: EditorView) => boolean {
  return (view) => {
    view.dispatch(markdownCommandSpec(view.state, id))
    return true
  }
}

/** 插入链接：`[文字](url)`，插入后选中 url 便于直接替换 */
function runLink(view: EditorView): boolean {
  view.dispatch(markdownCommandSpec(view.state, 'link'))
  view.focus()
  return true
}

function markdownEditKeymap(onSave: () => void): KeyBinding[] {
  return [
    { key: 'Mod-b', preventDefault: true, run: runCommand('bold') },
    { key: 'Mod-i', preventDefault: true, run: runCommand('italic') },
    { key: 'Mod-Shift-x', preventDefault: true, run: runCommand('strikethrough') },
    { key: 'Mod-k', preventDefault: true, run: runLink },
    { key: 'Tab', preventDefault: true, run: indentMore },
    { key: 'Shift-Tab', preventDefault: true, run: indentLess },
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave()
        return true
      },
    },
  ]
}

/* ------------------------------- 组件 ------------------------------- */

export function CodeMirrorEditor({
  noteId,
  value,
  onChange,
  onSaveRequest,
  ref,
  showLineNumbers = false,
  readOnly = false,
  placeholder = '开始写点什么…',
  autoFocus = false,
  className,
  onViewReady,
  onViewUpdate,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  // 回调放进 ref：EditorView 的监听器只创建一次，必须永远调用最新的回调
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSaveRequest)
  const onViewReadyRef = useRef(onViewReady)
  const onViewUpdateRef = useRef(onViewUpdate)
  const valueRef = useRef(value)
  /**
   * 最近一次**由本编辑器自身产生**的文档内容，用于区分「自己在输入」与「外部改写」。
   *
   * 为什么必须有它：`value` 来自异步 store（自动保存有防抖、update 还要 await 落库），
   * 输入过程中它是**过期值**。若不加区分地回写，就会反复用旧内容覆盖编辑器 ——
   * 表现为中文输入法的拼音与汉字一起落进正文、以及回车后光标跳回行首（用户实测 Bug 1）。
   */
  const lastEmittedRef = useRef(value)
  useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onSaveRequest
    onViewReadyRef.current = onViewReady
    onViewUpdateRef.current = onViewUpdate
    valueRef.current = value
  })

  const lineNumberCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])

  const gutterExtension = useMemo(
    () => (showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
    [showLineNumbers],
  )

  useImperativeHandle(
    ref,
    () => ({
      getView: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      setContent: (text: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
        })
      },
      insertAtCursor: (text: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      },
    }),
    [],
  )

  /* 视图生命周期：只在 noteId 变化时重建（换笔记 = 换文档，历史与状态一起重置） */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const extensions: Extension[] = [
      lineNumberCompartment.of(gutterExtension),
      readOnlyCompartment.of(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      // markdown() 自带 markdownKeymap（Prec.high）：Enter 续写列表/引用、Backspace 删标记。
      // base 必须显式给 markdownLanguage（GFM）：默认的 commonmarkLanguage 不含
      // 表格 / 任务列表 / 删除线，编辑器里这些块就没有语法标记。
      markdown({ base: markdownLanguage }),
      markdownHighlight(),
      // Live Preview（所见即所得）：只加装饰、不改文档；光标行显示源码；IME 组合期不隐藏标记
      livePreview(),
      editorTheme(),
      EditorView.contentAttributes.of({
        'aria-label': '笔记正文',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocorrect: 'off',
      }),
      EditorView.editorAttributes.of({ 'data-zj-editor': 'markdown' }),
      keymap.of([...markdownEditKeymap(() => onSaveRef.current()), ...defaultKeymap, ...historyKeymap]),
      placeholderExtension(placeholder),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString()
          valueRef.current = text
          // 记下「这是编辑器自己产生的内容」，供下方「外部内容同步」判断是否为外部改写
          lastEmittedRef.current = text
          onChangeRef.current(text)
        }
        // 工具栏激活态需要感知选区/光标变化，因此所有更新都要上报
        onViewUpdateRef.current?.(update.view)
      }),
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: valueRef.current, extensions }),
      parent: host,
    })
    viewRef.current = view
    onViewReadyRef.current?.(view)
    if (autoFocus) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
      onViewReadyRef.current?.(null)
    }
    // 只依赖 noteId：其余扩展通过 Compartment 重建/重配，切主题不重建视图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  /* 行号开关（Compartment 重配，不重建视图、不丢历史） */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: lineNumberCompartment.reconfigure(gutterExtension) })
  }, [gutterExtension, lineNumberCompartment])

  /* 只读开关 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    })
  }, [readOnly, readOnlyCompartment])

  /* 外部内容同步（例：切换笔记后的载入、同一篇笔记被别处改写）
     ⚠️ 守卫缺一不可，否则会打断正常输入（用户实测：「拼音与汉字同入」「光标跳回首行」）。
     t32 补齐了后两道 —— 原实现只看 `composing`（组合**首次变更之后**才为 true），
     且无条件把整篇换掉并把光标夹回开头：
       1. `value === lastEmittedRef.current` ⇒ 这次变化正是本编辑器产生的（异步 store 回传），
          回写等于用旧内容覆盖自己 → 跳过；
       2. **只要与当前 doc 相同**就没必要动（避免无意义 dispatch 引发选区抖动）；
       3. **组合中一律不动**：用 `compositionStarted`（compositionstart 起即为 true）
          而不是 `composing`（要等首次变更）—— 覆盖「组合已开始但还没落字」的窗口，
          这正是"拼音和汉字同时入文"的入口；
       4. **有焦点（用户正在这篇编辑器里打字）时不做整篇替换**：输入永远优先。
          真正需要换文档的场景是「换笔记」（由 noteId 重建视图兜住），
          以及"没聚焦时的外部改写"（此时替换不会打断任何人）；
       5. 真要替换时，把选区**按位置映射**而不是夹到开头 —— `Math.min(anchor, len)` 在正文
          变短时会把光标一路拉到行首，正是"光标跳回首行"的最后一环。 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value === lastEmittedRef.current) return
    if (view.compositionStarted) return
    const current = view.state.doc.toString()
    if (current === value) {
      lastEmittedRef.current = value
      return
    }
    if (view.hasFocus) {
      // 用户正在这篇编辑器里打字：**不打断**（详见上面的注释 4）。
      // 需要换文档的场景是「换笔记」——那由 noteId 重建视图负责，不走这里。
      if (import.meta.env.DEV) {
        console.warn('[纸笺] 收到与当前编辑内容不一致的 value，但编辑器有焦点，已忽略以避免打断输入')
      }
      return
    }
    const anchor = Math.min(view.state.selection.main.anchor, value.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor },
    })
    lastEmittedRef.current = value
  }, [value])

  return (
    <div
      ref={hostRef}
      data-zj-editor-host={noteId}
      className={cn(
        'zj-selectable h-full min-h-0 overflow-hidden bg-bg font-mono text-editor text-text',
        className,
      )}
    />
  )
}
