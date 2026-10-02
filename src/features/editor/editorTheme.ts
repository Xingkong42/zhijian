/**
 * CodeMirror 6 编辑器主题（全部用 --zj-* CSS 变量取值）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 关键设计：**一个主题对象，零色值字面量**。
 * CodeMirror 的样式注入（style-mod）接受任意 CSS 字符串，因此颜色直接写
 * `var(--zj-*)`；`themeStore` 切换主题只改 <html data-theme class>，浏览器重算变量，
 * 编辑器不需要 reconfigure / 重建 EditorView，也不产生任何 React 重渲染。
 * 字体与字号由宿主的 Tailwind 语义类（font-mono / text-editor）继承，避免重复定义。
 */

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** 设计刻度：编辑器正文左右留白 32px、上下 24px（docs/DESIGN.md §2） */
export const EDITOR_CONTENT_PADDING_Y = '24px'
export const EDITOR_CONTENT_PADDING_X = '32px'
/** 正文最大宽（docs/DESIGN.md §5：编辑器正文最大宽 760px 居中） */
export const EDITOR_CONTENT_MAX_WIDTH = '760px'

/**
 * 编辑器主题（浅深通用：所有取值都是会被 <html> 上 data-theme/class 影响的变量）。
 */
export function editorTheme(): Extension {
  return EditorView.theme({
    /* ---------------- 外框与滚动 ---------------- */
    '&': {
      height: '100%',
      color: 'var(--zj-text)',
      backgroundColor: 'transparent',
      /**
       * 编辑器**文字选区**的专用色（t55）。
       *
       * 为什么不直接用全局 `--zj-selection`：那个 token 还要承担侧栏选中项、标题栏 hover
       * 等"面状高亮"，必须保持淡雅；而文字选区**必须一眼可辨**。
       * 实测默认主题下它是 `#f0e3bc`、底色 `#fdf8ec`，对比度只有 **约 1.2** ——
       * 用户反馈「选中一段文字，被选中的文字不会反色显示或者反色与底色相同无法分辨」，
       * 就是对比度不足，而不是没有渲染。
       *
       * 这里用「该主题强调色 70% + 背景 30%」混合：任何主题/明暗下都与底色有明确区分，
       * 又不引入新色系（选中的文字色仍是 `--zj-text`，在混合后的底上依旧清晰）。
       */
      '--zj-editor-selection': 'color-mix(in srgb, var(--zj-accent) 70%, var(--zj-bg))',
    },
    '&.cm-focused': {
      // 焦点环由外层容器/内容区自己表达，编辑器本体不画 outline
      outline: 'none',
    },
    '.cm-scroller': {
      lineHeight: '1.75',
      overflow: 'auto',
      fontFamily: 'inherit',
    },
    '.cm-content': {
      maxWidth: EDITOR_CONTENT_MAX_WIDTH,
      margin: '0 auto',
      padding: `${EDITOR_CONTENT_PADDING_Y} ${EDITOR_CONTENT_PADDING_X}`,
      caretColor: 'var(--zj-accent)',
      minHeight: '100%',
    },
    '.cm-line': {
      padding: '0',
    },
    '.cm-placeholder': {
      color: 'var(--zj-text-muted)',
      fontStyle: 'normal',
    },

    /* ---------------- 光标与选区 ---------------- */
    '&.cm-focused .cm-cursor, .cm-cursor': {
      borderLeftColor: 'var(--zj-accent)',
      borderLeftWidth: '2px',
    },
    '.cm-dropCursor': {
      borderLeftColor: 'var(--zj-accent)',
      borderLeftWidth: '2px',
    },
    /*
     * ⚠️ 选区背景**必须 `!important`**：CodeMirror 的 baseTheme 里有两条自带选区色，特异性都远高于我们：
     *   · `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #d7d4f0 }` ← (0,6,0)
     *   · `&light .cm-selectionBackground { background: #d9d9d9 }`                                    ← (0,4,0)
     * 我们这种简写选择器（最多 (0,3,0)）**永远压不过它们**。
     * 实测（用真实 CM 实例量计算值）：聚焦时选区背景是 `rgb(215, 212, 240)` —— 正是那条 `#d7d4f0`，
     * 于是"选中了却只是一层几乎看不出的淡蓝"。用户反馈：「编辑栏内选中的文字完全看不出不同」
     * （预览与磁贴用的是另一套选区样式，所以那里正常）。
     */
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--zj-editor-selection) !important',
    },
    /* 失焦时的选区也要看得见（弱一档：同一个色 + 降透明度）—— 同样要压过 baseTheme */
    '&:not(.cm-focused) .cm-selectionBackground': {
      backgroundColor: 'var(--zj-editor-selection) !important',
      opacity: '0.6',
    },

    /* ---------------- 当前行 / 行号 ---------------- */
    '.cm-activeLine': {
      backgroundColor: 'var(--zj-hover)',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--zj-text-muted)',
      border: 'none',
      borderRight: '1px solid var(--zj-border)',
      paddingLeft: '4px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      fontSize: '12px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--zj-text)',
    },

    /* ---------------- Markdown 语法标记 ----------------
       类名由 markdownHighlight.ts 打在语法节点上，这里只负责外观。 */
    '.zj-md-heading': {
      color: 'var(--zj-text)',
      fontWeight: '600',
    },
    '.zj-md-heading-mark': {
      color: 'var(--zj-text-muted)',
      fontWeight: '400',
    },
    '.zj-md-strong': {
      color: 'var(--zj-text)',
      fontWeight: '600',
    },
    '.zj-md-em': {
      fontStyle: 'italic',
    },
    '.zj-md-strike': {
      color: 'var(--zj-text-muted)',
      textDecoration: 'line-through',
    },
    '.zj-md-inline-code': {
      color: 'var(--zj-accent)',
    },
    '.zj-md-code-text': {
      color: 'var(--zj-text)',
    },
    '.zj-md-code-info': {
      color: 'var(--zj-text-muted)',
      fontStyle: 'italic',
    },
    '.zj-md-fenced': {
      color: 'var(--zj-text-muted)',
    },
    '.zj-md-punct': {
      color: 'var(--zj-text-muted)',
    },
    '.zj-md-link': {
      color: 'var(--zj-accent)',
    },
    '.zj-md-url': {
      color: 'var(--zj-text-muted)',
      textDecoration: 'underline',
    },
    '.zj-md-quote': {
      color: 'var(--zj-text-muted)',
      fontStyle: 'italic',
    },
    '.zj-md-quote-mark': {
      color: 'var(--zj-accent)',
    },
    '.zj-md-list-mark': {
      color: 'var(--zj-accent)',
    },
    '.zj-md-rule': {
      color: 'var(--zj-text-muted)',
    },
    '.zj-md-task': {
      color: 'var(--zj-accent)',
      fontWeight: '600',
    },
    '.zj-md-table-cell': {
      color: 'var(--zj-text)',
    },

    /* ---------------- Live Preview 就地渲染（t16） ----------------
       类名由 livePreview.ts 打在非光标行的内容/行上：标记符被隐藏，
       这里只负责「看起来像渲染后的 Markdown」。字号沿用 MarkdownPreview 的映射
       （h1 18 / h2 15 / h3 14 / h4-6 13），保证编辑态与预览态观感一致。 */
    '.zj-lp-h1': {
      fontSize: '18px',
      fontWeight: '600',
      lineHeight: '1.6',
    },
    '.zj-lp-h2': {
      // 刻意不写 fontSize：跟随宿主的 text-editor（= var(--zj-font-content)，t17 的运行时档位），
      // 与预览态 MarkdownPreview 的 h2（text-editor）保持像素级一致。
      fontWeight: '600',
    },
    '.zj-lp-h3': {
      fontSize: '14px',
      fontWeight: '600',
    },
    '.zj-lp-h4, .zj-lp-h5, .zj-lp-h6': {
      fontSize: '13px',
      fontWeight: '600',
      color: 'var(--zj-text-muted)',
    },
    '.zj-lp-strong': {
      fontWeight: '600',
      color: 'var(--zj-text)',
    },
    '.zj-lp-em': {
      fontStyle: 'italic',
    },
    '.zj-lp-strike': {
      color: 'var(--zj-text-muted)',
      textDecoration: 'line-through',
    },
    '.zj-lp-code': {
      color: 'var(--zj-text)',
      backgroundColor: 'var(--zj-surface-2)',
      border: '1px solid var(--zj-border)',
      borderRadius: '6px',
      padding: '0 4px',
    },
    '.zj-lp-link': {
      color: 'var(--zj-accent)',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    },
    '.zj-lp-url': {
      color: 'var(--zj-text-muted)',
      fontSize: '12px',
      marginLeft: '4px',
    },
    '.zj-lp-quote': {
      borderLeft: '2px solid var(--zj-accent)',
      paddingLeft: '8px',
      color: 'var(--zj-text-muted)',
      fontStyle: 'italic',
    },
    '.zj-lp-bullet': {
      color: 'var(--zj-accent)',
      marginRight: '4px',
    },
    '.zj-lp-number': {
      color: 'var(--zj-text-muted)',
      marginRight: '4px',
    },
    '.zj-lp-checkbox': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '12px',
      height: '12px',
      marginRight: '4px',
      border: '1px solid var(--zj-border)',
      borderRadius: '4px',
      fontSize: '11px',
      lineHeight: '1',
      verticalAlign: 'text-bottom',
      color: 'var(--zj-accent-fg)',
    },
    ".zj-lp-checkbox[data-checked='true']": {
      backgroundColor: 'var(--zj-accent)',
      borderColor: 'var(--zj-accent)',
    },
    '.zj-lp-hr': {
      display: 'inline-block',
      width: '100%',
      borderTop: '1px solid var(--zj-border)',
      verticalAlign: 'middle',
    },
    '.zj-lp-hr-line': {
      color: 'var(--zj-text-muted)',
    },
  })
}
