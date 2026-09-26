/**
 * `@tauri-apps/plugin-fs` 的替身（t6 / t13 / t17 自检使用，不参与打包）。
 *
 * 实现两个模块用到的能力：
 *  - `dataTransfer.ts`：`writeTextFile` / `readTextFile`
 *  - `vaultData.ts`（t17）：`exists` / `mkdir` / `readDir` / `copyFile`
 * 全部操作真实文件（路径由用例的临时目录提供），并记录调用便于断言。
 */

import { existsSync } from 'node:fs'
import { readFile as readFileCb, writeFile as writeFileCb, mkdir as mkdirCb, readdir as readdirCb, copyFile as copyFileCb, stat as statCb } from 'node:fs'
import { promisify } from 'node:util'

const readFile = promisify(readFileCb)
const writeFile = promisify(writeFileCb)
const mkdirAsync = promisify(mkdirCb)
const readdirAsync = promisify(readdirCb)
const copyFileAsync = promisify(copyFileCb)
const statAsync = promisify(statCb)

export const calls = []

export async function writeTextFile(path, contents) {
  calls.push({ op: 'write', path, bytes: contents.length })
  await writeFile(path, contents, 'utf8')
}

export async function readTextFile(path) {
  calls.push({ op: 'read', path })
  const buffer = await readFile(path)
  return buffer.toString('utf8')
}

/** dataTransfer 用到的粗粒度存在性判断 */
export async function exists(path) {
  return existsSync(path)
}

/* ------------------- t17：备份数据目录需要的能力 ------------------- */

export async function mkdir(path, options = {}) {
  calls.push({ op: 'mkdir', path, recursive: options?.recursive === true })
  await mkdirAsync(path, { recursive: options?.recursive === true })
}

export async function readDir(path) {
  const entries = await readdirAsync(path, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
  }))
}

export async function copyFile(from, to) {
  calls.push({ op: 'copyFile', from, to })
  await copyFileAsync(from, to)
}

export async function stat(path) {
  const info = await statAsync(path)
  return {
    isDirectory: info.isDirectory(),
    isFile: info.isFile(),
    size: info.size,
    mtime: info.mtime,
  }
}

export async function remove(path, options = {}) {
  const { rm } = await import('node:fs/promises')
  await rm(path, { recursive: options?.recursive === true, force: true })
}

export async function rename(from, to) {
  const { rename: renameAsync } = await import('node:fs/promises')
  await renameAsync(from, to)
}

export const BaseDirectory = {}
