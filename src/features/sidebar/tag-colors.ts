/**
 * 标签配色的运行时来源。
 * 归属：src/features/sidebar/**（t18）。
 *
 * 设计约束（docs/DESIGN.md §6 红线）：**源码里不允许出现颜色字面量**。
 * 但「改标签颜色」这个功能本质就是让用户挑颜色，因此这里的做法是：
 *   - 快捷色板**运行时可读**：从当前主题的 `--zj-*` token 现读现用（切主题自动跟随）；
 *   - 自定义颜色交给浏览器原生取色器 `input[type=color]`，它的初值来自标签当前的
 *     颜色值（领域数据，来自 md front-matter 的 `color`），不是写死在源码里的常量。
 * 于是「源码零色值」与「用户能改颜色」两者同时成立。
 */

import type { ThemeToken } from '@/types'

/** 快捷色板用的 token（都在浅/深两套里有足够对比度，适合做小圆点） */
const SWATCH_TOKENS: readonly { token: ThemeToken; label: string }[] = [
  { token: 'zj-accent', label: '主题强调色' },
  { token: 'zj-text', label: '主题墨色' },
  { token: 'zj-text-muted', label: '主题浅墨色' },
  { token: 'zj-border', label: '主题描边色' },
] as const

export interface TagSwatch {
  /** 来源 token（同时用作列表 key） */
  token: ThemeToken
  label: string
  /** 形如 `#C9A227` 的运行时值；读不到 token 时为空串（该色板项会被隐藏） */
  value: string
}

/** 读取当前主题的快捷色板（每次调用都现读，跟随主题切换） */
export function themeTagSwatches(scope?: Element): TagSwatch[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return []
  const element = scope ?? document.documentElement
  const styles = window.getComputedStyle(element)
  return SWATCH_TOKENS.map(({ token, label }) => ({
    token,
    label,
    value: styles.getPropertyValue(`--${token}`).trim(),
  })).filter((swatch) => swatch.value.length > 0)
}

/** 颜色值是否可用作 CSS 颜色（原生取色器只会给 `#rrggbb`，这里宽松校验一下） */
export function isUsableColor(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
}

/** 把任意输入归一化为 `#rrggbb`（供原生取色器回填；非法值返回 null） */
export function normalizeHexColor(value: string): string | null {
  const raw = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const [, r, g, b] = raw.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return null
}
