/**
 * src/features/tiles —— 桌面便签磁贴（任务 t24，归属：编辑器成员）。
 *
 * 磁贴 = 把一条笔记钉成桌面上无边框、置顶的小窗；**窗口本身**由 Rust 侧（t19）创建，
 * 本目录只负责「窗口里渲染什么」+ 主窗口侧的「钉住这条笔记」薄封装。
 *
 * 对外入口：
 *   - `TileApp`            磁贴视图（标题 + 正文 + 自动保存 + 关闭/打开主窗口）
 *   - `readTileNoteId()`   主入口判定用纯函数（`?tile=<noteId>`）
 *   - `toggleTileForNote()` 主窗口侧薄封装（Rust 命令未就绪时自动退化）
 *
 * 接入方式见同目录 README.md。
 */

export {
  TileApp,
  defaultLoadTileNote,
  defaultSaveTileNote,
  defaultLoadTilePinned,
  defaultSaveTilePinned,
  defaultLoadTileGroup,
  defaultUngroupTile,
} from './TileApp'
export type { TileAppProps } from './TileApp'

export {
  TILE_AUTO_SAVE_DELAY_MS,
  TILE_LOAD_ERROR_TITLE,
  TILE_MISSING_NOTE_HINT,
  TILE_MISSING_NOTE_TITLE,
  TILE_QUERY_KEY,
  TILE_WINDOW_PREFIX,
  TILE_WINDOW_TITLE,
  isTileLocation,
  readTileNoteId,
  tileUrlSearch,
  tileWindowLabel,
  tileWindowUrl,
} from './tileUrl'

export {
  TILE_FALLBACK_WINDOW,
  TILE_RUST_COMMANDS,
  closeTileForNote,
  isTileWindowOpen,
  listTileNoteIds,
  listTiles,
  setAllTilesVisible,
  setTilePinned,
  toggleTileForNote,
  ungroupTile,
} from './tileWindows'
export type { TileSummary, TileToggleAction, TileToggleResult } from './tileWindows'

/** 目录锚点 */
export const TILES_FEATURE = 'src/features/tiles' as const
