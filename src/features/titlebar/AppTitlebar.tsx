/**
 * AppTitlebar —— 兼容别名（骨架期由架构师创建，名字出现在 src/App.tsx 的 import 里）。
 *
 * 正式组件是 `./Titlebar` 的具名导出 `Titlebar`（docs/ARCHITECTURE.md §4.4 冻结命名）。
 * 本文件只做转发，保证骨架版 App.tsx 不改一行也能继续构建；
 * 集成成员（t7）把 App.tsx 切到 `import { Titlebar } from '@/features/titlebar'` 后，
 * 本文件可以整体删除。
 */

export { Titlebar as AppTitlebar } from './Titlebar'
