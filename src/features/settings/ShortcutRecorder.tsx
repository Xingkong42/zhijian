/**
 * ShortcutRecorder —— 全局快捷键录入控件（任务 t17）。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * 交互（无需拖拽/弹窗，直接内联录入）：
 *  1. 点击「录入」进入录制态（按钮变强调色，提示「请按下组合键」）；
 *  2. 在录制态按下组合键 → 立即校验：**空组合 / 只有修饰键 / 非法键**一律拒绝并给出原因；
 *  3. `Esc` 取消录制、`Backspace/Delete` 在可清空的动作上清空绑定；
 *  4. 与其它动作重复（应用内冲突）或已被其它程序占用（系统冲突）→ 拒绝并说明。
 *
 * 无障碍：控件是 `button`，`aria-live` 播报当前状态，键盘全程可达。
 */

import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, Check, Keyboard, X } from 'lucide-react'
import { Button, Kbd } from '@/components/ui'
import { cn } from '@/lib/utils'
import { acceleratorFromEvent, formatAccelerator } from './shortcuts'

export interface ShortcutRecorderProps {
  /** 动作名（展示用） */
  label: string
  actionId: string
  /** 当前生效键位（未生效为 null） */
  accelerator: string | null
  /** 该动作是否已启用（未启用时显示「未绑定」态） */
  enabled: boolean
  /** 是否可清空绑定（如「新建笔记」不允许留空） */
  clearable: boolean
  disabled?: boolean
  /** 与其它动作冲突时的说明（nil = 无冲突） */
  conflictLabel?: string | null
  /** 被其它程序占用导致未生效的说明（nil = 无） */
  systemConflictReason?: string | null
  /** 后端未就绪等全局说明 */
  unavailableReason?: string | null
  /** 键位变更（已通过录入期校验；`null` = 清空） */
  onChange: (accelerator: string | null) => void
}

export function ShortcutRecorder({
  label,
  accelerator,
  enabled,
  clearable,
  disabled = false,
  conflictLabel = null,
  systemConflictReason = null,
  unavailableReason = null,
  onChange,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  // 退出录制态时清掉临时提示
  useEffect(() => {
    if (!recording) setHint(null)
  }, [recording])

  const commit = useCallback(
    (value: string | null) => {
      onChange(value)
      setRecording(false)
    },
    [onChange],
  )

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      // 清空绑定：仅允许可清空的动作，且需要真的按到 Backspace/Delete
      if ((event.key === 'Backspace' || event.key === 'Delete') && clearable) {
        commit(null)
        return
      }
      const candidate = acceleratorFromEvent(event)
      if (!candidate) {
        // 还在按修饰键（或不可识别的键）：留在录制态继续等待
        setHint('继续按住修饰键，再按一个主键（例如 N / K / F5）')
        return
      }
      const formatted = formatAccelerator(candidate)
      if (!formatted) {
        setHint('这个组合无法识别，请换一个')
        return
      }
      // 应用内冲突：**在录制态就拒绝**，不提交（组件级即时反馈，父级还会再校验一次）
      if (conflictLabel) {
        setHint(`该组合已被「${conflictLabel}」占用，请换一个`)
        return
      }
      commit(formatted)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, clearable, commit, conflictLabel])

  const shown = accelerator ? formatAccelerator(accelerator) ?? accelerator : null
  const pending = Boolean(unavailableReason)

  return (
    <div className="flex items-center gap-2">
      {recording ? (
        <span
          className={cn(
            'inline-flex h-7 min-w-40 items-center gap-1 rounded-zj-sm border border-accent bg-selection px-2',
            'text-meta text-text',
          )}
          aria-live="polite"
        >
          <Keyboard size={15} strokeWidth={1.75} aria-hidden />
          请按下组合键…
        </span>
      ) : shown && enabled ? (
        <span className="inline-flex items-center gap-1" title={shown}>
          {shown.split('+').map((part) => (
            <Kbd key={part}>{part}</Kbd>
          ))}
        </span>
      ) : (
        <span className="inline-flex h-7 min-w-40 items-center rounded-zj-sm border border-dashed border-border px-2 text-meta text-muted">
          未绑定
        </span>
      )}

      <span className="min-w-0 flex-1" aria-live="polite">
        {recording && hint ? (
          <span className="text-meta text-muted">{hint}</span>
        ) : systemConflictReason ? (
          <span className="inline-flex items-center gap-1 text-meta text-text">
            <CircleAlert size={15} strokeWidth={1.75} aria-hidden className="text-accent" />
            {systemConflictReason}
          </span>
        ) : conflictLabel ? (
          <span className="inline-flex items-center gap-1 text-meta text-text">
            <CircleAlert size={15} strokeWidth={1.75} aria-hidden className="text-accent" />
            与「{conflictLabel}」重复，请换一个
          </span>
        ) : pending ? (
          <span className="text-meta text-muted">{unavailableReason}</span>
        ) : enabled ? (
          <span className="inline-flex items-center gap-1 text-meta text-muted">
            <Check size={15} strokeWidth={1.75} aria-hidden />
            实际生效
          </span>
        ) : (
          <span className="text-meta text-muted">已关闭（不注册）</span>
        )}
      </span>

      <Button
        variant={recording ? 'default' : 'subtle'}
        size="sm"
        disabled={disabled}
        aria-label={`${recording ? '取消录入' : '录入'}「${label}」快捷键`}
        onClick={() => setRecording((value) => !value)}
      >
        {recording ? '取消' : '录入'}
      </Button>
      {clearable && shown ? (
        <Button
          variant="subtle"
          size="sm"
          icon={X}
          disabled={disabled || recording}
          aria-label={`清空「${label}」快捷键`}
          onClick={() => commit(null)}
        >
          清空
        </Button>
      ) : null}
    </div>
  )
}

export default ShortcutRecorder
