/**
 * QuickNoteApp —— 快速笔记捕捉框（t44）。
 * 归属：编辑器成员。
 *
 * ## 需求（用户原话）
 * 「通过快捷键立马打开一个单独的记录框界面而不是整个程序界面，可以快速建立一个笔记。」
 * ⇒ 一个 460×264 的小窗、一个输入框、Enter 即成一条笔记，**不惊动主窗口**。
 *
 * ## 设计取舍
 *  1. **用原生 `Textarea` 而不是 `CodeMirrorEditor`**：捕捉框要的是"打开就能打字"，
 *     多一个编辑器实例就多一层初始化/IME/主题耦合；而 Markdown 在纸笺里本来就是
 *     纯文本，Textarea 里敲的 `# 标题` 一样会被主编辑器正常渲染。
 *  2. **Enter 保存**，Shift+Enter 换行。⚠️ 但**中文输入法里 Enter 是用来确认候选词的** ——
 *     因此必须判 `isComposing`（及组合期标志），否则用户选词就把笔记保存并关窗了，
 *     这是本项目在 t16/t32 栽过的一类缺陷（输入被打断）。
 *  3. **保存走 `createNoteFromInput`**（store 的既有公开入口），不自己碰仓储：
 *     它内部会 `initDb()`、落库、并把新笔记并入当前集合；失败会进 `error` 并向上抛，
 *     这里据此展示「保存失败」而不是假装成功。
 *  4. 空内容按 Enter **不建空笔记**（避免用户误触产生一堆 `无标题`），只提示。
 *  5. 保存成功后**关闭窗口**（捕捉框的使命结束）；跨窗口同步由 store 的广播负责 ——
 *     主窗口若没聚焦会自动刷新并看到这条新笔记（见 store/notes.ts 的 t44 说明）。
 *
 * 可注入 I/O（`saveNote` / `onRequestClose`）供自检在无 DB、无 Tauri 环境下驱动全流程。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Loader, X } from 'lucide-react'
import { Button, IconButton, Input, Textarea } from '@/components/ui'
import { isTauri } from '@/lib/tauri'
import { errorMessage } from '@/lib/utils'
import { createNoteFromInput } from '@/store/notes'
import { quickNoteKeyAction } from './quickNoteKeys'
import {
  QUICK_NOTE_EMPTY_HINT,
  QUICK_NOTE_HINT,
  QUICK_NOTE_PLACEHOLDER,
  QUICK_NOTE_SAVE_ERROR_TITLE,
  QUICK_NOTE_TITLE_PLACEHOLDER,
  titleFromQuickContent,
} from './quickNoteUrl'

/** 非 Tauri 环境下的统一可读错误（与磁贴/主窗口保持同一口径） */
const NO_DB_MESSAGE = '数据库不可用：当前不在 Tauri 运行环境（请使用 pnpm tauri:dev 启动）'

/**
 * 默认保存：走 store 的公开入口，把 store 吞掉的错误还原成异常以便如实展示
 *
 * t46：**标题与正文分开**（用户要求「应该能输入标题和正文」）。标题留空时仍按
 * 「首个非空行」推断 —— 保留了"只想快速记一句、不想起标题"的用法（旧行为不丢）。
 */
export async function defaultSaveQuickNote(content: string, title: string): Promise<void> {
  if (!isTauri) throw new Error(NO_DB_MESSAGE)
  await createNoteFromInput({
    // 快速笔记不选文件夹：放进「未归类」，用户之后可在主窗口整理
    folderId: null,
    title: title.trim() || titleFromQuickContent(content),
    content,
  })
}

/**
 * 默认关闭：无边框小窗直接 `close()`。
 * 与磁贴同样需要 `core:window:allow-close`（`core:default` 只含窗口**只读**操作）；
 * 缺授权时表现为"点了没反应"，这里 warn 便于定位，但不向用户抛异常。
 */
function defaultCloseQuickNote(): void {
  if (!isTauri) return
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch((error: unknown) => {
      console.warn(
        '[纸笺] 关闭快速笔记失败（检查 capabilities/quick-note.json 是否含 core:window:allow-close）：',
        error,
      )
    })
}

export interface QuickNoteAppProps {
  /** 保存为新笔记（默认 `createNoteFromInput`）；自检注入探针 */
  saveNote?: (content: string, title: string) => Promise<void>
  /** 关闭窗口（默认 `getCurrentWindow().close()`）；自检注入探针 */
  onRequestClose?: () => void
}

export function QuickNoteApp({ saveNote, onRequestClose }: QuickNoteAppProps = {}) {
  const save = saveNote ?? defaultSaveQuickNote
  const closeWindow = onRequestClose ?? defaultCloseQuickNote

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** 组合输入中（IME）：Enter 属于"确认候选词"，绝不能当成保存 */
  const composingRef = useRef(false)
  /** 防重入：Enter 与按钮/双击在同一瞬间不会发起两次保存 */
  const savingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 打开即可打字：小窗的唯一目的就是捕捉，让用户再点一下输入框是没必要的摩擦。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSave = useCallback(async () => {
    if (savingRef.current) return
    const text = content.trim()
    if (!text) {
      // 空内容不建笔记（否则误触会攒出一堆「无标题」），给出可读提示即可
      setError(QUICK_NOTE_EMPTY_HINT)
      inputRef.current?.focus()
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await save(text, title)
      closeWindow()
    } catch (caught: unknown) {
      setError(`${QUICK_NOTE_SAVE_ERROR_TITLE}：${errorMessage(caught)}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [closeWindow, content, save, title])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // 判定本身是纯函数（`quickNoteKeys.ts`），这里只负责把副作用接上去。
      // ⚠️ 组合态取「原生 isComposing」与「自己的组合标志」的**或**：中文输入法里
      //    Enter 用于确认候选词，判错就是"选个词就把笔记存了并关窗"（t16/t32 同类缺陷）。
      const action = quickNoteKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        composing: composingRef.current || event.nativeEvent.isComposing,
      })
      if (action === 'none') return
      event.preventDefault()
      if (action === 'save') {
        void handleSave()
        return
      }
      // Escape：关闭 = 放弃这次捕捉（内容不落库）。底部提示里已写明，避免误以为会自动保存。
      closeWindow()
    },
    [closeWindow, handleSave],
  )

  /**
   * t46：标题框里的按键。
   * 标题是单行输入框，所以 `Enter` **不该**直接保存（用户刚填完标题，还想写正文），
   * 而是把光标送进正文框 —— 符合"从上往下填"的顺序。
   * `Escape` 仍然是放弃；输入法组合态同样优先（否则选词就把窗口关了）。
   */
  const handleTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (composingRef.current || event.nativeEvent.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeWindow()
      }
    },
    [closeWindow],
  )

  return (
    <div
      data-zj-quick-note=""
      className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text"
    >
      {/* 拖拽区：deep = 子树内任意位置可拖，按钮自动让路（与磁贴同一约定） */}
      <header
        data-tauri-drag-region="deep"
        className="flex h-8 shrink-0 select-none items-center gap-2 border-b border-border bg-surface-2 pl-2 pr-1"
      >
        <span className="min-w-0 flex-1 truncate text-2xs text-muted">快速笔记</span>
        <Button
          size="sm"
          variant="secondary"
          data-zj-quick-note-save=""
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <IconButton
          icon={X}
          label="关闭（不保存）"
          tooltip
          size="icon-sm"
          data-zj-quick-note-close=""
          onClick={closeWindow}
        />
      </header>

      {/* t46：标题（可留空 —— 留空时按正文首个非空行推断，见 defaultSaveQuickNote） */}
      <Input
        bare
        inputSize="sm"
        value={title}
        data-zj-quick-note-title=""
        placeholder={QUICK_NOTE_TITLE_PLACEHOLDER}
        aria-label="快速笔记标题"
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={handleTitleKeyDown}
        className="h-8 shrink-0 border-b border-border px-3 text-body font-medium"
      />

      <Textarea
        ref={inputRef}
        bare
        rows={1}
        value={content}
        data-zj-quick-note-input=""
        placeholder={QUICK_NOTE_PLACEHOLDER}
        aria-label="快速笔记内容"
        disabled={saving}
        // 组合期必须记下来：`keydown` 上的 `isComposing` 在部分输入法下并不可靠
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 resize-none px-3 py-2 text-body leading-relaxed"
      />

      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
        {error ? (
          <span
            data-zj-quick-note-error=""
            title={error}
            className="min-w-0 flex-1 truncate text-2xs text-accent"
          >
            {error}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-2xs text-muted">{QUICK_NOTE_HINT}</span>
        )}
        {saving ? <Loader size={13} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden /> : null}
      </footer>
    </div>
  )
}

export default QuickNoteApp
