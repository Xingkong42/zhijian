/**
 * `@tauri-apps/plugin-dialog` 的替身（仅 t6 自检使用，不参与打包）。
 * 由 loader.mjs 在 Node 里替换真实模块；save()/open() 的返回值由用例通过
 * setSave/setOpen 指定（null 用于模拟用户取消）。
 */

const state = {
  save: null,
  open: null,
  calls: [],
}

export function setSave(value) {
  state.save = value
}

export function setOpen(value) {
  state.open = value
}

export function getCalls() {
  return [...state.calls]
}

export async function save(options) {
  state.calls.push({ op: 'save', options })
  return state.save
}

export async function open(options) {
  state.calls.push({ op: 'open', options })
  return state.open
}

export async function message() {}
export async function ask() {
  return true
}
export async function confirm() {
  return true
}
