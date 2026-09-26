/**
 * src/features/settings —— 设置面板 + 系统集成偏好（归属：系统集成 / t6 + t13 + t17，
 * 见 docs/ARCHITECTURE.md §4.4 / §4.13 / §5、docs/DESIGN.md）。
 *
 * 交付物：
 *   - `SettingsPanel.tsx`      设置面板本体（导出 `SettingsPanel`，props 为 `SettingsPanelProps`）
 *   - `ThemePicker.tsx`        五套主题色卡预览（色值只来自 `themeList` = THEMES）
 *   - `ModeToggle.tsx`         明暗模式切换
 *   - `dataTransfer.ts`        导出 / 导入全部数据（plugin-dialog + plugin-fs，经 db 仓储落库）
 *   - `closeToTray.ts`         「关闭到托盘」偏好下发 + 隐藏提示判定（§4.13 唯一接线处）
 *   - `CloseToTrayNotice.tsx`  启动同步 + 订阅 WINDOW_HIDDEN 弹「已最小化到系统托盘」
 *   - `shortcuts.ts`           自定义全局快捷键（解析/校验/冲突/持久化/下发 Rust，t17）
 *   - `ShortcutRecorder.tsx`   键位录入控件（t17）
 *   - `vaultData.ts`           数据目录 / 备份 / 索引状态与重建（t17，只读消费 t15 能力）
 *
 * 挂载方式（二选一，契约字段一致）：
 *   1. 自连：`<SettingsPanel />` —— 读 `uiStore.settingsOpen`，自带 Dialog 外壳；
 *   2. 受控：传全部 `SettingsPanelProps` + `standalone`，由调用方提供 Dialog 外壳。
 *
 * **集成层必做**（§4.13）：在 `<ToastProvider>` 内挂一次 `<CloseToTrayNotice />`，
 * 否则「关闭到托盘」偏好在重启后丢失、且隐藏时用户得不到任何反馈。
 *
 * **正文字号（t17）**：只改 CSS 变量 `--zj-font-content`（设计系统的排版 token），
 * 编辑器与预览的 `text-editor` 立即跟随，无需组件参与。
 *
 * 依赖方向（红线）：只向下依赖 `src/store/**`、`src/components/ui/**`、`src/lib/**`、
 * `src/db/**`（dataTransfer 经仓储读写；vaultData 只读 t15 的 storage/vault/indexer 公开能力），
 * **不 import 其它 feature**。
 */

export {
  SettingsPanel,
  type SettingsPanelExtendedProps,
  type PanelNotice,
  type PanelNotify,
} from './SettingsPanel'
export { ThemePicker, type ThemePickerProps } from './ThemePicker'
export { ModeToggle, type ModeToggleProps } from './ModeToggle'
export { ShortcutRecorder, type ShortcutRecorderProps } from './ShortcutRecorder'
export {
  DEFAULT_SHORTCUT_BINDINGS,
  LOCAL_FALLBACK_NOTE,
  SHORTCUT_ACTIONS,
  SHORTCUT_EVENT_BY_ACTION,
  acceleratorFromEvent,
  activeBindings,
  dispatchShortcutEvent,
  findConflict,
  formatAccelerator,
  normalizeAccelerator,
  parseAccelerator,
  parseSyncResponse,
  readShortcutBindings,
  shortcutDefinition,
  syncGlobalShortcuts,
  syncShortcutBindingsOnStartup,
  validateAccelerator,
  writeShortcutBindings,
  type ShortcutActionDefinition,
  type ShortcutActionId,
  type ShortcutBinding,
  type ShortcutBindings,
  type ShortcutSyncResult,
  type ShortcutTriggerHandlers,
} from './shortcuts'
export {
  BACKUP_UNAVAILABLE_HINT,
  VAULT_UNAVAILABLE_HINT,
  backupVault,
  backupVaultInto,
  defaultBackupDirName,
  importNotesFromDialog,
  openVaultInFileManager,
  pickBackupDirectory,
  readIndexStatus,
  readVaultLocation,
  rebuildVaultIndex,
  relocateSupport,
  tryReadVaultLocation,
  type BackupOutcome,
  type ImportNotesOutcome,
  type IndexStatus,
  type RebuildOutcome,
  type VaultLocation,
} from './vaultData'
export {
  AUTOSTART_UNAVAILABLE_HINT,
  applyAutostart,
  autostartDrift,
  markStartMinimizedTouched,
  readSystemAutostart,
  setSystemAutostart,
  type AutostartApplyResult,
  type AutostartDrift,
  type AutostartSystemState,
  type AutostartToggleResult,
} from './autostart'
export { CloseToTrayNotice, type CloseToTrayNoticeProps } from './CloseToTrayNotice'
export {
  CLOSE_TO_TRAY_NOTICE_TITLE,
  closeToTrayNoticeText,
  isPreferenceDrifted,
  openCloseToTrayNotice,
  readRustPreference,
  shouldShowCloseToTrayNotice,
  storedCloseToTray,
  syncCloseToTrayPreference,
  type CloseToTrayNoticeHandlers,
  type CloseToTrayNoticeOptions,
  type PreferenceSyncResult,
} from './closeToTray'
export {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  FILESYSTEM_UNAVAILABLE_HINT,
  backupFileName,
  collectBundle,
  exportAllData,
  formatBytes,
  importAllData,
  importBundle,
  parseBundle,
  serializeBundle,
  type BackupBundle,
  type ExportResult,
  type ImportResult,
} from './dataTransfer'

/** 目录锚点（历史占位导出，保留以免破坏既有 import） */
export const SETTINGS_FEATURE = 'src/features/settings' as const
