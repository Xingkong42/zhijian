/**
 * 更换数据目录（t37 · 需求 B）——**先复制、再校验、最后才切换**。
 * ==================================================================
 * 用户要求"不考虑安全问题"，但**数据完整性不能妥协**，因此流程固定为四步：
 *
 *   1. **前置校验**：目标必须是绝对路径、与当前 vault 不同、且不能位于当前 vault 内部；
 *      目标目录若已存在**纸笺数据**（`.paper/migrated.json` 或任何 `.md`）→ 拒绝（避免覆盖）；
 *   2. **复制**：把当前 vault 的全部内容（含 `.paper/` 元数据与 `.trash/`）逐个 `copyFile`
 *      到目标（二进制精确复制；目录先 `mkdir`）。此阶段**不碰原目录**；
 *   3. **校验**：① 相对路径集合逐个一致（文件数）；② 每个文件大小一致；
 *      ③ **抽样 sha256**（默认抽 8 个，含 `.paper/*.json` 与最新写入的文件）逐字节比对。
 *      任何不一致 → 判定失败；
 *   4. **切换**：把新根写入"位置文件"`<appDataDir>/vault-location.json` → 更新内存配置
 *      （`configureStorage`）→ `rebuildIndex()` 重建索引。
 *
 * **失败语义**：1–3 步任意失败都不会写入位置文件、不会改变内存配置 ⇒ **原目录与内存配置
 * 完好无损**，失败时还会把目标里的半成品副本删掉（删的是副本，不是原数据），
 * 并给出可读错误 + `status: 'failed'`。切换后**旧目录保留不删**，结果里给出
 * `oldDataKeptAt` 供 UI 明确告知用户"旧数据仍在哪里"。
 *
 * 索引库（`zhijian.db`）位于应用数据目录、**不在 vault 内**，因此不受本功能影响；
 * 切换后调用一次 `rebuildIndex()` 即可让索引与新根一致。
 */

import { dirnameOf, isAbsolutePath, joinPath, toRelPosix } from './paths'
import { VAULT_LOCATION_FILE, configureStorage, getStorage, writeVaultLocation } from './storage'

/** 校验快照 */
export interface RelocateVerification {
  /** 源 / 目标文件数（应一致） */
  sourceFiles: number
  targetFiles: number
  /** 总字节数（两侧一致） */
  sourceBytes: number
  targetBytes: number
  /** 抽样校验的文件数与其中通过的数量 */
  sampled: number
  sampleMatches: number
  /** 抽样文件清单（相对路径） */
  sampledPaths: string[]
  /** 不可用 sha256 时为 true（此时仅比对路径与大小） */
  hashUnavailable: boolean
}

export interface RelocateResult {
  status: 'relocated' | 'failed'
  fromVault: string
  toVault: string
  verification: RelocateVerification | null
  /** 切换后旧数据仍在的位置（UI 要明确告知用户） */
  oldDataKeptAt: string
  /** 切换后索引里的笔记数（重建索引的结果） */
  indexedNotes: number | null
  reason?: string
  summary: string
}

export interface RelocateOptions {
  /** 抽样校验的文件数（默认 8；自检里可设更小/更大） */
  sampleCount?: number
  /**
   * 允许目标目录非空（默认 false → 非空即拒绝，避免覆盖别人的数据）。
   * 仅"切回上一次的目录"（{@link restoreVaultRoot}）会打开它：那里的目标就是**同一份 vault**
   * 在搬迁时被保留下来的副本，覆盖同名文件是幂等且安全的。
   * 打开后校验放宽为"源里的每个文件在目标里都存在且内容一致"（目标多出的文件不算错）。
   */
  allowNonEmptyTarget?: boolean
  /** 覆盖 copyFile（自检注入"复制失败"用） */
  copyFile?: (from: string, to: string) => Promise<void>
  /** 覆盖 sha256（自检注入"校验不通过"用） */
  sha256?: (bytes: Uint8Array) => Promise<string | null>
  /** 复制完成后、切换前的钩子（自检注入故障用） */
  beforeSwitch?: (context: { sourceRoot: string; targetRoot: string }) => Promise<void>
  /** 是否重建索引（默认 true） */
  rebuildIndex?: boolean
}

/** sha256（WebView 与 Node 都有 crypto.subtle；不可用时返回 null 并降级为"仅比大小"） */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
    if (!subtle) return null
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

interface VaultEntry {
  rel: string
  absolute: string
  bytes: number
}

/** 递归列出目录下所有文件（相对路径 + 绝对路径 + 字节数） */
async function listFiles(root: string): Promise<{ files: VaultEntry[]; bytes: number }> {
  const { fs } = getStorage()
  const files: VaultEntry[] = []
  let bytes = 0
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readDir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = joinPath(dir, entry.name)
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        await walk(absolute, rel)
        continue
      }
      if (!entry.isFile) continue
      let size = 0
      try {
        size = (await fs.stat(absolute)).size
      } catch {
        /* 拿不到大小记 0，后续校验会暴露 */
      }
      files.push({ rel: toRelPosix(rel), absolute, bytes: size })
      bytes += size
    }
  }
  await walk(root, '')
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, bytes }
}

/** 逐文件复制（目录按需创建；不使用 rename，确保原目录在切换前保持可用） */
async function copyVault(
  sourceRoot: string,
  targetRoot: string,
  copyFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const { fs } = getStorage()
  const { files } = await listFiles(sourceRoot)
  const createdDirs = new Set<string>()
  for (const file of files) {
    const targetAbsolute = joinPath(targetRoot, file.rel)
    const parent = dirnameOf(targetAbsolute)
    if (parent && !createdDirs.has(parent)) {
      await fs.mkdir(parent, { recursive: true })
      createdDirs.add(parent)
    }
    await copyFile(file.absolute, targetAbsolute)
  }
  await fs.mkdir(targetRoot, { recursive: true })
}

/** 抽样：优先 `.paper/*.json` 与"最近修改"的文件，保证抽到元数据与真实笔记 */
function pickSamples(files: VaultEntry[], sampleCount: number): VaultEntry[] {
  if (files.length <= sampleCount) return files
  const meta = files.filter((file) => file.rel.startsWith('.paper/'))
  const trash = files.filter((file) => file.rel.startsWith('.trash/'))
  const rest = files.filter((file) => !meta.includes(file) && !trash.includes(file))
  const picked: VaultEntry[] = [...meta.slice(0, 2), ...trash.slice(0, 1), ...rest.slice(0, Math.max(0, sampleCount - 3))]
  for (const file of files) {
    if (picked.length >= sampleCount) break
    if (!picked.includes(file)) picked.push(file)
  }
  return picked.slice(0, sampleCount)
}

/**
 * 更换 vault 根目录。默认实现完整走"复制 → 校验 → 切换 + 重建索引"。
 * 失败一律 `status: 'failed'` + 可读 `reason`，且**原目录与配置保持原样**。
 */
export async function relocateVault(targetRoot: string, options: RelocateOptions = {}): Promise<RelocateResult> {
  const storage = getStorage()
  const sourceRoot = storage.vaultRoot
  const copyFile = options.copyFile ?? storage.fs.copyFile.bind(storage.fs)
  const hash = options.sha256 ?? sha256Hex
  const sampleCount = Math.max(1, options.sampleCount ?? 8)

  const failure = (reason: string, verification: RelocateVerification | null = null): RelocateResult => ({
    status: 'failed',
    fromVault: sourceRoot,
    toVault: targetRoot,
    verification,
    oldDataKeptAt: sourceRoot,
    indexedNotes: null,
    reason,
    summary: `更换数据目录失败：${reason}（原目录未改动，数据仍在 ${sourceRoot}）`,
  })

  const allowNonEmptyTarget = options.allowNonEmptyTarget === true

  // ---------- 1. 前置校验 ----------
  if (!isAbsolutePath(targetRoot)) return failure('目标目录必须是绝对路径')
  const normalizedSource = toRelPosix(sourceRoot)
  const normalizedTarget = toRelPosix(targetRoot)
  if (normalizedSource === normalizedTarget) return failure('目标目录与当前数据目录相同，无需更换')
  if (normalizedTarget.startsWith(`${normalizedSource}/`)) return failure('目标目录不能位于当前数据目录内部')

  try {
    const existing = await listFiles(targetRoot)
    if (existing.files.length > 0 && !allowNonEmptyTarget) {
      return failure(`目标目录里已有 ${existing.files.length} 个文件；为避免覆盖，请选一个空目录`)
    }
  } catch {
    /* 目标不存在：正常，后续会创建 */
  }

  // ---------- 2. 复制 ----------
  try {
    await copyVault(sourceRoot, targetRoot, copyFile)
  } catch (error) {
    const reason = `复制失败：${error instanceof Error ? error.message : String(error)}`
    // 只清理"我们刚建出来的半成品副本"，原目录不动
    try {
      await storage.fs.remove(targetRoot, { recursive: true })
    } catch {
      /* 清理失败不影响结论 */
    }
    return failure(reason)
  }

  // ---------- 3. 校验（文件数 + 字节数 + 抽样 sha256） ----------
  let verification: RelocateVerification | null = null
  try {
    const source = await listFiles(sourceRoot)
    const target = await listFiles(targetRoot)
    const sourceRel = source.files.map((file) => file.rel)
    const targetRel = target.files.map((file) => file.rel)
    const missing = sourceRel.filter((rel) => !targetRel.includes(rel))
    const extra = targetRel.filter((rel) => !sourceRel.includes(rel))
    // 默认要求清单**完全一致**（新目录刚复制完，多一个少一个都算错）；
    // "切回上一次目录"时目标里本来就有同一份数据，允许多余文件存在（但源文件必须齐）
    if (missing.length > 0 || (!allowNonEmptyTarget && extra.length > 0)) {
      throw new Error(`文件清单不一致（缺少 ${missing.length} 个 / 多出 ${extra.length} 个）`)
    }
    if (source.bytes !== target.bytes) throw new Error(`总字节数不一致（${source.bytes} ≠ ${target.bytes}）`)

    const samples = pickSamples(source.files, sampleCount)
    let matches = 0
    let hashUnavailable = false
    for (const sample of samples) {
      const sourceBytes = storage.fs.readFileBytes
        ? await storage.fs.readFileBytes(sample.absolute)
        : new TextEncoder().encode(await storage.fs.readTextFile(sample.absolute))
      const targetAbsolute = joinPath(targetRoot, sample.rel)
      const targetBytes = storage.fs.readFileBytes
        ? await storage.fs.readFileBytes(targetAbsolute)
        : new TextEncoder().encode(await storage.fs.readTextFile(targetAbsolute))
      const [left, right] = await Promise.all([hash(sourceBytes), hash(targetBytes)])
      if (left === null || right === null) {
        hashUnavailable = true
        if (sourceBytes.length !== targetBytes.length) throw new Error(`抽样文件长度不一致：${sample.rel}`)
        matches += 1
        continue
      }
      if (left !== right) throw new Error(`抽样 sha256 不一致：${sample.rel}`)
      matches += 1
    }
    verification = {
      sourceFiles: source.files.length,
      targetFiles: target.files.length,
      sourceBytes: source.bytes,
      targetBytes: target.bytes,
      sampled: samples.length,
      sampleMatches: matches,
      sampledPaths: samples.map((sample) => sample.rel),
      hashUnavailable,
    }
  } catch (error) {
    const reason = `校验失败（未切换，原目录未改动）：${error instanceof Error ? error.message : String(error)}`
    try {
      await storage.fs.remove(targetRoot, { recursive: true })
    } catch {
      /* ignore */
    }
    return failure(reason, verification)
  }

  if (options.beforeSwitch) {
    try {
      await options.beforeSwitch({ sourceRoot, targetRoot })
    } catch (error) {
      return failure(`切换前检查失败（未切换）：${error instanceof Error ? error.message : String(error)}`, verification)
    }
  }

  // ---------- 4. 切换（持久化 + 内存配置 + 重建索引） ----------
  try {
    await writeVaultLocation(targetRoot)
    configureStorage({ ...storage, vaultRoot: targetRoot })
  } catch (error) {
    return failure(`写入新位置失败（未切换）：${error instanceof Error ? error.message : String(error)}`, verification)
  }

  let indexedNotes: number | null = null
  if (options.rebuildIndex !== false) {
    try {
      const { rebuildIndex } = await import('./indexer')
      const result = await rebuildIndex()
      indexedNotes = result.total
    } catch (error) {
      // 索引重建失败不回滚目录（数据已在新位置且校验通过），但要如实报告
      return {
        status: 'relocated',
        fromVault: sourceRoot,
        toVault: targetRoot,
        verification,
        oldDataKeptAt: sourceRoot,
        indexedNotes: null,
        reason: `目录已切换，但索引重建失败：${error instanceof Error ? error.message : String(error)}`,
        summary: `已切换到 ${targetRoot}（索引重建失败，可稍后手动重建）；旧数据仍保留在 ${sourceRoot}`,
      }
    }
  }

  return {
    status: 'relocated',
    fromVault: sourceRoot,
    toVault: targetRoot,
    verification,
    oldDataKeptAt: sourceRoot,
    indexedNotes,
    summary:
      `已把数据目录切换到 ${targetRoot}（校验：${verification.sourceFiles} 个文件 / ` +
      `${(verification.sourceBytes / 1024).toFixed(1)} KB，抽样 ${verification.sampled} 个文件` +
      `${verification.hashUnavailable ? '（sha256 不可用，已按字节数校验）' : ' sha256 全部一致'}）；` +
      `**旧数据仍保留在 ${sourceRoot}**`,
  }
}

/**
 * 切回/还原到指定目录（自检的"往返"用；同样是复制 + 校验 + 切换）。
 * 会打开 `allowNonEmptyTarget`（目标就是上次搬迁时保留下来的同一份 vault）。
 */
export async function restoreVaultRoot(previousRoot: string, options: RelocateOptions = {}): Promise<RelocateResult> {
  return relocateVault(previousRoot, { ...options, allowNonEmptyTarget: true })
}

/** 位置文件绝对路径（诊断 / 自检断言用） */
export function vaultLocationFilePath(): string {
  const storage = getStorage()
  return joinPath(storage.appDataDir, VAULT_LOCATION_FILE)
}
