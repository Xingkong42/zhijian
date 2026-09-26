/**
 * `@tauri-apps/plugin-opener` 的替身（仅 t17 自检使用，不参与打包）。
 * 只实现 `openPath` / `revealItemInDir`，并把调用记录下来供断言。
 */

export const calls = []

export async function openPath(path) {
  calls.push({ op: 'openPath', path })
}

export async function revealItemInDir(path) {
  calls.push({ op: 'revealItemInDir', path })
}

export async function openUrl(url) {
  calls.push({ op: 'openUrl', url })
}
