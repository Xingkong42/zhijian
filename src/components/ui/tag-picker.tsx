/**
 * TagPicker / TagPickerDialog —— 通用标签选择面板（搜索 / 勾选 / 新建 / 移除）。
 * 归属：设计系统目录，由编辑器成员按 captain 授权在 t23 落地（与 Dialog/DropdownMenu 同级）。
 *
 * 分层红线（与 components/ui 其它组件一致）：
 *  1. **不 import src/store、src/db、src/features** —— 完全 props 驱动，落库由宿主负责；
 *  2. 颜色只能来自 token 类；标签自身的颜色来自数据（`tag.color`，行内 style），
 *     源码里不出现任何颜色字面量；
 *  3. 类名一律经 cn() 合并、变体用 CVA、图标用 lucide-react（ICON_SIZE/ICON_STROKE）。
 *
 * 纯逻辑（`normalizeTagInput` / `tagColorOf` / `mergeTagCatalog` / `filterTagOptions` /
 * `toggleTagName` / `removeTagName` / `addTagName`）全部无副作用、可单独断言 ——
 * 见 src/features/editor/__checks__/run-checks.mjs（经 Vite SSR 载入本 .tsx 后断言）。
 *
 * 用法 A（自带 Dialog 外壳，最省事）：
 *   <TagPickerDialog open={open} onOpenChange={setOpen} value={note.tags} tags={allTags}
 *     context={note.title} onChange={(next) => notesStore.update(note.id, { tags: next })} />
 * 用法 B（content-only，嵌进自定义浮层）：
 *   <TagPicker value={note.tags} tags={allTags} onChange={...} onClose={...} />
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cva } from 'class-variance-authority'
import { Check, Plus, Search, Tag as TagIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ICON_SIZE, ICON_STROKE } from './internal'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'
import { EmptyState } from './empty-state'
import { Input } from './input'
import { ScrollArea } from './scroll-area'

/* ============================== 纯逻辑 ============================== */

/** 结构化的标签（Tag 与「只有名字」的输入都能传） */
export interface TagLike {
  name: string
  color?: string | null
}

/** 面板里的一行 */
export interface TagOption {
  name: string
  /** 标签颜色（来自数据，可为 null → 组件用 bg-accent 兜底） */
  color: string | null
  selected: boolean
  /** 不在标签库中：笔记上的历史标签，或本次刚新建的名字 */
  unlisted: boolean
}

/** 归一化标签名：去首尾空白、折叠内部空白（与 db 层 normalizeTags 语义一致） */
export function normalizeTagInput(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** 大小写不敏感的比较键（避免同一个标签以不同大小写重复出现） */
function tagKey(name: string): string {
  return normalizeTagInput(name).toLowerCase()
}

/**
 * 校验来自数据的标签颜色：只接受 3/4/6/8 位的十六进制写法，其余一律返回 null → 组件兜底。
 *
 * 为什么不能只判 `startsWith('#')`（designer 复核指出）：像 `#zz` 这种脏值会被 CSSOM
 * 直接忽略 → 行内 style 不生效，而 `color !== null` 又让 `bg-accent` 兜底失效
 * ⇒ 色点变成一个「空心点」。这里做完整校验后，脏值统一走兜底分支。
 * 注意：本函数不引入任何颜色常量，值只来自数据（tag.color）。
 */
const TAG_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function tagColorOf(tag?: TagLike | null): string | null {
  const raw = tag?.color?.trim()
  if (!raw || !TAG_COLOR_PATTERN.test(raw)) return null
  return raw
}

/**
 * 合并「标签库 + 当前选中」为一个可渲染的列表：
 *  - 选中项排在前面（保持选中顺序），其余按标签库顺序；
 *  - 选中但不在标签库里的名字也会渲染（unlisted=true），不会凭空消失；
 *  - 同名（忽略大小写）只出现一次，拼写以先出现者为准。
 */
export function mergeTagCatalog(
  all: readonly TagLike[] | undefined,
  selected: readonly string[],
): TagOption[] {
  const catalog = new Map<string, TagOption>()

  for (const tag of all ?? []) {
    const name = normalizeTagInput(tag.name)
    const key = tagKey(name)
    if (!name || catalog.has(key)) continue
    catalog.set(key, { name, color: tagColorOf(tag), selected: false, unlisted: false })
  }

  const selectedOptions: TagOption[] = []
  const seen = new Set<string>()
  for (const raw of selected) {
    const name = normalizeTagInput(raw)
    const key = tagKey(name)
    if (!name || seen.has(key)) continue
    seen.add(key)
    const known = catalog.get(key)
    if (known) {
      known.selected = true
      selectedOptions.push(known)
    } else {
      const option: TagOption = { name, color: null, selected: true, unlisted: true }
      catalog.set(key, option)
      selectedOptions.push(option)
    }
  }

  const rest = [...catalog.values()].filter((option) => !option.selected)
  return [...selectedOptions, ...rest]
}

/** 搜索过滤（空查询 = 不过滤；大小写不敏感，命中名称子串） */
export function filterTagOptions(options: readonly TagOption[], query: string): TagOption[] {
  const keyword = normalizeTagInput(query).toLowerCase()
  if (!keyword) return [...options]
  return options.filter((option) => option.name.toLowerCase().includes(keyword))
}

/** 勾选 / 取消勾选：返回新的完整名称数组（已选中则移除） */
export function toggleTagName(value: readonly string[], name: string): string[] {
  const target = normalizeTagInput(name)
  if (!target) return [...value]
  const key = tagKey(target)
  const index = value.findIndex((item) => tagKey(item) === key)
  if (index >= 0) return value.filter((_, position) => position !== index)
  return [...value, target]
}

/** 显式移除（语义比 toggle 直白，供「移除」入口使用） */
export function removeTagName(value: readonly string[], name: string): string[] {
  const key = tagKey(name)
  return value.filter((item) => tagKey(item) !== key)
}

export type AddTagError = 'empty' | 'duplicate' | null

export interface AddTagResult {
  /** 新的完整名称数组 */
  next: string[]
  /** 本次新增的名字；未新增时为 null */
  created: string | null
  /** 新增的名字不在标签库里（宿主可据此决定要不要建标签元数据） */
  isNew: boolean
  error: AddTagError
}

/**
 * 回车新建：
 *  - 空输入（或纯空白）→ error='empty'，不做任何改动；
 *  - 已在选中列表里（忽略大小写）→ error='duplicate'，不重复添加；
 *  - 其余 → 追加到末尾并返回 isNew（是否标签库里还没有这个名字）。
 */
export function addTagName(
  value: readonly string[],
  raw: string,
  all?: readonly TagLike[],
): AddTagResult {
  const name = normalizeTagInput(raw)
  if (!name) return { next: [...value], created: null, isNew: false, error: 'empty' }
  const key = tagKey(name)
  if (value.some((item) => tagKey(item) === key)) {
    return { next: [...value], created: null, isNew: false, error: 'duplicate' }
  }
  const known = (all ?? []).some((tag) => tagKey(tag.name) === key)
  return { next: [...value, name], created: name, isNew: !known, error: null }
}

/* ============================== 变体 ============================== */

const tagRowVariants = cva(
  [
    /* py-1 / px-2 = 4px / 8px，均在 DESIGN §2 间距刻度内（与 components/ui/menu.tsx 的菜单项一致） */
    'flex w-full items-center gap-2 rounded-zj-sm px-2 py-1 text-left text-ui',
    'transition-colors duration-150 ease-out zj-focus-ring',
    'disabled:pointer-events-none disabled:opacity-45',
  ].join(' '),
  {
    variants: {
      selected: {
        true: 'bg-selection text-text',
        false: 'bg-transparent text-text hover:bg-hover active:bg-selection',
      },
      kind: {
        tag: '',
        create: 'text-muted hover:text-text',
      },
    },
    defaultVariants: { selected: false, kind: 'tag' },
  },
)

/* 标签色点：12×12px 正方形 + rounded-full = **正圆色卡**。
   设计系统显式放行的例外（DESIGN §3 禁的是胶囊形与 >10px 容器圆角）：
   色点不是容器、不承载文字，且必须保持 w=h 才不会变成椭圆。
   颜色值来自数据（tag.color）行内 style，无颜色时用 bg-accent 兜底。 */
const colorDotVariants = cva('h-3 w-3 shrink-0 rounded-full border border-border', {
  variants: {
    /** 有数据颜色 → 用行内 style；没有 → accent 兜底 */
    fallback: { true: 'bg-accent', false: 'bg-transparent' },
  },
  defaultVariants: { fallback: false },
})

/* ============================== 组件 ============================== */

export interface TagPickerProps {
  /** 受控：当前已选中的标签名（宿主持有，通常是 note.tags） */
  value: readonly string[]
  /** 可勾选的标签库（名称 + 颜色）；缺省时至少把 value 里的标签渲染出来 */
  tags?: readonly TagLike[]
  /** 勾选 / 取消 / 新建 / 移除任意一项 → 返回**新的完整名称数组**（宿主负责落库） */
  onChange: (next: string[]) => void | Promise<void>
  /** 上下文提示（一般传笔记标题，便于确认改的是哪一篇） */
  context?: string
  /** 没有标签时的一句引导 */
  emptyHint?: string
  /** content-only 形态下的关闭回调（Dialog 形态由 DialogContent 自动处理） */
  onClose?: () => void
  /** 打开后是否聚焦搜索框（默认 true） */
  autoFocus?: boolean
  className?: string
  /** 列表最大高度（Tailwind 类），默认 max-h-52 */
  listClassName?: string
}

export function TagPicker({
  value,
  tags,
  onChange,
  context,
  emptyHint = '输入名字回车即可新建标签',
  onClose,
  autoFocus = true,
  className,
  listClassName,
}: TagPickerProps) {
  const [query, setQuery] = useState('')
  /** 本地草稿：立即反馈（不等宿主落库往返），宿主回写后自动同步 */
  const [draft, setDraft] = useState<string[]>(() => [...value])
  const [notice, setNotice] = useState<string | null>(null)

  const valueKey = value.join('\u0000')
  useEffect(() => {
    setDraft([...value])
  }, [valueKey])

  const options = useMemo(() => filterTagOptions(mergeTagCatalog(tags, draft), query), [tags, draft, query])
  const pendingName = normalizeTagInput(query)
  /**
   * 是否提供「新建」入口：名字非空、未选中，且**标签库里也没有同名**。
   * 库里已有的名字请直接勾选（回车也会勾选唯一候选），否则会出现「新建一个已存在的标签」这种误导。
   */
  const canCreate =
    pendingName.length > 0 &&
    !draft.some((item) => tagKey(item) === tagKey(pendingName)) &&
    !(tags ?? []).some((tag) => tagKey(tag.name) === tagKey(pendingName))

  const apply = (next: string[]) => {
    setDraft(next)
    void onChange(next)
  }

  const handleToggle = (option: TagOption) => {
    setNotice(null)
    apply(toggleTagName(draft, option.name))
  }

  const handleCreate = (raw: string) => {
    const result = addTagName(draft, raw, tags)
    if (result.error === 'empty') return
    if (result.error === 'duplicate') {
      setNotice('该标签已选中')
      return
    }
    setNotice(null)
    setQuery('')
    apply(result.next)
  }

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (canCreate) {
        handleCreate(query)
        return
      }
      // 回车且没有可新建的名字时：恰好只剩一个候选就勾选它
      if (options.length === 1) handleToggle(options[0]!)
      return
    }
    if (event.key === 'Backspace' && query.length === 0 && draft.length > 0) {
      event.preventDefault()
      apply(removeTagName(draft, draft[draft.length - 1]!))
      return
    }
    if (event.key === 'Escape' && onClose) {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      data-zj-tag-picker=""
      role="group"
      aria-label="标签选择"
      className={cn('flex w-full min-w-0 flex-col gap-2', className)}
    >
      <div className="flex items-center gap-2">
        <TagIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0 text-muted" aria-hidden />
        <span className="text-ui font-medium text-text">标签</span>
        {context ? (
          <span className="min-w-0 flex-1 truncate text-meta text-muted" title={context}>
            {context}
          </span>
        ) : null}
        {draft.length > 0 ? (
          <span className="shrink-0 font-mono text-2xs text-muted">已选 {draft.length}</span>
        ) : null}
      </div>

      <div className="relative">
        {/* 图标 left-3(12px) + 15px → 文字起点 pl-8(32px)，间距 5px；三者都在刻度内 */}
        <Search
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          data-autofocus={autoFocus ? true : undefined}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setNotice(null)
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder="搜索或输入新标签…"
          aria-label="搜索或新建标签"
          className="pl-8"
        />
      </div>

      <ScrollArea className={cn('min-h-0 rounded-zj-sm border border-border bg-surface', listClassName)}>
        {options.length === 0 ? (
          <EmptyState
            size="compact"
            icon={TagIcon}
            title={pendingName ? '没有匹配的标签' : '还没有任何标签'}
            description={pendingName ? `回车即可新建「${pendingName}」` : emptyHint}
          />
        ) : (
          <ul className="flex flex-col gap-1 p-1">
            {options.map((option) => (
              <li key={option.name} className="contents">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={option.selected}
                  // 显式命名：否则可读名会拼成「写作 未收录」（designer 复核建议）
                  aria-label={option.name}
                  data-zj-tag-option={option.name}
                  onClick={() => handleToggle(option)}
                  className={cn(tagRowVariants({ selected: option.selected }))}
                >
                  <span
                    className={cn(colorDotVariants({ fallback: option.color === null }))}
                    style={option.color ? { backgroundColor: option.color } : undefined}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.unlisted ? <span className="shrink-0 text-2xs text-muted">未收录</span> : null}
                  <Check
                    size={ICON_SIZE}
                    strokeWidth={ICON_STROKE}
                    className={cn('shrink-0', option.selected ? 'text-accent' : 'text-transparent')}
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      {canCreate ? (
        <button
          type="button"
          data-zj-tag-create={pendingName}
          onClick={() => handleCreate(query)}
          className={cn(tagRowVariants({ kind: 'create' }))}
        >
          <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">新建「{pendingName}」</span>
        </button>
      ) : null}

      <p className="text-2xs text-muted" aria-live="polite">
        {notice ?? emptyHint}
      </p>

      {onClose ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export interface TagPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前已选中的标签名（缺省为空数组） */
  value?: readonly string[]
  /** 可勾选的标签库；缺省时至少渲染 value 里的标签 */
  tags?: readonly TagLike[]
  /** 标签变更（新的完整数组）；缺省时面板只做展示，不落库 */
  onChange?: (next: string[]) => void | Promise<void>
  context?: string
  emptyHint?: string
  /** 对话框标题，默认「标签」 */
  title?: string
}

/** 自带 Dialog 外壳的标签面板（Esc / 点遮罩关闭、焦点锁在卡片内、关闭后焦点归还） */
export function TagPickerDialog({
  open,
  onOpenChange,
  value = [],
  tags,
  onChange,
  context,
  emptyHint,
  title = '标签',
}: TagPickerDialogProps) {
  const handleChange = useRef(onChange)
  handleChange.current = onChange

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="gap-2">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {context ? `正在编辑：${context}` : '勾选已有标签，或输入名字回车新建。'}
          </DialogDescription>
        </DialogHeader>
        <TagPicker
          value={value}
          tags={tags}
          emptyHint={emptyHint}
          onChange={(next) => handleChange.current?.(next)}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
