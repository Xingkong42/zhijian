/**
 * 设计系统内部工具（不对业务导出，见 ./index.ts 的导出清单）。
 * 归属：设计系统（任务 t2）。
 *
 * 这里只放「多个组件共用、且与业务无关」的 hooks/纯函数：
 * 受控状态、浮层定位、外部点击与 Esc 关闭、焦点陷阱。
 * 禁止在这里 import src/store、src/db、src/features。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DependencyList, EffectCallback, RefObject } from 'react'

/** SSR/测试环境下退化为 useEffect（本项目无 SSR，仅作防御） */
export const useIsoLayoutEffect: (effect: EffectCallback, deps?: DependencyList) => void =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

/* ------------------------------ 图标刻度 ------------------------------ */

/** 图标尺寸（docs/DESIGN.md：14–15px 与正文同行；工具栏 15px） */
export const ICON_SIZE = 15
/** 极简线条：不用 2px 及以上的粗描边 */
export const ICON_STROKE = 1.75

/* --------------------------- 受控 / 非受控 --------------------------- */

export interface ControllableStateOptions<T> {
  /** 受控值；undefined 表示非受控 */
  value?: T | undefined
  /** 非受控初始值 */
  defaultValue: T
  /** 受控与非受控都会触发 */
  onChange?: ((next: T) => void) | undefined
}

/**
 * 同时支持受控与非受控用法（shadcn / Radix 同款约定）：
 *   <Dialog open={open} onOpenChange={setOpen}>  受控
 *   <Dialog defaultOpen>                          非受控
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: ControllableStateOptions<T>): [T, (next: T) => void] {
  const [uncontrolled, setUncontrolled] = useState<T>(defaultValue)
  const isControlled = value !== undefined
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const current = isControlled ? (value as T) : uncontrolled

  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next)
      onChangeRef.current?.(next)
    },
    [isControlled],
  )

  return [current, setValue]
}

/* ------------------------------ 浮层关闭 ------------------------------ */

const isInside = (target: Node | null, refs: ReadonlyArray<RefObject<HTMLElement | null>>): boolean => {
  if (!target) return false
  return refs.some((ref) => {
    const el = ref.current
    return !!el && el.contains(target)
  })
}

export interface DismissOptions {
  active: boolean
  onDismiss: () => void
  /** 落在这些元素内的交互不算「外部」 */
  refs?: ReadonlyArray<RefObject<HTMLElement | null>>
  closeOnOutsidePointer?: boolean
  closeOnResize?: boolean
  closeOnEscape?: boolean
  /** 页面滚动时关闭（锚定式浮层用；对话框不要开） */
  closeOnScroll?: boolean
}

/** 统一处理 Esc 关闭 / 点击外部关闭 / 窗口尺寸变化关闭（菜单、浮层、对话框共用） */
export function useDismiss({
  active,
  onDismiss,
  refs = [],
  closeOnOutsidePointer = true,
  closeOnResize = true,
  closeOnEscape = true,
  closeOnScroll = false,
}: DismissOptions): void {
  const refsRef = useRef(refs)
  const dismissRef = useRef(onDismiss)

  useEffect(() => {
    refsRef.current = refs
    dismissRef.current = onDismiss
  })

  useEffect(() => {
    if (!active) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!closeOnEscape || event.key !== 'Escape') return
      event.stopPropagation()
      dismissRef.current()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!closeOnOutsidePointer) return
      if (isInside(event.target as Node | null, refsRef.current)) return
      dismissRef.current()
    }

    const onResize = () => {
      if (closeOnResize) dismissRef.current()
    }

    const onScroll = () => {
      if (closeOnScroll) dismissRef.current()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    if (closeOnScroll) window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [active, closeOnEscape, closeOnOutsidePointer, closeOnResize, closeOnScroll])
}

/* ------------------------------ 定位 ------------------------------ */

export type FloatingSide = 'top' | 'bottom'
export type FloatingAlign = 'start' | 'center' | 'end'

export interface FloatingOptions {
  side?: FloatingSide
  align?: FloatingAlign
  /** 锚点与浮层的间距（px，默认 4，取 4/8 刻度） */
  offset?: number
  /** 视口内边距（px，默认 8） */
  padding?: number
}

export interface FloatingPoint {
  x: number
  y: number
}

/** 计算所需的最小锚点矩形（DOMRect 结构兼容） */
export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** 纯函数：由锚点矩形和浮层尺寸算出视口内的 fixed 坐标（越界自动翻转/夹取） */
export function computeFloatingPosition(
  anchor: AnchorRect,
  surface: { width: number; height: number },
  { side = 'bottom', align = 'start', offset = 4, padding = 8 }: FloatingOptions = {},
): FloatingPoint {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  let x: number
  switch (align) {
    case 'end':
      x = anchor.right - surface.width
      break
    case 'center':
      x = anchor.left + anchor.width / 2 - surface.width / 2
      break
    default:
      x = anchor.left
  }
  x = Math.min(Math.max(x, padding), Math.max(padding, viewportWidth - surface.width - padding))

  const spaceBelow = viewportHeight - anchor.bottom
  const spaceAbove = anchor.top
  let resolvedSide = side
  if (side === 'bottom' && spaceBelow < surface.height + offset && spaceAbove > spaceBelow) {
    resolvedSide = 'top'
  } else if (side === 'top' && spaceAbove < surface.height + offset && spaceBelow > spaceAbove) {
    resolvedSide = 'bottom'
  }

  const y =
    resolvedSide === 'top' ? anchor.top - surface.height - offset : anchor.bottom + offset

  return { x, y: Math.max(padding, Math.min(y, viewportHeight - padding)) }
}

export interface AnchoredPositionOptions extends FloatingOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  surfaceRef: RefObject<HTMLElement | null>
}

/**
 * 浮层定位：打开时量一次锚点与浮层尺寸，返回 fixed 坐标。
 * 未测量前返回 null（调用方应先隐藏，避免左上角闪烁）。
 */
export function useAnchoredPosition({
  open,
  anchorRef,
  surfaceRef,
  side,
  align,
  offset,
  padding,
}: AnchoredPositionOptions): FloatingPoint | null {
  const [point, setPoint] = useState<FloatingPoint | null>(null)

  useIsoLayoutEffect(() => {
    if (!open) {
      setPoint(null)
      return
    }
    const anchor = anchorRef.current
    const surface = surfaceRef.current
    if (!anchor || !surface) return
    const anchorRect = anchor.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    setPoint(
      computeFloatingPosition(
        anchorRect,
        { width: surfaceRect.width, height: surfaceRect.height },
        { side, align, offset, padding },
      ),
    )
  }, [open, anchorRef, surfaceRef, side, align, offset, padding])

  return point
}

/** 由坐标（右键菜单 / 点击点）定位浮层：把坐标当成零尺寸锚点并夹取到视口内 */
export function usePointPosition(
  open: boolean,
  point: FloatingPoint | null,
  surfaceRef: RefObject<HTMLElement | null>,
  { side = 'bottom', align = 'start', offset = 4, padding = 8 }: FloatingOptions = {},
): FloatingPoint | null {
  const [resolved, setResolved] = useState<FloatingPoint | null>(null)
  const x = point?.x ?? null
  const y = point?.y ?? null

  useIsoLayoutEffect(() => {
    if (!open || x === null || y === null) {
      setResolved(null)
      return
    }
    const surface = surfaceRef.current
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    setResolved(
      computeFloatingPosition(
        { left: x, right: x, top: y, bottom: y, width: 0, height: 0 },
        { width: rect.width, height: rect.height },
        { side, align, offset, padding },
      ),
    )
  }, [open, x, y, surfaceRef, side, align, offset, padding])

  return resolved
}

/* ------------------------------ 焦点 ------------------------------ */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/** 打开时把焦点移入容器、关闭时还给原元素，并让 Tab 在容器内循环 */
export function useFocusTrap(active: boolean, containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    const previous = document.activeElement as HTMLElement | null

    const focusFirst = () => {
      const target = container?.querySelector<HTMLElement>('[data-autofocus]')
      const focusables = focusableWithin(container)
      ;(target ?? focusables[0] ?? container)?.focus()
    }
    const raf = window.requestAnimationFrame(focusFirst)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !container) return
      const focusables = focusableWithin(container)
      if (focusables.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement
      if (event.shiftKey && (activeEl === first || activeEl === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.cancelAnimationFrame(raf)
      previous?.focus?.()
    }
  }, [active, containerRef])
}

/**
 * 浮层卸载后把焦点交还给打开它的元素（菜单 / 提示用）。
 * 只在「焦点已丢失或仍停在浮层内」时归还，避免抢走用户刚点到的新目标
 * （例如点了菜单项 → 打开了对话框，焦点应该留给对话框）。
 */
export function useReturnFocus(
  active: boolean,
  containerRef?: RefObject<HTMLElement | null>,
): void {
  const previousRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    previousRef.current = document.activeElement as HTMLElement | null
    return () => {
      const previous = previousRef.current
      if (!previous || !document.contains(previous)) return
      const current = document.activeElement as HTMLElement | null
      const lost = !current || current === document.body || current === document.documentElement
      const stillInsideMenu = !!containerRef?.current?.contains(current)
      if (lost || stillInsideMenu) previous.focus()
    }
  }, [active, containerRef])
}
