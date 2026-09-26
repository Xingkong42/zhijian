/**
 * src/features/quick-note —— 快速笔记捕捉框（t44）。
 * 归属：编辑器成员（窗口内 UI）+ 系统集成（窗口创建，见 `src-tauri/src/quick_note.rs`）。
 *
 * 交付物：
 *   - `QuickNoteApp.tsx`   捕捉框本体（导出 `QuickNoteApp`，props 为 `QuickNoteAppProps`）
 *   - `quickNoteUrl.ts`    URL 协议 + 文案 + 纯函数（主入口路由用，可在 Node 里断言）
 *
 * 接入方式（与磁贴完全对称）：
 *   Rust 创建 label = `quick-note` 的窗口，URL 带 `?quick=1`；
 *   `src/main.tsx` 依 `readQuickNoteFlag(location.search)` 决定渲染本组件还是 `<App />`。
 *   **不要在 `<App />` 内部做这个判定**：捕捉框不能跑主窗口的启动序列
 *   （initDb + 四个仓储 + notesStore.init + 全局热键订阅），否则它就不是"单独的记录框"了。
 */

export { QuickNoteApp, defaultSaveQuickNote, type QuickNoteAppProps } from './QuickNoteApp'
export { quickNoteKeyAction, type QuickNoteKeyAction, type QuickNoteKeyInput } from './quickNoteKeys'
export {
  QUICK_NOTE_EMPTY_HINT,
  QUICK_NOTE_HINT,
  QUICK_NOTE_PLACEHOLDER,
  QUICK_NOTE_QUERY_KEY,
  QUICK_NOTE_SAVE_ERROR_TITLE,
  QUICK_NOTE_UNTITLED,
  QUICK_NOTE_WINDOW_LABEL,
  QUICK_NOTE_WINDOW_TITLE,
  quickNoteWindowUrl,
  readQuickNoteFlag,
  titleFromQuickContent,
} from './quickNoteUrl'

/** 目录锚点（与其它 feature 的 index.ts 保持同一形态） */
export const QUICK_NOTE_FEATURE = 'src/features/quick-note' as const
