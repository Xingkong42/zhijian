/**
 * Titlebar —— 无边框窗口的自定义标题栏（交付物 1）。
 * 归属：src/features/titlebar/**（t5）。Props 契约：src/types/index.ts::TitlebarProps（FROZEN，逐字一致）。
 *
 * 布局（docs/DESIGN.md §5）：高 36px · `bg-surface` · 底部 1px `--zj-border` · 整条可拖拽。
 * 左：应用名「纸笺」+ 轻量图标｜中：当前笔记标题 + 保存状态（纯拖拽区）｜右：设置 / 最小化 / 最大化 / 关闭。
 *
 * 拖拽区实现要点：
 *  - `data-tauri-drag-region="deep"` 放在 `<header>` 上。Tauri 2.11 的注入脚本
 *    （src/window/scripts/drag.js）对 `deep` 的语义是「子树内任意位置可拖」，但
 *    **遇到可点击元素（button/a/input/label…）且该元素自身没有该属性时立即放弃拖拽**，
 *    所以右侧按钮天然「点得动」，不需要给按钮加属性，也不需要 `no-drag` 补丁。
 *  - 双击拖拽区切换最大化由 Tauri 运行时自己处理（同上脚本：detail===2 → internal_toggle_maximize），
 *    这里**不重复实现**，否则会与运行时各切一次、互相抵消。
 *  - 窗口按钮 24×28px；close 悬停用 `--zj-selection`（不用红色块）。
 */

import { Check, Maximize2, Minimize2, Minus, NotebookPen, PencilLine, Settings, X } from 'lucide-react'
import type { TitlebarProps } from '@/types'
import { APP_META } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { IconButton, Separator } from '@/components/ui'

export function Titlebar({
  title,
  saved,
  maximized,
  onMinimize,
  onToggleMaximize,
  onClose,
  onOpenSettings,
}: TitlebarProps) {
  const noteTitle = title.trim().length > 0 ? title : '未选择笔记'

  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        'z-20 flex h-9 shrink-0 select-none items-center gap-2',
        'border-b border-border bg-surface pl-3 pr-2',
      )}
    >
      {/* 左：应用标识（纯展示，属于拖拽区） */}
      <span className="flex shrink-0 items-center gap-1">
        <NotebookPen size={14} strokeWidth={1.75} className="text-accent" aria-hidden />
        <span className="text-ui font-medium tracking-wide text-text">{APP_META.productName}</span>
      </span>

      <Separator orientation="vertical" className="h-4" />

      {/* 中：当前笔记标题（可被拖拽区吞掉点击，无需交互） */}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-meta',
          title.trim().length > 0 ? 'text-muted' : 'text-muted/70',
        )}
        title={noteTitle}
      >
        {noteTitle}
      </span>

      {/* 保存状态：role=status + aria-live，标题栏里即时可读 */}
      <span
        role="status"
        aria-live="polite"
        className="flex shrink-0 items-center gap-1 text-2xs text-muted"
      >
        {saved ? (
          <>
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已保存
          </>
        ) : (
          <>
            <PencilLine size={12} strokeWidth={1.75} className="text-accent" aria-hidden />
            未保存
          </>
        )}
      </span>

      {/* 右：窗口按钮（可点击元素，自动排除在拖拽区之外） */}
      <span className="flex shrink-0 items-center gap-1">
        <IconButton icon={Settings} label="设置" tooltip onClick={onOpenSettings} className="h-7 w-6" />
        <Separator orientation="vertical" className="mx-1 h-4" />
        <IconButton icon={Minus} label="最小化" tooltip onClick={onMinimize} className="h-7 w-6" />
        <IconButton
          icon={maximized ? Minimize2 : Maximize2}
          label={maximized ? '还原窗口' : '最大化窗口'}
          tooltip
          onClick={onToggleMaximize}
          aria-pressed={maximized}
          className="h-7 w-6"
        />
        <IconButton
          icon={X}
          label="关闭到托盘"
          tooltip
          onClick={onClose}
          className="h-7 w-6 hover:bg-selection hover:text-text"
        />
      </span>
    </header>
  )
}
