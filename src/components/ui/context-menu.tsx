/**
 * ContextMenu —— 右键菜单（笔记列表项、文件夹、标签共用）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法：
 *   <ContextMenu items={[{ id: 'pin', label: '置顶', icon: Pin, onSelect: onPin }]}>
 *     <NoteRow />
 *   </ContextMenu>
 *
 * 容器默认 display:contents —— **不参与布局**，只负责在子树内接收 contextmenu 事件；
 * 需要真实盒子时用 className 覆盖（如 className="block"）。
 * 关闭策略：Esc / 点击任意处 / 滚动 / 窗口尺寸变化。
 */

import { useCallback, useId, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useDismiss, usePointPosition } from './internal'
import type { FloatingPoint } from './internal'
import { MenuPortal, MenuSurface } from './menu'
import type { MenuItemDef } from './menu'

export interface ContextMenuProps {
  items: readonly MenuItemDef[]
  children: ReactNode
  disabled?: boolean
  /** 覆盖容器布局（默认 contents） */
  className?: string
  menuClassName?: string
}

export function ContextMenu({
  items,
  children,
  disabled = false,
  className,
  menuClassName,
}: ContextMenuProps) {
  const [point, setPoint] = useState<FloatingPoint | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const open = point !== null

  const close = useCallback(() => setPoint(null), [])

  useDismiss({ active: open, onDismiss: close, refs: [surfaceRef], closeOnScroll: true })

  const resolved = usePointPosition(open, point, surfaceRef, { offset: 4 })

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    setPoint({ x: event.clientX, y: event.clientY })
  }

  return (
    <>
      <div className={cn('contents', className)} onContextMenu={onContextMenu}>
        {children}
      </div>
      {open ? (
        <MenuPortal>
          <MenuSurface
            id={menuId}
            items={items}
            onClose={close}
            containerRef={surfaceRef}
            className={menuClassName}
            style={{
              left: resolved?.x ?? point?.x ?? -9999,
              top: resolved?.y ?? point?.y ?? -9999,
              visibility: resolved ? 'visible' : 'hidden',
            }}
          />
        </MenuPortal>
      ) : null}
    </>
  )
}
