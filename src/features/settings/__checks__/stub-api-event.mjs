/**
 * `@tauri-apps/api/event` 的替身（仅自检使用，不参与打包）。
 *
 * 供「单一订阅（D1 防复发）」的可执行断言使用：把 `listen()` 的注册**记录下来**，
 * 并由用例决定何时派发事件 —— 于是能精确断言
 * **「派发一次事件 → 动作执行恰好一次」**，而不是只看静态调用点数量。
 */

/** 已注册的监听器：event 名 → Set<handler> */
const listeners = new Map()
/** 全部注册记录（含重复注册），用于统计「同一事件被订阅了几次」 */
const registrations = []

export function resetEventStub() {
  listeners.clear()
  registrations.length = 0
}

/** 派发一次事件；返回收到该事件的监听器数量（= 该事件被订阅了几次） */
export function emitEvent(event, payload) {
  const set = listeners.get(event)
  if (!set) return 0
  for (const handler of [...set]) handler({ event, payload, id: 1 })
  return set.size
}

export function listenerCount(event) {
  return listeners.get(event)?.size ?? 0
}

export function registrationsFor(event) {
  return registrations.filter((item) => item.event === event)
}

export async function listen(event, handler) {
  registrations.push({ event, handler })
  const set = listeners.get(event) ?? new Set()
  set.add(handler)
  listeners.set(event, set)
  return () => {
    set.delete(handler)
  }
}

export async function once(event, handler) {
  const unlisten = await listen(event, handler)
  return unlisten
}

export async function emit() {}

export async function unlisten() {}
