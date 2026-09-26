/**
 * 笔记列表的小工具（本 feature 内共享）。
 * 归属：src/features/notes-list/**（t5）。
 */

import type { FolderTreeNode } from '@/types'

/**
 * 触发「void | Promise<void>」型回调并吞掉 rejection。
 * 约定：store 把失败写进自己的 `error` 字段（ARCHITECTURE §2.4），组件不重复处理错误。
 */
export function fire(result: void | Promise<void>): void {
  void Promise.resolve(result).catch(() => undefined)
}

/** 文件夹树 → 扁平列表（带深度），供「移动到…」对话框使用 */
export function flattenFolders(
  nodes: FolderTreeNode[],
  depth = 0,
): { folder: FolderTreeNode; depth: number }[] {
  const out: { folder: FolderTreeNode; depth: number }[] = []
  for (const node of nodes) {
    out.push({ folder: node, depth })
    if (node.children.length > 0) out.push(...flattenFolders(node.children, depth + 1))
  }
  return out
}
