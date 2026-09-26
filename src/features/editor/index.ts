/**
 * src/features/editor —— Markdown 实时编辑与预览（归属：编辑器成员，见 docs/ARCHITECTURE.md §5）。
 *
 * 对外入口：
 *   - `EditorPane`         面板（编辑/分栏/预览三态 + 标题条 + **格式化工具栏** + 防抖自动保存），
 *                          props 兼容冻结契约 `EditorPaneProps`（+ 若干可选扩展）
 *   - `MarkdownToolbar`    t16 新增：一行图标按钮的 Markdown 格式化工具栏
 *   - `CodeMirrorEditor`   CodeMirror 6 封装（**Live Preview**、CSS 变量主题、常用快捷键）
 *   - `MarkdownPreview`    react-markdown + remark-gfm 预览（代码块交给 Shiki）
 *   - `CodeBlock`          Shiki 代码块（细粒度按需加载 + 双主题 CSS 变量）
 *   - `EditorEmpty`        未选中笔记时的淡雅空状态
 *   - `useAutoSave`        防抖自动保存（换笔记不串写，见同目录 README.md）
 *   - `markdownCommands`   **纯函数**命令层（工具栏/快捷键共用，可在 Node 里断言）
 *   - `livePreview`        Live Preview 装饰构建（纯函数 + ViewPlugin）
 *
 * 集成与约定见同目录 `README.md`；自检见 `__checks__/run-checks.mjs`。
 */

export { EditorPane, contentStats } from './EditorPane'
export type {
  ContentStats,
  EditorMode,
  EditorPaneComponentProps,
  EditorSaveState,
} from './EditorPane'

export { CodeMirrorEditor } from './CodeMirrorEditor'
export type { CodeMirrorEditorHandle, CodeMirrorEditorProps } from './CodeMirrorEditor'

export { MarkdownToolbar } from './MarkdownToolbar'
export type { MarkdownToolbarProps } from './MarkdownToolbar'

export {
  CODE_BLOCK_PLACEHOLDER,
  MARKDOWN_COMMANDS,
  TABLE_PLACEHOLDER,
  TABLE_SKELETON,
  applyMarkdownCommand,
  codeBlockSpec,
  horizontalRuleSpec,
  inlineWrapSpec,
  linkSpec,
  markdownCommandSpec,
  tableSpec,
} from './markdownCommands'
export type { MarkdownCommandId } from './markdownCommands'

export {
  EMPTY_TOOLBAR_STATE,
  TOOLBAR_ALL_COMMANDS,
  TOOLBAR_BLOCK_COMMANDS,
  TOOLBAR_INLINE_COMMANDS,
  computeToolbarState,
  runMarkdownCommand,
  runRedo,
  runUndo,
  toolbarSignature,
} from './markdownToolbarState'
export type { MarkdownToolbarState } from './markdownToolbarState'

export {
  buildLivePreviewDecorations,
  countDecorationsIn,
  describeDecorations,
  listDecorations,
  livePreview,
  livePreviewBuildCount,
  parseLineRender,
} from './livePreview'
export type { DecorationEntry, DecorationStats, LineRender } from './livePreview'

export { MarkdownPreview, PREVIEW_REMARK_PLUGINS } from './MarkdownPreview'
export type { MarkdownPreviewProps } from './MarkdownPreview'

export { CodeBlock } from './CodeBlock'
export type { CodeBlockProps } from './CodeBlock'

export { EditorEmpty } from './EditorEmpty'
export type { EditorEmptyProps } from './EditorEmpty'

export { DEFAULT_AUTO_SAVE_DELAY_MS, useAutoSave } from './useAutoSave'
export type {
  AutoSaveController,
  AutoSavePayload,
  AutoSaveStatus,
  UseAutoSaveOptions,
} from './useAutoSave'

export {
  LANG_FILES,
  LANG_LABELS,
  SHIKI_DARK_THEME,
  SHIKI_FALLBACK_LANG,
  SHIKI_LIGHT_THEME,
  getHighlighter,
  highlighterStats,
  highlightCode,
  langLabel,
  normalizeLang,
  preloadHighlighter,
} from './shikiHighlighter'
export type { HighlightResult, SupportedLang } from './shikiHighlighter'

export { MD_CLASS_PREFIX, markdownClassForNode, markdownHighlight } from './markdownHighlight'
export { EDITOR_CONTENT_MAX_WIDTH, editorTheme } from './editorTheme'

/** 目录锚点（保留，避免历史 import 断裂） */
export const EDITOR_FEATURE = 'src/features/editor' as const
