/**
 * CodeBlock —— 预览里的代码块（Shiki 高亮 + 语言角标 + 复制）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 设计：
 *  - 细粒度、按需：语言 chunk 只在真的出现该语言时加载（见 shikiHighlighter.ts）；
 *  - 双主题一次产出：亮/暗色值以 CSS 变量写在 HTML 上，明暗切换零重算；
 *  - 高亮未就绪或失败时先渲染纯文本 <pre>（视觉尺寸一致，不跳动、不白屏）。
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/utils'
import { highlightCode, langLabel } from './shikiHighlighter'
import './preview.css'

export interface CodeBlockProps {
  code: string
  /** fence 上的语言标记（```ts → 'ts'），可为空 */
  lang?: string | null
  /** fence meta 里的文件名（```ts title="a.ts"），优先作为角标文案 */
  title?: string | null
  /** 是否展示「语言角标 + 复制」这一行（默认展示） */
  showHeader?: boolean
  className?: string
}

export function CodeBlock({ code, lang, title, showHeader = true, className }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    void highlightCode(code, lang)
      .then((result) => {
        if (!cancelled) setHtml(result.html)
      })
      .catch((error: unknown) => {
        // 不静默：高亮失败时这块代码会退化成纯文本，用户看不出差别、开发者也无从得知
        if (cancelled) return
        setHtml(null)
        console.warn(`[纸笺] 代码块高亮失败（lang=${lang ?? 'text'}），已退化为纯文本：`, error)
      })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const handleCopy = () => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch((error: unknown) => {
        // 点「复制」却没反应是最典型的静默失败（剪贴板权限 / 非安全上下文），必须留痕
        console.warn('[纸笺] 复制代码失败（剪贴板不可用？）：', error)
      })
  }

  return (
    <figure
      data-zj-code-block={lang ?? ''}
      className={cn(
        'zj-code-block my-4 overflow-hidden rounded-zj border border-border bg-surface-2',
        className,
      )}
    >
      {showHeader ? (
        <figcaption className="flex h-7 items-center justify-between gap-2 border-b border-border px-3">
          <span className="truncate font-mono text-2xs text-muted" title={title ?? undefined}>
            {title ?? langLabel(lang)}
          </span>
          <IconButton
            icon={copied ? Check : Copy}
            label={copied ? '已复制' : '复制代码'}
            size="icon-sm"
            variant="subtle"
            iconSize={13}
            onClick={handleCopy}
          />
        </figcaption>
      ) : null}

      <div className="zj-scroll overflow-x-auto px-3 py-2 text-ui">
        {html ? (
          // shiki 生成的 HTML 是我们自己构造的，不含用户注入的标签（代码已转义）
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="zj-code-plain font-mono text-ui leading-relaxed">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </figure>
  )
}
