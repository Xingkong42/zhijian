/**
 * Tabs —— 分段切换（编辑 / 预览 / 分栏、设置分组）。
 * 归属：设计系统（任务 t2）。
 *
 * 用法：
 *   <Tabs value={mode} onValueChange={onModeChange} variant="line">
 *     <TabsList>
 *       <TabsTrigger value="edit">编辑</TabsTrigger>
 *       <TabsTrigger value="preview">预览</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="edit">…</TabsContent>
 *   </Tabs>
 *
 * 键盘：← → 移动并激活、Home / End 跳首尾；选中项 tabIndex=0，其余 -1（roving tabindex）。
 */

import { createContext, useContext, useId, useRef, useState } from 'react'
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

type TabsVariant = 'line' | 'pill'

interface TabsContextValue {
  value: string
  setValue: (value: string) => void
  variant: TabsVariant
  baseId: string
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(): TabsContextValue {
  const context = useContext(TabsContext)
  if (!context) throw new Error('Tabs 子组件必须放在 <Tabs> 内使用')
  return context
}

export interface TabsProps extends Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  variant?: TabsVariant
}

export function Tabs({
  className,
  value: valueProp,
  defaultValue = '',
  onValueChange,
  variant = 'line',
  children,
  ...props
}: TabsProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const isControlled = valueProp !== undefined
  const value = isControlled ? valueProp : uncontrolled
  const baseId = useId()

  return (
    <TabsContext.Provider
      value={{
        value,
        setValue: (next) => {
          if (!isControlled) setUncontrolled(next)
          onValueChange?.(next)
        },
        variant,
        baseId,
      }}
    >
      <div className={cn('flex flex-col', className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

const tabsListVariants = cva('flex shrink-0 items-center', {
  variants: {
    variant: {
      line: 'gap-1 border-b border-border',
      pill: /* p-1（4px）= 分段控件「槽」内距，落在 DESIGN §2 刻度内；
               外框高度由使用方决定（编辑器工具条 h-11，pill 38px 不溢出）。
               ⚠️ 若将来嵌进 h-9 及更矮的容器，请先量高度再考虑豁免（见 DESIGN §7）。 */
        'w-fit gap-1 rounded-zj bg-surface-2 p-1',
    },
  },
  defaultVariants: { variant: 'line' },
})

export interface TabsListProps
  extends ComponentProps<'div'>,
    VariantProps<typeof tabsListVariants> {}

export function TabsList({ className, variant, children, ...props }: TabsListProps) {
  const context = useTabsContext()
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    ).filter((tab) => !tab.disabled)
    if (tabs.length === 0) return
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    switch (event.key) {
      case 'ArrowRight':
        next = current + 1
        break
      case 'ArrowLeft':
        next = current - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = tabs[((next % tabs.length) + tabs.length) % tabs.length]
    target.focus()
    target.click()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(tabsListVariants({ variant: variant ?? context.variant }), className)}
      {...props}
    >
      {children}
    </div>
  )
}

const tabsTriggerVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap rounded-zj-sm',
    'text-ui font-medium transition-colors duration-150 ease-out zj-focus-ring',
    'disabled:pointer-events-none disabled:opacity-45',
  ].join(' '),
  {
    variants: {
      variant: {
        line: [
          'border-b-2 border-transparent px-3 py-2 text-muted',
          'hover:bg-hover hover:text-text',
          'data-[state=active]:border-accent data-[state=active]:text-text',
        ].join(' '),
        pill: [
          'px-3 py-1 text-muted',
          'hover:bg-hover hover:text-text',
          'data-[state=active]:bg-selection data-[state=active]:text-text',
        ].join(' '),
      },
    },
    defaultVariants: { variant: 'line' },
  },
)

export interface TabsTriggerProps
  extends ComponentProps<'button'>,
    VariantProps<typeof tabsTriggerVariants> {
  value: string
  icon?: ReactNode
}

export function TabsTrigger({
  className,
  variant,
  value,
  icon,
  children,
  onClick,
  ...props
}: TabsTriggerProps) {
  const context = useTabsContext()
  const selected = context.value === value
  return (
    <button
      type="button"
      role="tab"
      id={`${context.baseId}-tab-${value}`}
      aria-controls={`${context.baseId}-panel-${value}`}
      aria-selected={selected}
      data-state={selected ? 'active' : 'inactive'}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        context.setValue(value)
      }}
      className={cn(tabsTriggerVariants({ variant: variant ?? context.variant }), className)}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}

export interface TabsContentProps extends ComponentProps<'div'> {
  value: string
}

export function TabsContent({ className, value, children, ...props }: TabsContentProps) {
  const context = useTabsContext()
  const selected = context.value === value
  return (
    <div
      role="tabpanel"
      id={`${context.baseId}-panel-${value}`}
      aria-labelledby={`${context.baseId}-tab-${value}`}
      hidden={!selected}
      tabIndex={0}
      className={cn('min-h-0 flex-1 outline-none', className)}
      {...props}
    >
      {selected ? children : null}
    </div>
  )
}
