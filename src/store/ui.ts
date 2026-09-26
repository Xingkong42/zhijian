/**
 * uiStore —— 纯 UI 状态（FROZEN 接口，实现归属：系统集成 / 任务 t6）。
 *
 * 契约（docs/ARCHITECTURE.md §4.2 / §4.6）：
 *  - 字段与方法签名不得改：sidebarCollapsed / view / activeFolderId / activeTagId /
 *    settingsOpen / toggleSidebar / setView / openSettings / closeSettings。
 *  - 一切状态**只存在内存**，禁止落 SQLite（也禁止落 localStorage：
 *    偏好类设置走 src/lib/appPreferences.ts 的独立命名空间）。
 *  - `view === 'settings'` 与 `settingsOpen` 双向一致：从设置面板切回
 *    某视图时 settingsOpen 自动关闭，避免出现「面板关不掉」的死角。
 *
 * 消费方式：`const view = useUiStore((s) => s.view)`
 */

import { create } from 'zustand'
import type { UiView } from '@/types'

export interface UiState {
  sidebarCollapsed: boolean
  view: UiView
  activeFolderId: string | null
  activeTagId: string | null
  settingsOpen: boolean

  toggleSidebar: () => void
  setView: (view: UiView, id?: string | null) => void
  openSettings: () => void
  closeSettings: () => void
}

export const UI_DEFAULTS = {
  sidebarCollapsed: false,
  view: 'all' as UiView,
  activeFolderId: null,
  activeTagId: null,
  settingsOpen: false,
} as const

/** `setView` 的收敛结果（纯函数，便于单测） */
export function resolveViewChange(
  state: Pick<UiState, 'activeFolderId' | 'activeTagId'>,
  view: UiView,
  id?: string | null,
): Pick<UiState, 'view' | 'activeFolderId' | 'activeTagId' | 'settingsOpen'> {
  switch (view) {
    case 'folder':
      return {
        view,
        activeFolderId: id ?? null,
        // 保留另一维度的选中项：从文件夹切到标签再切回来时上下文不丢
        activeTagId: state.activeTagId,
        settingsOpen: false,
      }
    case 'tag':
      return {
        view,
        activeFolderId: state.activeFolderId,
        activeTagId: id ?? null,
        settingsOpen: false,
      }
    case 'settings':
      return {
        view,
        activeFolderId: state.activeFolderId,
        activeTagId: state.activeTagId,
        settingsOpen: true,
      }
    case 'all':
    case 'trash':
    default:
      return {
        view,
        activeFolderId: state.activeFolderId,
        activeTagId: state.activeTagId,
        settingsOpen: false,
      }
  }
}

export const useUiStore = create<UiState>()((set, get) => ({
  ...UI_DEFAULTS,

  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setView: (view, id) => {
    set((state) => resolveViewChange(state, view, id))
  },

  openSettings: () => {
    // 必须**同时**设置 view 与 settingsOpen：
    //  - UI 侧以 `view === 'settings'` 作为「显示设置面板」的判据（与侧栏导航同一套语义）；
    //  - `closeSettings()` 也依赖 view 来判断「该不该切回 all」。
    // 若这里只改 settingsOpen，标题栏的「设置」按钮会**打开不了面板**
    // （回调会执行、store 也会变，但没有任何视图切换，属静默失效）。
    set({ view: 'settings', settingsOpen: true })
  },

  closeSettings: () => {
    const { view } = get()
    const patch: Partial<UiState> = { settingsOpen: false }
    // view 仍是 'settings' 时改回 'all'，避免遗留一个没有对应列表的视图
    if (view === 'settings') patch.view = 'all'
    set(patch)
  },
}))

/** 设置面板是否可见（便捷 selector，避免各处重复写 s.settingsOpen） */
export const selectSettingsOpen = (state: UiState): boolean => state.settingsOpen

/** 供集成层（main.tsx / App.tsx）显式调用；等价于读取初始状态，幂等 */
export function initUi(): void {
  useUiStore.getState()
}

/** 重置为初始状态（退出登录 / 测试用；不落库） */
export function resetUi(): void {
  useUiStore.setState({ ...UI_DEFAULTS })
}

export default useUiStore
