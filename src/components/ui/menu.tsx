/**
 * Menu 核心（内部复用，业务请直接用 ./dropdown-menu、./context-menu）。
 * 归属：设计系统（任务 t2）。
 *
 * 只做三件事：把菜单挂到 body（portal）、按菜单语义渲染条目、处理方向键导航。
 * 定位与关闭策略由调用方（DropdownMenu / ContextMenu）决定。
 */

import { Fragment, useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ICON_SIZE, ICON_STROKE, useReturnFocus } from './internal'
import { Kbd } from './badge'
import { Separator } from './separator'
import { Portal } from './portal'

/** 菜单项定义：数据驱动，避免业务侧重复实现键盘/焦点逻辑 */
export interface MenuItemDef {
  /** 稳定 key（不传则用下标，动态列表请传） */
  id?: string
  label: ReactNode
  /** 前置图标（lucide-react 组件） */
  icon?: LucideIcon
  /** 右侧快捷键提示，如 'Ctrl+E' */
  shortcut?: string
  disabled?: boolean
  /** 分组标题：不可点击、不可聚焦 */
  heading?: boolean
  /** 在本项之前插入 1px 分隔线 */
  separatorBefore?: boolean
  onSelect?: () => void
}

/** 浮层统一出口：挂到 document.body，避免被父级 overflow/transform 裁剪 */
export const MenuPortal = Portal

export interface MenuSurfaceProps {
  items: readonly MenuItemDef[]
  onClose: () => void
  /** 菜单容器 ref（定位与「点击外部关闭」都需要） */
  containerRef: RefObject<HTMLDivElement | null>
  id?: string
  className?: string
  style?: CSSProperties
}

const ITEM_CLASS = [
  'flex w-full items-center gap-2 rounded-zj-sm px-2 py-1 text-left text-ui text-text',
  'transition-colors duration-150 ease-out',
  'hover:bg-hover focus:bg-selection focus:outline-none active:bg-selection',
  'disabled:pointer-events-none disabled:opacity-45',
].join(' ')

export function MenuSurface({ items, onClose, containerRef, id, className, style }: MenuSurfaceProps) {
  const activeIndexRef = useRef(-1)

  // 关闭后焦点回到触发元素（Esc / 执行菜单项都适用）
  useReturnFocus(true, containerRef)

  /** 可聚焦条目（跳过禁用项） */
  const getFocusable = useCallback((): HTMLElement[] => {
    const container = containerRef.current
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-menu-item="true"]')).filter(
      (el) => !el.hasAttribute('disabled'),
    )
  }, [containerRef])

  // 打开后焦点进入菜单（键盘用户立刻可用）
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      const list = getFocusable()
      if (list.length > 0) {
        activeIndexRef.current = 0
        list[0].focus()
      } else {
        containerRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [getFocusable, containerRef])

  const focusAt = (index: number) => {
    const list = getFocusable()
    if (list.length === 0) return
    const next = ((index % list.length) + list.length) % list.length
    activeIndexRef.current = next
    list[next].focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = getFocusable()
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusAt(activeIndexRef.current + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusAt(activeIndexRef.current - 1)
        break
      case 'Home':
        event.preventDefault()
        focusAt(0)
        break
      case 'End':
        event.preventDefault()
        focusAt(list.length - 1)
        break
      case 'Tab':
        // 菜单是「模态式」浮层：Tab 直接关闭并交还焦点，不做焦点漫游
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <div
      ref={containerRef}
      id={id}
      role="menu"
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      className={cn(
        'fixed z-[55] max-h-72 min-w-36 overflow-y-auto rounded-zj border border-border bg-surface p-1 shadow-zj zj-fade-in outline-none',
        className,
      )}
    >
      {items.map((item, index) => (
        <Fragment key={item.id ?? `${index}-${typeof item.label === 'string' ? item.label : ''}`}>
          {item.separatorBefore && index > 0 ? <Separator className="my-1" /> : null}
          {item.heading ? (
            <div
              role="presentation"
              className="px-2 pb-1 pt-2 text-2xs font-medium tracking-wide text-muted"
            >
              {item.label}
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              data-menu-item="true"
              tabIndex={-1}
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              onMouseEnter={(event) => {
                const list = getFocusable()
                const position = list.indexOf(event.currentTarget)
                if (position >= 0) activeIndexRef.current = position
              }}
              onClick={() => {
                if (item.disabled) return
                item.onSelect?.()
                onClose()
              }}
              className={ITEM_CLASS}
            >
              {item.icon ? (
                <item.icon
                  size={ICON_SIZE}
                  strokeWidth={ICON_STROKE}
                  className="shrink-0 text-muted"
                  aria-hidden
                />
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
            </button>
          )}
        </Fragment>
      ))}
    </div>
  )
}
