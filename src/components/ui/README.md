# src/components/ui —— 纸笺基础组件层（任务 t2 交付）

> 归属：设计系统成员 · 契约来源：`docs/ARCHITECTURE.md` §4.5 / `docs/DESIGN.md`
> 统一入口：`import { Button, IconButton, Dialog, useToast } from '@/components/ui'`
> 主题原理：颜色全部是 CSS 变量（`--zj-*`）。切主题只改 `<html data-theme class>`，
> **组件不需要任何主题相关 props，也不会因切主题重渲染。**

## 红线（评审会查）

1. 本目录禁止 `import` `src/store`、`src/db`、`src/features`。
2. 禁止十六进制色值 / `rgb()` / `hsl()` 字面量，也禁止 Tailwind 内置调色板类（各族色阶的 `bg-`/`text-`/`border-` 类）。
   颜色只用：`bg-bg` `bg-surface` `bg-surface-2` `text-text` `text-muted` `bg-accent` `text-accent-fg`
   `border-border` `bg-hover` `bg-selection`（别名：`bg-zj-surface`、`text-zj-text` …）。
3. 圆角：`rounded-zj-sm`(6px 小控件) / `rounded-zj`(8px 卡片·面板·列表项) / `rounded-zj-lg`(10px 上限)。
4. 阴影只用 `shadow-zj`；不做抬升、渐变、玻璃拟态、发光。
5. 间距只用 4/8/12/16/24/32 对应刻度（`p-1 p-2 p-3 p-4 p-6 p-8`）。
6. 图标一律 lucide-react，`size={ICON_SIZE}`(15) + `strokeWidth={ICON_STROKE}`(1.75)。
7. 交互四态必须有可见反馈：`hover:` / `active:` / `zj-focus-ring` / `disabled:opacity-45`。

## 组件清单与 API

| 组件 | 文件 | 关键 props |
| --- | --- | --- |
| `Button` | `button.tsx` | `variant: default\|secondary\|outline\|ghost\|subtle\|link`、`size: sm\|md\|lg\|icon-sm\|icon\|icon-lg`、`icon?: LucideIcon` |
| `IconButton` | `button.tsx` | `icon`（必填）、`label`（必填，a11y）、`tooltip?: boolean\|string`、`iconSize?` |
| `Input` | `input.tsx` | 原生 props + `inputSize: sm\|md\|lg`、`bare`（面板内联编辑） |
| `Textarea` | `textarea.tsx` | 原生 props + `textareaSize`、`rows` |
| `Switch` | `switch.tsx` | `checked`/`defaultChecked`/`onCheckedChange`、`size`、`label` |
| `Separator` | `separator.tsx` | `orientation: horizontal\|vertical` |
| `ScrollArea` | `scroll-area.tsx` | `orientation: vertical\|horizontal\|both`、`padding` |
| `Badge` | `badge.tsx` | `variant: default\|muted\|outline\|accent`、`size: sm\|md\|count`（计数胶囊） |
| `Kbd` | `badge.tsx` | 快捷键展示，如 `<Kbd>Ctrl</Kbd>` |
| `Tabs*` | `tabs.tsx` | `Tabs(variant: line\|pill, value, onValueChange)` + `TabsList` / `TabsTrigger(value)` / `TabsContent(value)` |
| `Dialog*` | `dialog.tsx` | `Dialog(open, onOpenChange, dismissOnOverlayClick)` + `DialogContent(size: sm\|md\|lg)` + `DialogHeader/Title/Description/Footer/DialogClose` |
| `DropdownMenu` | `dropdown-menu.tsx` | `trigger: ReactNode`、`items: MenuItemDef[]`、`align: start\|center\|end`、`side`、`className`（触发器包裹层） |
| `ContextMenu` | `context-menu.tsx` | `items: MenuItemDef[]`、`children`、`className`（默认 `contents`，不参与布局） |
| `Tooltip` | `tooltip.tsx` | `content`、`children`、`side`、`align`、`delay` |
| `EmptyState` | `empty-state.tsx` | `icon?: LucideIcon`、`title`、`description`、`action`、`size: default\|compact` |
| `TagPicker` / `TagPickerDialog` | `tag-picker.tsx` | `value`（已选标签名）、`tags?`（标签库：名称+颜色）、`onChange(next)`、`context?`、`emptyHint?`、`onClose?`；Dialog 形态另加 `open`/`onOpenChange`/`title?`。**纯 props 驱动、不 import store/db**，落库由宿主负责；纯逻辑 `mergeTagCatalog / filterTagOptions / toggleTagName / addTagName / removeTagName / normalizeTagInput / tagColorOf` 可单测 |
| `ToastProvider` / `useToast` / `Toaster` | `toast.tsx` | 见下 |

### 菜单条目 `MenuItemDef`

```ts
{
  id?: string              // 动态列表请给稳定 id
  label: ReactNode
  icon?: LucideIcon
  shortcut?: string        // 右侧快捷键提示
  disabled?: boolean
  heading?: boolean        // 分组标题（不可点击）
  separatorBefore?: boolean
  onSelect?: () => void
}
```

### 复制即用的范例

```tsx
// 1) 标题栏/工具栏按钮
<IconButton icon={Plus} label="新建笔记 (Alt+N)" tooltip />
<Button variant="default" icon={Download} onClick={onExport}>导出</Button>

// 2) 列表项右键菜单
<ContextMenu items={[
  { id: 'pin', label: '置顶', icon: Pin, onSelect: () => onTogglePin(note.id) },
  { id: 'move', label: '移动到…', icon: FolderInput, separatorBefore: true, onSelect: openMove },
  { id: 'del', label: '移到回收站', icon: Trash2, shortcut: 'Ctrl+Del', onSelect: () => onRemove(note.id) },
]}>
  <li>{note.title}</li>
</ContextMenu>

// 3) 设置面板主题选择（主题值只来自 THEMES / themeList，不要手写色值）
<Tabs value={mode} onValueChange={(v) => onSetMode(v as ThemeMode)}>
  <TabsList><TabsTrigger value="light">浅色</TabsTrigger><TabsTrigger value="dark">深色</TabsTrigger></TabsList>
</Tabs>

// 4) 通知（App 根节点包一层 <ToastProvider>）
const { toast } = useToast()
toast({ title: '导出成功', description: 'paper-note.md', variant: 'success' })

// 5) 标签选择面板（宿主负责落库：onChange 拿到的是**新的完整名称数组**）
<TagPickerDialog
  open={tagOpen}
  onOpenChange={setTagOpen}
  value={note.tags}
  tags={allTags}                      // tagsRepo.list() 的结果（名称 + 颜色）
  context={note.title}
  onChange={(next) => notesStore.update(note.id, { tags: next })}
/>
```

## 已验证行为（t2 自检）

- `pnpm typecheck` / `pnpm vite build` 通过。
- 浏览器实测：切 `data-theme` + `.dark` 只改变 CSS 变量，组件 DOM 与类名不变（零主题逻辑）。
- `grep` 自证：本目录无 `#` 开头的十六进制色值与内置调色板类。
