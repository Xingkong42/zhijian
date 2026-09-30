/**
 * Slider —— 轻量滑块（原生 `input[type=range]` 换皮）。
 *
 * ## 为什么用原生元素而不是自绘
 * 滑块的可访问性（方向键步进、`aria-valuenow`、屏幕阅读器、触摸拖动）原生全都自带，
 * 自绘要把这些重新实现一遍且极易漏掉；这里只统一外观。
 *
 * ⚠️ 轨道/滑块头用 `::-webkit-slider-*` 定制 —— WebView2（Chromium）与 Safari 支持；
 * 其它引擎会退化成原生外观，**不会坏**（本项目只面向 Windows WebView2）。
 *
 * ## 用法
 * ```tsx
 * <Slider value={opacity} min={0.3} max={1} step={0.05}
 *         label="磁贴透明度" onValueChange={setOpacity} />
 * ```
 */
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export interface SliderProps
  extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  value: number
  min?: number
  max?: number
  step?: number
  /** 无障碍名称（原生 range 需要 label 或 aria-label；本项目一律显式给） */
  label?: string
  onValueChange?: (value: number) => void
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  onValueChange,
  className,
  disabled,
  ...props
}: SliderProps) {
  return (
    <input
      type="range"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(Number(event.target.value))}
      className={cn(
        'h-4 w-full cursor-pointer appearance-none bg-transparent',
        // 轨道
        '[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full',
        '[&::-webkit-slider-runnable-track]:bg-surface-2',
        // 滑块头（-mt 让它在轨道上垂直居中）
        '[&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5',
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
        '[&::-webkit-slider-thumb]:bg-accent',
        'zj-focus-ring',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...props}
    />
  )
}
