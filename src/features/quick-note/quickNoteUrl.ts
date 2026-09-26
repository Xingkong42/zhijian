/**
 * 快速笔记窗口的 URL 协议与文案常量（**纯函数，无 React / 无 Tauri 依赖**）。
 * 归属：编辑器成员（任务 t44）。
 *
 * 与 `features/tiles/tileUrl.ts` 同一套路（那份文件里解释了为什么要单独成文件：
 * 主入口只需要一个纯函数就能判定渲染哪个界面，且该函数可在 Node 里直接断言）。
 * 差异：磁贴参数带 noteId（一个窗口一条笔记），快速笔记只是一个**开关**
 * （`?quick=1`），因为窗口里没有"哪条笔记"这个概念 —— 它是用来**新建**的。
 */

/** URL 查询参数名（与 Rust `src-tauri/src/quick_note.rs` 的 `QUICK_NOTE_QUERY_KEY` 一致） */
export const QUICK_NOTE_QUERY_KEY = 'quick'

/** 快速笔记窗口 label（与 Rust `QUICK_NOTE_LABEL` 一致，也是 capability 的匹配值） */
export const QUICK_NOTE_WINDOW_LABEL = 'quick-note'

/** 窗口标题（无边框窗口不显示标题，任务栏/无障碍仍需要） */
export const QUICK_NOTE_WINDOW_TITLE = '纸笺 · 快速笔记'

/** 输入框占位符 */
export const QUICK_NOTE_PLACEHOLDER = '随手记一笔…'

/** t46：标题框占位符（留空时按正文首个非空行推断 —— 明确写出来，用户才知道可以留空） */
export const QUICK_NOTE_TITLE_PLACEHOLDER = '标题（可留空）'

/** 底部操作提示 */
export const QUICK_NOTE_HINT = 'Enter 保存 · Shift+Enter 换行 · Esc 取消'

/** 保存失败时展示的兜底前缀（数据库不可用等） */
export const QUICK_NOTE_SAVE_ERROR_TITLE = '保存失败'

/** 空内容按 Enter 时的提示（不建空笔记，但必须给可读反馈） */
export const QUICK_NOTE_EMPTY_HINT = '还没有内容 —— 写点什么再保存。'

/** 无标题笔记的兜底标题（与主窗口「新建笔记」的默认一致） */
export const QUICK_NOTE_UNTITLED = '无标题'

/**
 * 当前 URL 是否应该渲染快速笔记视图。
 *
 * 规则（自检逐条断言）：
 *  - 允许带或不带前导 `?`；
 *  - 没有 `quick` 参数 → false；
 *  - **值必须归一化后等于 `1`/`true`/空串之一才算命中**：`?quick=0`、`?quick=false`
 *    必须判 **false**（写错值时宁可回落主界面，也不要把主界面渲染成捕捉框）；
 *  - 大小写不敏感（`?QUICK=1` 也算，`URLSearchParams` 的键名是大小写敏感的，
 *    这里显式做一次大小写归一，避免 Rust 侧改大小写后前端静默失效）。
 */
export function readQuickNoteFlag(search: string): boolean {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (!raw) return false

  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return false
  }

  let value: string | null = null
  for (const [key, raw_value] of params) {
    if (key.toLowerCase() === QUICK_NOTE_QUERY_KEY) {
      value = raw_value
      break
    }
  }
  if (value === null) return false

  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === '1' || normalized === 'true'
}

/** 快速笔记窗口要加载的完整 URL（自检 / 调试用；Rust 侧另有等价实现） */
export function quickNoteWindowUrl(origin: string, pathname: string): string {
  return `${origin}${pathname}?${QUICK_NOTE_QUERY_KEY}=1`
}

/**
 * 从输入内容推断标题：取**第一行非空文本**，截到 40 个字符。
 *
 * 为什么需要：快速笔记只有一个输入框（不逼用户先起标题），但笔记必须有标题
 * （它同时是 vault 里 md 的文件名）。取首行是最符合直觉的推断：用户敲的
 * 第一句通常就是要表达的事。全是空白时回落 `QUICK_NOTE_UNTITLED`。
 */
export function titleFromQuickContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return QUICK_NOTE_UNTITLED
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}
