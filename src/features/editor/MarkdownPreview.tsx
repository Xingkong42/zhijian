/**
 * MarkdownPreview —— Markdown 实时预览（react-markdown + remark-gfm + Shiki）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 支持：标题 / 段落 / 有序无序列表 / GFM 任务列表 / 表格 / 引用 / 链接 / 图片 /
 * 删除线 / 行内代码 / 围栏代码块（Shiki 高亮 + 语言角标 + 复制）。
 *
 * 样式全部来自 token 与设计刻度（docs/DESIGN.md）：
 *  - 正文 15px/1.75（text-editor），正文最大宽 760px 居中；
 *  - 代码块 bg-surface-2 + 8px 圆角；引用左侧 2px accent 描边；
 *  - 不使用 Tailwind 内置调色板，也不写 #RRGGBB 字面量。
 */

import { useEffect } from 'react'
import type { JSX, MouseEvent } from 'react'
import Markdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/tauri'
import { CodeBlock } from './CodeBlock'
import { preloadHighlighter } from './shikiHighlighter'
import './preview.css'

/** 组件 props = 原生元素 props + react-markdown 附带的 hast 节点 */
type MarkdownElementProps<K extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[K] &
  ExtraProps

type HastElement = NonNullable<ExtraProps['node']>

/* ------------------------------ 类名常量 ------------------------------ */

const BODY_TEXT = 'text-editor text-text'
const HEADING = 'mt-6 mb-3 font-semibold text-text first:mt-0'
const LIST = 'my-3 space-y-1 pl-6 text-editor text-text'
const INLINE_CODE =
  'rounded-zj-sm border border-border bg-surface-2 px-1 py-0.5 font-mono text-ui text-text'

const styles = {
  h1: cn(HEADING, 'border-b border-border pb-2 text-title'),
  h2: cn(HEADING, 'text-editor'),
  h3: cn(HEADING, 'text-body'),
  h4: cn(HEADING, 'text-ui'),
  h5: cn(HEADING, 'text-ui text-muted'),
  h6: cn(HEADING, 'text-meta text-muted'),
  p: cn(BODY_TEXT, 'my-3'),
  ul: cn(LIST, 'list-disc marker:text-muted'),
  ol: cn(LIST, 'list-decimal marker:text-muted'),
  li: cn(BODY_TEXT, 'leading-relaxed'),
  blockquote: 'my-4 border-l-2 border-accent pl-4 text-editor italic text-muted',
  a: 'text-accent underline underline-offset-2 hover:opacity-80',
  img: 'my-4 max-w-full rounded-zj border border-border',
  hr: 'my-6 border-t border-border',
  del: 'text-muted line-through',
  strong: 'font-semibold text-text',
  em: 'italic',
  table: 'w-full border-collapse text-ui text-text',
  th: 'border border-border bg-surface-2 px-3 py-2 text-left font-medium',
  td: 'border border-border px-3 py-2 align-top',
  taskList: 'list-none pl-1',
  taskItem: 'flex items-start gap-2',
} as const

/* ------------------------------ 小工具 ------------------------------ */

/** 递归取 hast 节点的纯文本 */
function hastText(node: HastElement): string {
  let out = ''
  for (const child of node.children) {
    if (child.type === 'text') out += child.value
    else if (child.type === 'element') out += hastText(child)
  }
  return out
}

/** 从 fence 的 meta（```ts title="a.ts"）里取文件名，取不到返回 null */
function fileLabelFromMeta(meta: string | null): string | null {
  if (!meta) return null
  const matched = /(?:title|filename)=("([^"]*)"|'([^']*)'|(\S+))/.exec(meta)
  if (!matched) return null
  return matched[2] ?? matched[3] ?? matched[4] ?? null
}

interface FencedCode {
  code: string
  lang: string | null
  meta: string | null
}

/** 从 <pre> 节点里取出 <code> 的文本 / 语言 / meta */
function extractFencedCode(node: HastElement | undefined): FencedCode | null {
  const child = node?.children.find(
    (item): item is HastElement => item.type === 'element' && item.tagName === 'code',
  )
  if (!child) return null

  const rawClass: unknown = child.properties?.['className']
  const classes: string[] = Array.isArray(rawClass)
    ? rawClass.map(String)
    : typeof rawClass === 'string'
      ? rawClass.split(/\s+/)
      : []
  const lang =
    classes.find((name: string) => name.startsWith('language-'))?.slice('language-'.length) ?? null

  const data = child.data as Record<string, unknown> | undefined
  const rawMeta = data?.['meta']
  const meta = typeof rawMeta === 'string' ? rawMeta : null

  return { code: hastText(child), lang, meta }
}

/** Tauri 里用系统浏览器打开外链，避免把应用窗口导航走 */
function handleLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  if (!href) return
  if (!isTauri) return
  if (!/^https?:\/\//i.test(href)) return
  event.preventDefault()
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(href))
    .catch((error: unknown) => {
      // 不静默：外链点了没反应是最容易被忽略的静默失败（opener 权限 / 非法 URL）
      console.warn(`[纸笺] 打开外链失败（${href}），请检查 opener 权限：`, error)
    })
}

/* ------------------------------ 组件映射 ------------------------------ */

const components: Components = {
  h1: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h1'>) => (
    <h1 className={cn(styles.h1, className)} {...rest}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h2'>) => (
    <h2 className={cn(styles.h2, className)} {...rest}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h3'>) => (
    <h3 className={cn(styles.h3, className)} {...rest}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h4'>) => (
    <h4 className={cn(styles.h4, className)} {...rest}>
      {children}
    </h4>
  ),
  h5: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h5'>) => (
    <h5 className={cn(styles.h5, className)} {...rest}>
      {children}
    </h5>
  ),
  h6: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'h6'>) => (
    <h6 className={cn(styles.h6, className)} {...rest}>
      {children}
    </h6>
  ),
  p: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'p'>) => (
    <p className={cn(styles.p, className)} {...rest}>
      {children}
    </p>
  ),
  ul: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'ul'>) => (
    <ul
      className={cn(styles.ul, className?.includes('contains-task-list') ? styles.taskList : null, className)}
      {...rest}
    >
      {children}
    </ul>
  ),
  ol: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'ol'>) => (
    <ol className={cn(styles.ol, className)} {...rest}>
      {children}
    </ol>
  ),
  li: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'li'>) => (
    <li
      className={cn(styles.li, className?.includes('task-list-item') ? styles.taskItem : null, className)}
      {...rest}
    >
      {children}
    </li>
  ),
  blockquote: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'blockquote'>) => (
    <blockquote className={cn(styles.blockquote, className)} {...rest}>
      {children}
    </blockquote>
  ),
  a: ({ node: _node, className, children, href, onClick, ...rest }: MarkdownElementProps<'a'>) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(styles.a, className)}
      onClick={(event) => {
        onClick?.(event)
        handleLinkClick(event, href)
      }}
      {...rest}
    >
      {children}
    </a>
  ),
  img: ({ node: _node, className, alt, ...rest }: MarkdownElementProps<'img'>) => (
    <img
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className={cn(styles.img, className)}
      {...rest}
    />
  ),
  hr: ({ node: _node, className, ...rest }: MarkdownElementProps<'hr'>) => (
    <hr className={cn(styles.hr, className)} {...rest} />
  ),
  del: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'del'>) => (
    <del className={cn(styles.del, className)} {...rest}>
      {children}
    </del>
  ),
  strong: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'strong'>) => (
    <strong className={cn(styles.strong, className)} {...rest}>
      {children}
    </strong>
  ),
  em: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'em'>) => (
    <em className={cn(styles.em, className)} {...rest}>
      {children}
    </em>
  ),
  /* 行内代码：围栏代码块由 pre 拦截，因此这里只会是行内 code */
  code: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'code'>) => (
    <code className={cn('font-mono', INLINE_CODE, className)} {...rest}>
      {children}
    </code>
  ),
  pre: ({ node, className, children, ...rest }: MarkdownElementProps<'pre'>) => {
    const fenced = extractFencedCode(node)
    if (fenced) {
      return (
        <CodeBlock
          code={fenced.code}
          lang={fenced.lang}
          title={fileLabelFromMeta(fenced.meta)}
          className={className}
        />
      )
    }
    return (
      <pre
        className={cn(
          'zj-code-block my-4 overflow-x-auto rounded-zj border border-border bg-surface-2 px-3 py-2',
          className,
        )}
        {...rest}
      >
        {children}
      </pre>
    )
  },
  table: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'table'>) => (
    <div className="my-4 w-full overflow-x-auto rounded-zj border border-border">
      <table className={cn(styles.table, className)} {...rest}>
        {children}
      </table>
    </div>
  ),
  thead: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'thead'>) => (
    <thead className={cn('bg-surface-2', className)} {...rest}>
      {children}
    </thead>
  ),
  th: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'th'>) => (
    <th className={cn(styles.th, className)} {...rest}>
      {children}
    </th>
  ),
  td: ({ node: _node, className, children, ...rest }: MarkdownElementProps<'td'>) => (
    <td className={cn(styles.td, className)} {...rest}>
      {children}
    </td>
  ),
  /* GFM 任务列表复选框（react-markdown 已置 disabled，样式跟随 accent token） */
  input: ({ node: _node, className, type, ...rest }: MarkdownElementProps<'input'>) => (
    <input
      type={type}
      className={cn('mt-1 h-3 w-3 shrink-0 accent-accent', className)}
      {...rest}
    />
  ),
}

/* ------------------------------ 组件 ------------------------------ */

/** remark 插件数组保持模块级稳定引用，避免 react-markdown 反复重建处理器 */
const REMARK_PLUGINS = [remarkGfm]

export interface MarkdownPreviewProps {
  /** Markdown 原文 */
  content: string
  className?: string
}

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  // 预览一挂载就把 shiki 引擎与双主题 chunk 拉起来，第一块代码块不用等
  useEffect(() => {
    void preloadHighlighter()
  }, [])

  const hasContent = content.trim().length > 0

  return (
    <div
      data-zj-preview=""
      className={cn('zj-selectable zj-scroll h-full min-h-0 overflow-y-auto bg-bg', className)}
    >
      <div className="mx-auto w-full max-w-[760px] px-8 py-6">
        {hasContent ? (
          <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
            {content}
          </Markdown>
        ) : (
          <p className="py-8 text-meta text-muted">正文为空 —— 切到「编辑」开始写作</p>
        )}
      </div>
    </div>
  )
}

/** 供自检脚本断言「GFM 已启用」 */
export const PREVIEW_REMARK_PLUGINS = REMARK_PLUGINS
