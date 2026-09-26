/**
 * 自检替身：src/lib/tauri.ts 的 `isTauri` 在 Node 下恒为 false，
 * 会让 initDb() 直接抛"不在 Tauri 运行环境"。自检把该模块换成这里，
 * 只提供 db 层实际用到的那几个成员。
 */

export const isTauri = true

export const APP_META = {
  productName: '纸笺',
  identifier: 'com.zhijian.app',
  version: '0.0.0-selfcheck',
  dbUrl: 'sqlite:zhijian.db',
  migrationTable: '_zj_migrations',
}

/* ------------------------- t44：跨窗口同步的两个封装 -------------------------
   为什么桩件里必须补上：`src/store/notes.ts` 现在 import `broadcastNoteChanged`，
   而自检是用 Node 直接加载真实 store 的（loader.mjs 把 `@/lib/tauri` 换成本文件）。
   桩件缺导出会让整道门以
     `SyntaxError: The requested module '@/lib/tauri' does not provide an export named ...`
   **崩在加载期**（check:reorder 实测如此）——
   这类"桩件漏项"已经栽过两次（见 settings 侧 stub 的同类注释）。

   这里刻意做成**可观测的 no-op**：Node 自检里没有事件总线，但把调用记下来，
   自检就能断言"写动作确实广播了"，而不是只能相信静态检查。 */

/** 记录 `broadcastNoteChanged(noteId)` 的调用（诊断 + 断言用） */
export const noteChangedBroadcasts = []

export function resetNoteChangedBroadcasts() {
  noteChangedBroadcasts.length = 0
}

export async function broadcastNoteChanged(noteId) {
  noteChangedBroadcasts.push(noteId)
}

/** 自检里没有别的窗口：订阅恒为空实现，返回一个成对的退订函数 */
export async function onNoteChanged() {
  return () => {}
}
