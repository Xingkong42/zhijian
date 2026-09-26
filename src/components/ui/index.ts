/**
 * 基础组件统一出口（shadcn/ui 风格的「薄组件」层）。
 * 归属：设计系统（任务 t2）。
 *
 * 硬性约定（等价于目录内的 import 红线）：
 *  1. 纯展示件：**禁止** import src/store、src/db、src/features。
 *  2. 类名一律经 cn()（@/lib/utils）合并；变体用 class-variance-authority。
 *  3. 颜色/圆角/阴影只能来自 token 派生类（bg-surface / text-muted / border-border /
 *     bg-hover / bg-selection / bg-accent / shadow-zj / rounded-zj-sm|zj|zj-lg）。
 *     组件里出现十六进制色值、rgb()/hsl() 字面量即缺陷。
 *  4. 图标一律 lucide-react，尺寸 15px / 线宽 1.75（ICON_SIZE / ICON_STROKE）。
 *  5. 每个交互态都要有可见反馈：hover / active / focus-visible（zj-focus-ring）/ disabled。
 *
 * 用法：import { Button, IconButton, Dialog, useToast } from '@/components/ui'
 * 详细 API 与范例见同目录 README.md。
 */

export * from './badge'
export * from './button'
export * from './context-menu'
export * from './dialog'
export * from './dropdown-menu'
export * from './empty-state'
export * from './input'
export * from './menu'
export * from './portal'
export * from './scroll-area'
export * from './separator'
export * from './switch'
export * from './tag-picker'
export * from './tabs'
export * from './textarea'
export * from './toast'
export * from './tooltip'

/** 图标刻度（自有组件里也请用这两个常量，保持线条统一） */
export { ICON_SIZE, ICON_STROKE } from './internal'
export type { FloatingAlign, FloatingPoint, FloatingSide } from './internal'

/** 目录锚点（历史占位导出，保留以免破坏既有 import） */
export const UI_COMPONENTS_DIR = 'src/components/ui' as const
