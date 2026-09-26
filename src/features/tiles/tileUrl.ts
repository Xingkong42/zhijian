/**
 * 磁贴窗口的 URL 协议与命名约定（**纯函数，无 React / 无 Tauri 依赖**）。
 * 归属：编辑器成员（任务 t24）。
 *
 * 为什么单独成文件：
 *  1. 主入口（`src/main.tsx`，architect 所有）只需要一个「读 URL 参数」的纯函数就能判定
 *     该渲染主界面还是磁贴界面 —— 本文件就是那份契约；
 *  2. 纯函数 = 可在 Node 里直接断言（见 `__checks__/run-checks.mjs`），
 *     也能被自检页复用，不需要浏览器或 Tauri。
 *
 * URL 协议（captain t24 定死）：
 *   磁贴窗口加载**同一份前端**，url 带 `?tile=<noteId>`，每个窗口只渲染一个 noteId。
 *   例：`tauri://localhost/?tile=3f1c...`（标签 `tile-3f1c...`）
 */

/** URL 查询参数名 */
export const TILE_QUERY_KEY = 'tile'

/** 磁贴窗口 label 前缀（与 capabilities 里的 `tile-*` 匹配规则对应） */
export const TILE_WINDOW_PREFIX = 'tile-'

/** 磁贴窗口标题（无边框窗口不显示标题，但任务栏/无障碍仍需要） */
export const TILE_WINDOW_TITLE = '纸笺 · 磁贴'

/** 磁贴里的自动保存延时（与主编辑器一致，契约区间 400–600ms） */
export const TILE_AUTO_SAVE_DELAY_MS = 500

/** noteId 失效（笔记被删/不存在）时的文案 */
export const TILE_MISSING_NOTE_TITLE = '这条笔记不在了'
export const TILE_MISSING_NOTE_HINT = '它可能已被删除或移入回收站。关闭磁贴即可。'

/** 读取失败（例如数据库不可用）时的文案前缀 */
export const TILE_LOAD_ERROR_TITLE = '读不到这条笔记'

/**
 * 从 `location.search` 里读磁贴的 noteId。
 *
 * 规则（自检脚本逐条断言）：
 *  - 允许带或不带前导 `?`；
 *  - 没有 `tile` 参数 → null（主界面应当渲染正常 App）；
 *  - 空值 / 纯空白 → null；
 *  - 多个参数时按名字取，不受顺序影响；
 *  - **非法百分号编码 → null**：`URLSearchParams` 对畸形编码不抛错，而是插入 U+FFFD 替换符，
 *    这种值一定是脏的，直接判无效比把乱码当 id 更安全；
 *  - 边界说明（已断言）：URLSearchParams 对「截断的转义」（如 `note%2`）是**原样保留**、
 *    既不抛错也不插 U+FFFD —— 这种值匹配不到任何笔记，会自然落到「这条笔记不在了」，
 *    因此不做额外校验（也避免误伤 `%2520` 这类合法双重编码）；
 *  - 大小写敏感（`TILE` 不算），避免与将来可能的其它参数冲突。
 */
export function readTileNoteId(search: string): string | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (!raw) return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return null
  }

  const value = params.get(TILE_QUERY_KEY)
  if (value === null) return null

  const id = value.trim()
  if (!id) return null
  if (id.includes('\uFFFD')) return null
  return id
}

/**
 * noteId → 磁贴窗口 label。
 *
 * Tauri 的 window label 只允许字母/数字与 `-`、`/`、`:`、`_`（其余字符非法），
 * 因此这里做一次白名单替换。笔记 id 是全项目统一的 `crypto.randomUUID()`
 * （十六进制 + 连字符），本来就完全合法，这个函数只是兜底。
 */
export function tileWindowLabel(noteId: string): string {
  const safe = noteId.trim().replace(/[^A-Za-z0-9\-_:/]/g, '_')
  return `${TILE_WINDOW_PREFIX}${safe}`
}

/** 磁贴窗口要加载的完整 URL（同源同路径，只加 `?tile=` 参数） */
export function tileWindowUrl(noteId: string, origin: string, pathname: string): string {
  return `${origin}${pathname}?${TILE_QUERY_KEY}=${encodeURIComponent(noteId)}`
}

/** 只取 query 片段（自检页 / 调试用） */
export function tileUrlSearch(noteId: string): string {
  return `?${TILE_QUERY_KEY}=${encodeURIComponent(noteId)}`
}

/** 主窗口判定：当前 URL 是否应该渲染磁贴视图 */
export function isTileLocation(search: string): boolean {
  return readTileNoteId(search) !== null
}
