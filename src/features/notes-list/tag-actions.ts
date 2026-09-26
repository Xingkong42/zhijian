/**
 * 标签动作桥（notes-list 侧）。
 * 归属：src/features/notes-list/**（t18）。
 *
 * 边界（t18 任务约束 + `src/features/README.md`）：
 *  - **只消费 store 接口**，不 import `src/db/**`、不直接读写 md 文件；
 *  - 标签的真相源是笔记 front-matter（t15）：`notesStore.update(id, { tags })` 会经
 *    `notesRepo` 覆盖式重写该笔记的 front-matter 标签，顺带同步索引与 note_tags；
 *  - 不存在的标签名由 db 层自动创建（默认色），所以「在面板里输入一个新名字」就能
 *    同时创建标签并挂到笔记上，这正是「用户第一次用标签」最短的路径。
 *
 * 为什么写一个「串行 + 最后一次生效」的队列：
 *  面板里连点多个标签会产生多次写请求，而每次写都会**重写同一个 md 文件**。
 *  串行化可以避免同一文件被并发写坏；「最后一次生效」保证最终磁盘状态与用户看到的
 *  勾选状态一致（中间态不需要落盘）。
 */

import { isTauri } from '@/lib/tauri'
import { listAll, useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'

/** 覆盖式设置某条笔记的标签（底层一次真实的 front-matter 重写） */
export async function assignNoteTags(id: string, names: readonly string[]): Promise<void> {
  await useNotesStore.getState().update(id, { tags: [...names] })
}

let queued: { id: string; names: string[] } | null = null
let flushing = false

/**
 * 排队写入（最新一次覆盖之前未开始的那次）。
 * 失败不抛出：`notesStore.update` 会把可读错误写进 `error`，由 App 统一 toast。
 */
export function queueNoteTags(id: string, names: readonly string[]): void {
  queued = { id, names: [...names] }
  if (flushing) return
  flushing = true
  void (async () => {
    try {
      while (queued) {
        const job = queued
        queued = null
        try {
          await assignNoteTags(job.id, job.names)
        } catch {
          // 错误已进 store.error（App 负责提示）；队列继续，避免卡死后续写入
        }
      }
    } finally {
      flushing = false
    }
  })()
}

/**
 * 跳到某个标签的筛选视图。
 *
 * 与 `App.handleSelectView` 同样的成对动作：`uiStore.setView`（决定高亮与视图语义）
 * + `notesStore.listByTag`（决定列表集合）。`listByTag` 接受标签名或 id，这里传名字，
 * 省一次 id→名 的解析。
 * 浏览器预览（无 SQLite）只切视图、不发起查询，避免每次点击都弹一条「数据库不可用」。
 */
export async function focusTag(tag: { id: string; name: string }): Promise<void> {
  useUiStore.getState().setView('tag', tag.id)
  if (!isTauri) return
  await useNotesStore.getState().listByTag(tag.name)
}

/** 回到「全部笔记」（空标签视图的引导按钮用） */
export async function focusAllNotes(): Promise<void> {
  useUiStore.getState().setView('all')
  if (!isTauri) return
  await listAll()
}
