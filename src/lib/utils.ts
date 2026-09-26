import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge 需要知道本项目自定义的字号刻度（src/index.css 的 @theme inline
 * 里定义的 --text-2xs / meta / ui / body / editor / title / display）。
 * 否则 `text-ui` 这类自定义字号会被 tailwind-merge 当成「文字颜色」，
 * 与 `text-muted`、`text-accent-fg` 归入同一冲突组而互相覆盖
 * （实测：cn('bg-accent text-accent-fg text-ui') 会丢掉 text-accent-fg）。
 * 这里把它们注册进 font-size 组，颜色与字号各归其组，互不干扰。
 */
const FONT_SIZE_SCALE = ['2xs', 'meta', 'ui', 'body', 'editor', 'title', 'display'] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZE_SCALE] }],
    },
  },
})

/**
 * 合并 Tailwind 类名（shadcn/ui 约定）。
 * 所有组件统一用 cn() 拼接类名，不要手写模板字符串拼接。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** 截断文本到指定长度，末尾加省略号 */
export function truncate(text: string, max = 80): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** 从未知错误里取可读 message（db 层抛出的 Error 直接透传） */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** 把毫秒时间戳格式化为「刚刚 / N 分钟前 / YYYY-MM-DD」 */
export function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 生成全局唯一 id —— 全项目唯一的 id 生成入口。
 * 禁止在其它文件里自己调用 Math.random / 时间戳拼 id。
 */
export function newId(): string {
  return crypto.randomUUID()
}

/** 当前毫秒时间戳（统一入口，便于测试打桩） */
export function now(): number {
  return Date.now()
}

/**
 * 从 Markdown 正文推导笔记标题（第一行非空内容，去掉 # 前缀）。
 * 用于编辑器未显式设置标题时的默认标题。
 */
export function deriveTitle(content: string, max = 60): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return '无标题'
  return truncate(firstLine.replace(/^#{1,6}\s*/, ''), max)
}

/** 生成给用户看的纯文本摘要（去掉 Markdown 标记） */
export function plainSummary(content: string, max = 120): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(plain, max)
}
