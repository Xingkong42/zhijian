/**
 * DropdownMenu —— 点击触发的下拉菜单（数据驱动，键盘可用）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法：
 *   <DropdownMenu
 *     trigger={<IconButton icon={MoreHorizontal} label="更多" />}
 *     align="end"
 *     items={[
 *       { id: 'export', label: '导出为 Markdown', icon: FileDown, shortcut: 'Ctrl+E', onSelect: onExport },
 *       { id: 'delete', label: '移到回收站', icon: Trash2, separatorBefore: true, onSelect: onRemove },
 *     ]}
 *   />
 *
 * 交互：点击触发器切换、Esc / 点击外部 / 页面滚动 关闭、方向键 + Home/End 导航、Enter 执行。
 * 触发器被包在 inline-flex 容器里（定位锚点），需要的布局类通过 className 传入。
 */

import { cloneElement, isValidElement, useCallback, useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useAnchoredPosition, useDismiss } from './internal'
import type { FloatingAlign, FloatingSide } from './internal'
import { MenuPortal, MenuSurface } from './menu'
import type { MenuItemDef } from './menu'

export interface DropdownMenuProps {
  items: readonly MenuItemDef[]
  trigger: ReactNode
  align?: FloatingAlign
  side?: FloatingSide
  disabled?: boolean
  /** 触发器包裹层类名（例如让它在工具栏里 flex-1 / ml-auto） */
  className?: string
  menuClassName?: string
}

/** 给触发器补 a11y 属性（不改变其行为，点击由容器统一处理） */
function decorateTrigger(trigger: ReactNode, extra: Record<string, unknown>): ReactNode {
  if (!isValidElement(trigger)) return trigger
  const element = trigger as ReactElement<Record<string, unknown>>
  return cloneElement(element, extra)
}

export function DropdownMenu({
  items,
  trigger,
  align = 'start',
  side = 'bottom',
  disabled = false,
  className,
  menuClassName,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const close = useCallback(() => setOpen(false), [])

  useDismiss({
    active: open,
    onDismiss: close,
    refs: [triggerRef, surfaceRef],
    closeOnScroll: true,
  })

  const point = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    surfaceRef,
    side,
    align,
    offset: 4,
  })

  return (
    <>
      <span
        ref={triggerRef}
        data-dropdown-trigger=""
        className={cn('inline-flex', className)}
        onClick={() => {
          if (!disabled) setOpen((value) => !value)
        }}
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {decorateTrigger(trigger, {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? menuId : undefined,
          'data-state': open ? 'open' : 'closed',
        })}
      </span>

      {open ? (
        <MenuPortal>
          <MenuSurface
            id={menuId}
            items={items}
            onClose={close}
            containerRef={surfaceRef}
            className={menuClassName}
            style={{
              left: point?.x ?? -9999,
              top: point?.y ?? -9999,
              visibility: point ? 'visible' : 'hidden',
            }}
          />
        </MenuPortal>
      ) : null}
    </>
  )
}
