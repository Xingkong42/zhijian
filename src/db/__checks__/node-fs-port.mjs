/**
 * 自检专用的 FsPort 实现（Node `node:fs/promises`）。
 *
 * db 层把文件系统抽象成 FsPort（src/db/storage.ts），生产用 Tauri plugin-fs，
 * 自检用这里的真实文件系统实现 —— 于是同一套 db 代码可以在**纯 Node** 下
 * 用真实临时目录跑完整流程（含原子写、改名、回收站、索引重建、旧库迁移）。
 *
 * 只被 __checks__ 下的脚本使用，不参与应用打包。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 真实文件系统端口 */
export const nodeFsPort = {
  async exists(target) {
    try {
      await fs.stat(target)
      return true
    } catch {
      return false
    }
  },
  async mkdir(target, options = {}) {
    await fs.mkdir(target, { recursive: options.recursive ?? false })
  },
  async readDir(target) {
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  },
  async readTextFile(target) {
    return fs.readFile(target, 'utf8')
  },
  async readFileBytes(target) {
    return fs.readFile(target)
  },
  async writeTextFile(target, contents) {
    await fs.writeFile(target, contents, 'utf8')
  },
  async rename(from, to) {
    await fs.rename(from, to)
  },
  async remove(target, options = {}) {
    await fs.rm(target, { recursive: options.recursive ?? false, force: true })
  },
  async stat(target) {
    const info = await fs.stat(target)
    return {
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      mtimeMs: info.mtimeMs,
      size: info.size,
    }
  },
  async copyFile(from, to) {
    await fs.copyFile(from, to)
  },
}

/** 建一个唯一的临时目录（调用方负责清理） */
export async function makeTempDir(prefix = 'zhijian-check-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 递归删除目录（忽略不存在） */
export async function removeDir(target) {
  await fs.rm(target, { recursive: true, force: true })
}

/** 递归列出目录下所有相对路径（POSIX，含目录） */
export async function listTree(root) {
  const result = []
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      result.push(entry.isDirectory() ? `${rel}/` : rel)
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
    }
  }
  await walk(root, '')
  return result.sort()
}

/** 读文件（不存在返回 null） */
export async function readTextIfExists(target) {
  try {
    return await fs.readFile(target, 'utf8')
  } catch {
    return null
  }
}

export { fs }
