/**
 * 开机自动启动（t38）—— **唯一接线处**。
 * 归属：系统集成（`src/features/settings/**`）。
 *
 * ## 机制
 * `tauri-plugin-autostart`（Windows 下写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
 * 的 `纸笺` 值；macOS 写 LaunchAgent；Linux 写 `~/.config/autostart/*.desktop`）。
 * 前端只用插件导出的函数 `enable()` / `disable()` / `isEnabled()`，
 * **不拼任何 `plugin:autostart|*` 字符串**（本项目已因命令名漂移踩过坑，见 t31）。
 *
 * ## 权威源（关键：这里容易做成假开关）
 * | 关注点 | 权威源 |
 * | --- | --- |
 * | **是否真的开机自启** | **系统状态**：`isEnabled()`（读注册表 Run 项） |
 * | 用户「希望」的状态 | localStorage `zhijian.autostart` |
 *
 * ⇒ **UI 必须展示系统状态**，而不是本地偏好。用户可能在系统设置里手动关掉自启，
 * 那时二者不一致，本模块会报告 `drifted` 供 UI 提示。
 *
 * ## 与「最小化到托盘」的关系
 *
 * 二者**互不相干**：开机自启只负责把进程拉起来；启动后是否收进托盘由 Rust 侧的
 * `--minimized` 启动参数决定（见 `src-tauri/src/lib.rs` 的 `started_minimized()`）。
 * 前端**没有**「启动后最小化到托盘」这个偏好（已删除），因此也不存在组合改写。
 */

import { isTauri } from '@/lib/tauri'
import {
  readAutostartPreference,
  writeAutostartPreference,
} from '@/lib/appPreferences'

/* --------------------------- 系统状态读取 --------------------------- */

export type AutostartSystemState =
  /** 读取成功：`enabled` 即系统事实 */
  | { kind: 'known'; enabled: boolean }
  /** 读不到（浏览器预览 / 插件未注册 / 无权限）——**不得**当作 false */
  | { kind: 'unavailable'; reason: string }

export const AUTOSTART_UNAVAILABLE_HINT =
  '当前无法读取系统开机自启状态：' +
  '常见原因是运行在浏览器预览模式，或后端尚未注册 autostart 插件/权限。'

type PluginApi = {
  isEnabled: () => Promise<boolean>
  enable: () => Promise<void>
  disable: () => Promise<void>
}

/**
 * 动态 import 插件（浏览器 dev 下永不加载，避免缺依赖时启动即炸）。
 * 插件未安装 / 未注册 / 无权限时抛错，由调用方转成可读的 `unavailable`。
 */
async function loadPlugin(): Promise<PluginApi> {
  const mod = await import('@tauri-apps/plugin-autostart')
  return { isEnabled: mod.isEnabled, enable: mod.enable, disable: mod.disable }
}

/**
 * 读取**系统实际状态**。
 *
 * ⚠️ 绝不在失败时返回 `enabled: false` —— 那会把"读不到"伪装成"未启用"，
 * 用户会以为开关是对的。这正是本项目反复出现的"静默失效"形态。
 */
export async function readSystemAutostart(api?: PluginApi): Promise<AutostartSystemState> {
  if (!isTauri && !api) {
    return { kind: 'unavailable', reason: AUTOSTART_UNAVAILABLE_HINT }
  }
  try {
    const plugin = api ?? (await loadPlugin())
    const enabled = await plugin.isEnabled()
    return { kind: 'known', enabled: enabled === true }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `${AUTOSTART_UNAVAILABLE_HINT}（${error instanceof Error ? error.message : String(error)}）`,
    }
  }
}

/* --------------------------- 设置与回读校验 --------------------------- */

export interface AutostartToggleResult {
  /** 目标状态是否已在系统侧生效（**以回读为准**，不是"调用没报错"就算数） */
  ok: boolean
  /** 操作前读取到的系统状态（null = 读不到） */
  before: boolean | null
  /** 操作后**回读**到的系统状态（null = 读不到） */
  after: boolean | null
  /** 失败/异常原因（可读） */
  message: string | null
}

/**
 * 设置开机自启，并**回读校验**（t38 的核心要求：切换后立即生效并回读）。
 *
 * 「调用 `enable()` 没抛错」**不足以**证明生效 —— 所以这里一定回读 `isEnabled()`
 * 并把它作为唯一结论来源。
 */
export async function setSystemAutostart(
  enabled: boolean,
  api?: PluginApi,
): Promise<AutostartToggleResult> {
  const before = await readSystemAutostart(api)
  const beforeValue = before.kind === 'known' ? before.enabled : null

  try {
    const plugin = api ?? (await loadPlugin())
    if (enabled) await plugin.enable()
    else await plugin.disable()
  } catch (error) {
    return {
      ok: false,
      before: beforeValue,
      after: null,
      message: `${enabled ? '开启' : '关闭'}开机自启失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const after = await readSystemAutostart(api)
  if (after.kind === 'unavailable') {
    return {
      ok: false,
      before: beforeValue,
      after: null,
      message: `${enabled ? '开启' : '关闭'}后无法回读系统状态，因此**不能确认**已生效：${after.reason}`,
    }
  }
  if (after.enabled !== enabled) {
    return {
      ok: false,
      before: beforeValue,
      after: after.enabled,
      message: `操作未生效：期望 ${enabled ? '已启用' : '未启用'}，回读为 ${after.enabled ? '已启用' : '未启用'}`,
    }
  }
  return { ok: true, before: beforeValue, after: after.enabled, message: null }
}

/* --------------------------- UI 开关入口 --------------------------- */

/**
 * UI 开关的完整处理：
 *  1. 落库用户意图（`zhijian.autostart`）—— 用于插件不可用时仍能显示"上次想要的状态"；
 *  2. 调系统 API 并**回读校验**。
 *
 * 这里曾有一条「开启自启就顺手把前端 `startMinimized` 置 true」的组合行为，
 * 已随该偏好一并删除 ⇒ 开机自启不再隐式改写任何别的开关。
 */
export async function applyAutostart(
  enabled: boolean,
  api?: PluginApi,
): Promise<AutostartToggleResult> {
  writeAutostartPreference(enabled)
  return setSystemAutostart(enabled, api)
}

/* --------------------------- 对账（诊断） --------------------------- */

export interface AutostartDrift {
  /** 用户在 localStorage 里「希望」的状态 */
  wanted: boolean
  /** 系统实际状态；null = 读不到 */
  actual: boolean | null
  /** 是否不一致（actual 为 null 时视为"无法判断"而非漂移） */
  drifted: boolean
}

export function autostartDrift(actual: boolean | null): AutostartDrift {
  const wanted = readAutostartPreference()
  return { wanted, actual, drifted: actual !== null && actual !== wanted }
}
