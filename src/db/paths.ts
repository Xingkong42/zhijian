/**
 * 轻量路径工具（纯函数，不依赖 node:path —— 前端 bundle 里没有 node）。
 *
 * 约定：
 *  - **绝对路径**由 Tauri `documentDir()` / `appDataDir()` 给出，沿用系统分隔符；
 *  - **库内相对路径**（vault 相对路径）一律用 POSIX `/` 作为键，
 *    便于跨平台比较与写进索引（`toRelPosix()` 负责归一化）。
 */

/** 判断是否 Windows 风格路径（盘符或反斜杠） */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
}

/** 拼接路径片段，保留首段的绝对性与系统分隔符风格 */
export function joinPath(...parts: (string | null | undefined)[]): string {
  const clean = parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((part) => part.length > 0)
  if (clean.length === 0) return ''
  const separator = isWindowsPath(clean[0]) ? '\\' : '/'
  return clean.join(separator)
}

/** 父目录；无分隔符时返回空串 */
export function dirnameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (index < 0) return ''
  if (index === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3) // 'C:\'
  return normalized.slice(0, index)
}

/** 最后一段（文件名或目录名） */
export function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** 扩展名（含点，小写）；无扩展名返回空串 */
export function extnameOf(name: string): string {
  const base = basenameOf(name)
  const index = base.lastIndexOf('.')
  if (index <= 0) return ''
  return base.slice(index).toLowerCase()
}

/** 去掉扩展名的文件名 */
export function stemOf(name: string): string {
  const base = basenameOf(name)
  const index = base.lastIndexOf('.')
  return index <= 0 ? base : base.slice(0, index)
}

/** 是否绝对路径（POSIX 根、Windows 盘符、UNC） */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * 断言必须使用绝对路径（t28 加固）。
 *
 * 为什么需要：`joinPath('', 'x')` 这类"基准丢失"的拼接会**静默产出相对路径**，
 * 于是文件被写进**进程工作目录**（开发态是仓库根目录，打包后是安装目录）——
 * 症状就是"偶发 ENOENT + 仓库里多出 0 字节垃圾文件"，极难定位。
 * 因此凡是「要落到磁盘」的路径都必须过这道断言：宁可抛可读错误，也不在 CWD 里写。
 */
export function assertAbsolutePath(candidate: string, context: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || !isAbsolutePath(candidate)) {
    throw new Error(
      `${context}：必须使用绝对路径（收到 ${JSON.stringify(candidate)}）——拒绝在进程工作目录下读写文件`,
    )
  }
  return candidate
}

/** 归一化为库内相对路径：统一 `/`、去掉首尾分隔符、折叠重复分隔符与 `.` */
export function toRelPosix(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

/** 是否隐藏条目（`.trash` / `.paper` / `.DS_Store` 等） */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/** 相对路径的首段（顶层目录名）；无目录返回 null */
export function topSegment(relPath: string): string | null {
  const normalized = toRelPosix(relPath)
  const index = normalized.indexOf('/')
  return index < 0 ? null : normalized.slice(0, index)
}

/** 相对路径的目录部分（POSIX，顶层文件返回 ''） */
export function relDirOf(relPath: string): string {
  const normalized = toRelPosix(relPath)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

/** 相对路径的文件名部分 */
export function relNameOf(relPath: string): string {
  const normalized = toRelPosix(relPath)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** 时间戳 → 文件名安全的时间串（迁移备份用），形如 20260925-214012-123 */
export function timestampSlug(date: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  )
}
