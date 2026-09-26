# src/features —— 业务功能区（归属见 docs/ARCHITECTURE.md §5）

每个子目录是一个 feature 切片，**只允许**依赖 `src/store/**`、`src/components/ui/**`、
`src/lib/**`、`src/types/**`；禁止跨 feature 互相 import（需要共享的组合逻辑请上提到
`src/App.tsx`（集成成员）或 `src/lib/**`（架构师））。

| 目录 | 归属 | 负责交付 |
| --- | --- | --- |
| `titlebar/` | 标题栏/托盘成员 | 无边框窗口自定义标题栏（`Titlebar` + `TitlebarProps`） |
| `sidebar/` | 侧栏成员 | 导航、文件夹树、标签列表、搜索框（`Sidebar` + `SidebarProps`） |
| `notes-list/` | 列表成员 | 笔记列表、置顶、@dnd-kit 拖拽排序（`NoteList` + `NoteListProps`） |
| `editor/` | 编辑器成员 | CodeMirror 6 编辑 + Markdown 预览 + Shiki 高亮 + 导出（`EditorPane` + `EditorPaneProps`） |
| `settings/` | 设置/主题成员 | 主题选择、明暗切换、关闭到托盘偏好、关于（`SettingsPanel` + `SettingsPanelProps`） |

## 骨架期状态

当前仅 `titlebar/` 内有架构师提供的骨架实现（`AppTitlebar.tsx` + `useTitlebarState.ts`）。
其余目录由对应成员在各自任务中新建文件，**接口以 `src/types/index.ts` 的 props 类型为准**。

## 写文件前的三步自检

1. 我的 props 是否与 `src/types/index.ts` 中的 `XxxProps` 完全一致？
2. 我是否引入了 `#RRGGBB` / Tailwind 内置调色板类？（禁止，见 docs/DESIGN.md）
3. 我是否 import 了别人的 feature 目录？（禁止）
