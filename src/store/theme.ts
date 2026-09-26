/**
 * themeStore —— 主题状态（FROZEN 接口，实现归属：设计系统 / 任务 t2）。
 *
 * 契约（docs/ARCHITECTURE.md §4.2 / §4.5 / §4.6）：
 *  - 字段与方法名不得改：themeId / mode / themeList / setTheme / setMode / toggleMode / apply。
 *  - 生效方式 = 往 <html> 写两个属性：`data-theme="<id>"` + `class="light|dark"`；
 *    颜色值全部来自 CSS 变量，组件不参与主题切换（无需重渲染任何业务组件）。
 *  - 持久化：localStorage（主键 `zj:theme`，JSON `{"themeId","mode"}`）。
 *    兼容读取架构文档 §4.6 约定的 `zhijian.` 前缀旧键（`zhijian.theme` / `zhijian.mode`），
 *    以保证与「设置面板 / 后续偏好项」的命名空间共存。
 *  - token 值只在 src/db/schema.ts 的 THEMES 与 src/styles/theme.css 中定义；本文件不写任何色值。
 *  - 主题是 UI 偏好，**不落 SQLite**（§4.6）。
 */

import { create } from 'zustand'
import type { ThemeDefinition, ThemeId, ThemeMode } from '@/types'
import { DEFAULT_THEME_ID, THEMES, getTheme } from '@/db/schema'

export interface ThemeState {
  themeId: ThemeId
  mode: ThemeMode
  /** 供设置面板渲染的主题清单（静态，来自 THEMES） */
  themeList: readonly ThemeDefinition[]
  setTheme: (id: ThemeId) => void
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
  /** 把当前 themeId/mode 应用到 document.documentElement */
  apply: () => void
}

/** localStorage 主键（任务契约：zj:theme） */
export const THEME_STORAGE_KEY = 'zj:theme'
/** 兼容键（架构文档 §4.6 的 `zhijian.` 前缀空间） */
export const THEME_STORAGE_KEY_LEGACY = 'zhijian.theme'
export const MODE_STORAGE_KEY_LEGACY = 'zhijian.mode'

export const THEME_DEFAULTS = {
  themeId: DEFAULT_THEME_ID,
  mode: 'light' as ThemeMode,
  themeList: THEMES,
} as const

/* ------------------------------ 工具 ------------------------------ */

const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === 'string' && THEMES.some((theme) => theme.id === value)

const isThemeMode = (value: unknown): value is ThemeMode => value === 'light' || value === 'dark'

const canUseStorage = (): boolean => typeof window !== 'undefined' && !!window.localStorage

/** 读 localStorage 里的一项，失败（隐私模式 / 被禁用）返回 null */
function readKey(key: string): string | null {
  if (!canUseStorage()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时静默降级：主题仍然在本次会话内生效 */
  }
}

/** 解析存储值：支持 JSON `{"themeId","mode"}`、JSON 字符串、以及裸 id / 裸 mode */
function parseStored(raw: string | null): { themeId?: ThemeId; mode?: ThemeMode } {
  if (!raw) return {}
  const text = raw.trim()
  if (!text) return {}
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        const themeId = record['themeId']
        const mode = record['mode']
        return {
          ...(isThemeId(themeId) ? { themeId } : {}),
          ...(isThemeMode(mode) ? { mode } : {}),
        }
      }
    } catch {
      return {}
    }
    return {}
  }
  if (isThemeId(text)) return { themeId: text }
  if (isThemeMode(text)) return { mode: text }
  return {}
}

/** 启动时读取持久化偏好；任何异常都退回默认值（绝不抛错，避免白屏） */
export function readPersistedTheme(): { themeId: ThemeId; mode: ThemeMode } {
  const primary = parseStored(readKey(THEME_STORAGE_KEY))
  const legacy: { themeId?: ThemeId; mode?: ThemeMode } = {
    ...parseStored(readKey(THEME_STORAGE_KEY_LEGACY)),
    ...parseStored(readKey(MODE_STORAGE_KEY_LEGACY)),
  }
  return {
    themeId: primary.themeId ?? legacy.themeId ?? THEME_DEFAULTS.themeId,
    mode: primary.mode ?? legacy.mode ?? THEME_DEFAULTS.mode,
  }
}

export function persistTheme(themeId: ThemeId, mode: ThemeMode): void {
  writeKey(THEME_STORAGE_KEY, JSON.stringify({ themeId, mode }))
  // 兼容旧键：同步一份，保证双方读取方都拿到最新值
  writeKey(THEME_STORAGE_KEY_LEGACY, themeId)
  writeKey(MODE_STORAGE_KEY_LEGACY, mode)
}

/**
 * 把主题写进 <html>。**唯一的 DOM 写入口**。
 * 组件不感知主题：切换只是换 CSS 变量，浏览器重算样式，React 不重渲染。
 */
export function applyThemeToDocument(themeId: ThemeId, mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset['theme'] = themeId
  root.classList.toggle('dark', mode === 'dark')
  // light 保留显式类，避免「未设置 class」时落到未定义状态（§4.5）
  root.classList.toggle('light', mode === 'light')
  root.style.colorScheme = mode
}

/* ------------------------------ store ------------------------------ */

const initial = readPersistedTheme()

export const useThemeStore = create<ThemeState>()((set, get) => ({
  themeId: initial.themeId,
  mode: initial.mode,
  themeList: THEMES,

  apply: () => {
    const { themeId, mode } = get()
    applyThemeToDocument(themeId, mode)
  },

  setTheme: (id) => {
    const next = isThemeId(id) ? id : THEME_DEFAULTS.themeId
    if (next === get().themeId) {
      get().apply()
      return
    }
    set({ themeId: next })
    get().apply()
    persistTheme(next, get().mode)
  },

  setMode: (mode) => {
    const next: ThemeMode = isThemeMode(mode) ? mode : THEME_DEFAULTS.mode
    if (next === get().mode) {
      get().apply()
      return
    }
    set({ mode: next })
    get().apply()
    persistTheme(get().themeId, next)
  },

  toggleMode: () => {
    get().setMode(get().mode === 'dark' ? 'light' : 'dark')
  },
}))

/** 供集成层（main.tsx / App.tsx）显式调用；与模块加载副作用等价，幂等 */
export function initTheme(): void {
  useThemeStore.getState().apply()
}

/* 模块加载即接管首帧之后的外观：index.html 已给出淡黄 light 兜底，
   这里把 localStorage 中的用户偏好立刻应用到 <html>，避免二次切换闪烁。 */
if (typeof document !== 'undefined') {
  applyThemeToDocument(initial.themeId, initial.mode)
}

/** 当前主题定义（便捷读取，禁止在组件里手写主题映射表） */
export function currentThemeDefinition(themeId: ThemeId = useThemeStore.getState().themeId) {
  return getTheme(themeId)
}

export default useThemeStore
