/**
 * 侧栏公用小工具（本 feature 内共享）。
 * 归属：src/features/sidebar/**（t5）。
 */

import type { FolderTreeNode, NoteCounts } from '@/types'

/**
 * 触发「void | Promise<void>」型回调并吞掉 rejection。
 * 约定：store 把失败写进自己的 `error` 字段（见 ARCHITECTURE §2.4），
 * 组件只负责发起调用，不重复处理错误；这里仅为避免 unhandled rejection。
 */
export function fire(result: void | Promise<void>): void {
  void Promise.resolve(result).catch(() => undefined)
}

/**
 * 某个文件夹（含其全部子文件夹）内的笔记数。
 *
 * 用途：删除文件夹的二次确认要如实说明影响范围（`foldersRepo.remove` 会把
 * 这些笔记移出目录、但**不删除**它们），所以要把整棵子树的计数加起来。
 *
 * 契约要点（data 成员实测）：`NoteCounts.byFolder` 的键是**文件夹 id**，
 * 不包含「未归类」的笔记（null 不能作 Record 键）。
 *
 * 注：t18 已按用户反馈移除侧栏「收件箱」入口，原先的 `inboxCount()`
 * （= 全部 − Σ 各文件夹）不再有任何消费方，已删除，避免留死码。
 */
export function folderSubtreeNoteCount(counts: NoteCounts, node: FolderTreeNode): number {
  const own = counts.byFolder[node.id] ?? 0
  return node.children.reduce((sum, child) => sum + folderSubtreeNoteCount(counts, child), own)
}

/** 文件夹树 → 扁平列表（带深度），供「移动到…」等选择器使用 */
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

/** 收集树中全部 id */
export function collectFolderIds(nodes: FolderTreeNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    into.add(node.id)
    if (node.children.length > 0) collectFolderIds(node.children, into)
  }
  return into
}

/** 找到某文件夹的全部祖先 id（用于自动展开到当前选中项）；找不到返回空数组 */
export function folderAncestorIds(nodes: FolderTreeNode[], targetId: string): string[] {
  const walk = (list: FolderTreeNode[], trail: string[]): string[] | null => {
    for (const node of list) {
      if (node.id === targetId) return trail
      const found = walk(node.children, [...trail, node.id])
      if (found) return found
    }
    return null
  }
  return walk(nodes, []) ?? []
}
