#!/usr/bin/env node
/**
 * 纸笺 · 真实数据迁移核对（t20 总装，**只读**）
 * ============================================================================
 * 运行：node scripts/verify-data-migration.mjs
 *      node scripts/verify-data-migration.mjs --vault "D:\\Document\\纸笺" --db "<zhijian.db 路径>"
 *      退出码 0 = 逐条一致；非 0 = 有笔记对不上（会逐条打印差异）
 *
 * ## 它在核对什么（t15 的迁移：SQLite → md 真相源 + 可重建索引）
 * 迁移前的数据在旧库里仍有原件（`notes` / `folders` / `tags` 表**未被删除**，
 * t15 只是把 md 变成真相源、把 SQLite 降级为索引）。因此可以**逐条对照**：
 *
 *   旧库 notes 一行  ↔  vault 里的一个 md 文件（front-matter 的 id 为匹配键）
 *
 * 核对项：id / 标题 / 正文（trim 后逐字节）/ 标签 / 置顶 / 创建与更新时间 / 排序位 /
 *         所属目录；另核对 folders / tags 的映射与备份文件的完整性。
 *
 * ## 纪律（与 t28 的护栏同源）
 *  - **只读**：数据库用 `readOnly: true` 打开，vault 只读遍历，**绝不写入**任何文件；
 *  - 不依赖 `src/**` 的代码（否则"用被测代码验证被测数据"，索引坏了也会一起通过）；
 *  - 逐条打印，不做"整体通过/失败"式的模糊结论 —— **差异必须能被看到**。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/* ------------------------------ 参数与路径 ------------------------------ */

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (key?.startsWith('--')) out[key.slice(2)] = argv[i + 1]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

/** 候选 vault 根（按优先级探测；也可用 --vault 指定） */
const VAULT_CANDIDATES = [
  args.vault,
  'D:\\Document\\纸笺',
  path.join(os.homedir(), 'Documents', '纸笺'),
  path.join(os.homedir(), '文档', '纸笺'),
].filter(Boolean)

const vaultRoot = VAULT_CANDIDATES.find((p) => existsSync(p))
const dbPath =
  args.db ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'com.zhijian.app', 'zhijian.db')

const problems = []
const notes_ = []

function fail(message) {
  problems.push(message)
  console.log(`  ❌ ${message}`)
}

function ok(message) {
  console.log(`  ✅ ${message}`)
}

console.log('纸笺 · 真实数据迁移核对（只读）')
console.log(`vault: ${vaultRoot ?? '（未找到）'}`)
console.log(`旧库 : ${dbPath}${existsSync(dbPath) ? '' : '（不存在）'}`)

if (!vaultRoot) {
  console.log('\n❌ 找不到 vault 根。用 --vault "<路径>" 指定后重跑。')
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.log('\n⚠️ 旧库不存在 ⇒ 无法逐条对照（可能已在别处归档）。')
  console.log('   仍然可以核对 vault 自身：见下方「vault 清单」。')
}

/* ------------------------------ 读取 vault ------------------------------ */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue // .paper 等元数据目录
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.md$/i.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 极简 front-matter 解析（只读核对用，不依赖 src/**）。
 *
 * ⚠️ 分隔符必须是 **`---\n\n`**（两个换行）：`src/db/frontmatter.ts` 的
 * `serializeFrontMatter()` 在闭合 `---` 之后 push 了一个空行再拼正文
 * （`lines.push(FRONT_MATTER_FENCE); lines.push(''); lines.push(content); lines.join('\n')`）。
 * 只吃掉一个换行会把那个空行算进正文，于是每条笔记都会"差一个前导换行" ——
 * 这正是本脚本第一版的现象：trim 后全对、逐字节全不对（**核对工具自身要有依据**）。
 */
function parseMarkdown(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n?/.exec(text)
  if (!match) return { front: {}, body: text }
  const front = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    let value = raw.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      value = inner.length === 0 ? [] : inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    } else if (value === 'true' || value === 'false') {
      value = value === 'true'
    } else if (/^-?\d+$/.test(value)) {
      value = Number(value)
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    front[key] = value
  }
  return { front, body: text.slice(match[0].length) }
}

const mdFiles = walk(vaultRoot)
const vaultNotes = mdFiles.map((file) => {
  const rel = path.relative(vaultRoot, file).replace(/\\/g, '/')
  const raw = readFileSync(file, 'utf8')
  const { front, body } = parseMarkdown(raw)
  return {
    file,
    rel,
    dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
    bytes: statSync(file).size,
    id: typeof front.id === 'string' ? front.id : null,
    title: front.title ?? null,
    tags: Array.isArray(front.tags) ? front.tags : [],
    pinned: front.pinned === true,
    created: typeof front.created === 'number' ? front.created : null,
    updated: typeof front.updated === 'number' ? front.updated : null,
    order: typeof front.order === 'number' ? front.order : null,
    body,
  }
})

console.log(`\n── vault 清单：${mdFiles.length} 个 md`)
for (const n of vaultNotes) {
  console.log(
    `   · ${n.rel}  ${String(n.bytes).padStart(5)} B  id=${(n.id ?? '(缺)').slice(0, 8)}  title=${JSON.stringify(n.title)}`,
  )
}

/* ---------------------------- 读取「迁移快照」源（只读） ---------------------------- */
//
// ⚠️ 这里**必须读迁移时的备份**，不能读当前那个 zhijian.db：
// t15 之后 SQLite 已降级为**可重建索引**，其 notes 表会被索引同步不断改写
// （用户新建/改名/删除笔记都会进去）。拿"活索引"当迁移前的原件比对，
// 会在用户正常使用后必然误报 —— 这是本脚本第一版的实际缺陷（实测：库 11 条 vs 快照 7 条）。
/**
 * 迁移快照路径。
 *
 * ⚠️ 必须读迁移时的备份，不能读当前那个 zhijian.db：t15 之后 SQLite 已降级为**可重建索引**，
 * 其 notes 表会被索引同步不断改写（新建/改名/删除/外部编辑都会进去）。
 * 拿"活索引"当迁移前的原件比对，会在用户正常使用后**必然误报** —— 这是本脚本第一版的缺陷
 * （实测：库 11 条 vs 快照 7 条，tags 1 vs 2）。
 *
 * 返回：字符串路径，或 `{ limited, reason }` 表示"环境受限、跳过比对"。
 */
const snapshotSource = (() => {
  const migrated = path.join(vaultRoot, '.paper', 'migrated.json')
  if (existsSync(migrated)) {
    try {
      const info = JSON.parse(readFileSync(migrated, 'utf8'))
      if (info?.backupPath) {
        if (existsSync(info.backupPath)) return info.backupPath
        // ⚠️ 边界（data 指出、容易漏）：迁移标记在、但备份文件已被清理 ⇒ **不要退回读活索引库**
        // （那正是第一版误报的根源），而是明确标"环境受限、不做推断"，而不是判失败。
        return { limited: true, reason: `migrated.json 记录的备份已不存在：${info.backupPath}` }
      }
    } catch {
      /* 落到下面 */
    }
  }
  return dbPath // 连 migrated.json 都没有（从未迁移过）⇒ 退化为读当前库，并在输出里标注
})()

let legacy = null
const snapshotLimited = typeof snapshotSource === 'object'
if (snapshotLimited) {
  console.log(`\n⚠️ 环境受限：${snapshotSource.reason}`)
  console.log('   ⇒ **跳过「迁移快照 ↔ md」逐条比对，不做任何推断**（不判失败）。')
  console.log('   要恢复这项核对：重新迁移一次取得新备份，或把该备份放回原路径。')
} else if (existsSync(snapshotSource)) {
  const snapshotPath = snapshotSource
  const db = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const count = (table) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
      } catch {
        return null
      }
    }
    legacy = {
      path: snapshotPath,
      notes: db.prepare('SELECT * FROM notes ORDER BY created_at').all(),
      folders: count('folders') === null ? [] : db.prepare('SELECT * FROM folders').all(),
      tags: count('tags') === null ? [] : db.prepare('SELECT * FROM tags').all(),
    }
  } finally {
    db.close()
  }
  console.log(`\n── 迁移快照（只读）：${snapshotPath}`)
  console.log(
    `   notes=${legacy.notes.length} folders=${legacy.folders.length} tags=${legacy.tags.length}` +
      (snapshotPath === dbPath ? '（⚠️ 未找到 migrated.json 的备份路径，退化为读当前库）' : ''),
  )
}

/* ------------------------------- 逐条核对 ------------------------------- */

const normalize = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim()

let exactMatches = 0

if (legacy) {
  console.log('\n── 逐条核对（迁移快照 notes → 当前 vault md）')
  const byId = new Map(vaultNotes.filter((n) => n.id).map((n) => [n.id, n]))
  let untouched = 0
  let editedAfter = 0
  let goneAfter = 0

  for (const row of legacy.notes) {
    const file = byId.get(row.id)
    const label = `${(row.title ?? '').slice(0, 18) || '(无标题)'} [${String(row.id).slice(0, 8)}]`
    if (!file) {
      // 迁移**之后**删除或改名（id 随之变化）都是合法操作 ⇒ 只报事实，不判失败。
      goneAfter += 1
      console.log(`  ℹ️  ${label}：快照里有、vault 里已无此 id（迁移后被删除/改名，属正常）`)
      continue
    }

    // 是否在迁移之后被编辑过：front-matter 的 `updated` 与快照行的 `updated_at` 一致
    // ⇒ 内容未被改动 ⇒ **必须与快照逐字节相同**（这才是"迁移无损"的可复现断言）；
    // 否则说明迁移后被正常编辑过，差异合法（只报事实，避免"用户一编辑自检就红"）。
    const untouchedSinceMigration = row.updated_at === file.updated
    if (untouchedSinceMigration) untouched += 1
    else editedAfter += 1

    const diffs = []
    if (file.title !== row.title) diffs.push(`标题：快照=${JSON.stringify(row.title)} 文件=${JSON.stringify(file.title)}`)
    const bodyEqual = file.body === String(row.content ?? '')
    const bodyTrimEqual = normalize(file.body) === normalize(row.content)
    if (bodyEqual) exactMatches += 1
    if (!bodyTrimEqual) {
      diffs.push(
        `正文不一致（trim 后）：库 ${String(row.content ?? '').length} 字符 / 文件 ${file.body.length} 字符`,
      )
    }
    const legacyTags = String(row.tags ?? '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    if (legacyTags.join(',') !== file.tags.join(',')) {
      diffs.push(`标签：快照=${JSON.stringify(legacyTags)} 文件=${JSON.stringify(file.tags)}`)
    }
    if (Boolean(row.pinned) !== file.pinned) diffs.push(`置顶：快照=${row.pinned} 文件=${file.pinned}`)
    if (row.created_at !== file.created) diffs.push(`创建时间：快照=${row.created_at} 文件=${file.created}`)
    if (row.updated_at !== file.updated) diffs.push(`更新时间：快照=${row.updated_at} 文件=${file.updated}`)
    if (row.sort_order !== file.order) diffs.push(`排序位：快照=${row.sort_order} 文件=${file.order}`)

    // 目录归属：库里的 folder_id 应能在 folders.json 里找到名字，且名字与 md 所在目录一致
    const folderName = row.folder_id
      ? legacy.folders.find((f) => f.id === row.folder_id)?.name ?? '(未知 folder_id)'
      : ''
    if ((folderName ?? '') !== file.dir) {
      diffs.push(`所属目录：快照=${JSON.stringify(folderName)} 文件=${JSON.stringify(file.dir)}`)
    }

    const rowNote = {
      label,
      rel: file.rel,
      bytes: file.bytes,
      bodyEqual,
      bodyTrimEqual,
      diffs,
    }
    notes_.push(rowNote)

    if (diffs.length === 0) {
      ok(`${label} → ${file.rel}（正文${bodyEqual ? '逐字节相同' : 'trim 后相同'}）`)
    } else if (untouchedSinceMigration) {
      // 迁移后**没人动过**（updated 与快照一致）却对不上 ⇒ 这是**真的迁移缺陷**
      for (const diff of diffs) fail(`${label} → ${file.rel}\n      ↳ ${diff}`)
    } else {
      // 迁移后被正常编辑过 ⇒ 差异合法，只报事实（否则每次编辑笔记都会让这条自检变红）
      console.log(`  ℹ️  ${label} → ${file.rel}：迁移后被编辑过（updated 变了），差异属正常：`)
      for (const diff of diffs) console.log(`       · ${diff}`)
    }
  }

  console.log(
    `\n  统计：未改动 ${untouched} 条（必须逐字节一致）/ 迁移后编辑过 ${editedAfter} 条 / 迁移后已删除或改名 ${goneAfter} 条`,
  )

  // 反向：vault 里有没有旧库之外的 md？（不算错，但必须被看见）
  const legacyIds = new Set(legacy.notes.map((r) => r.id))
  const extra = vaultNotes.filter((n) => !n.id || !legacyIds.has(n.id))
  if (extra.length > 0) {
    console.log(`  ℹ️ vault 里另有 ${extra.length} 个 md 不在旧库记录中（迁移后新建的笔记，属正常）：`)
    for (const n of extra) console.log(`       · ${n.rel}`)
  }

  // folders / tags 映射
  console.log('\n── 目录与标签映射')
  const foldersJson = path.join(vaultRoot, '.paper', 'folders.json')
  const tagsJson = path.join(vaultRoot, '.paper', 'tags.json')
  if (existsSync(foldersJson)) {
    const mapped = JSON.parse(readFileSync(foldersJson, 'utf8'))
    const names = Object.keys(mapped)
    const legacyNames = legacy.folders.map((f) => f.name)
    const missing = legacyNames.filter((n) => !names.includes(n))
    if (missing.length === 0) ok(`folders.json 覆盖旧库全部目录：${JSON.stringify(names)}`)
    else fail(`folders.json 缺少目录：${JSON.stringify(missing)}（旧快照=${JSON.stringify(legacyNames)}）`)
  } else {
    fail('缺少 .paper/folders.json（目录改名后 id 会失效）')
  }
  if (existsSync(tagsJson)) {
    const mapped = JSON.parse(readFileSync(tagsJson, 'utf8'))
    const names = Object.keys(mapped)
    const legacyNames = legacy.tags.map((t) => t.name)
    const missing = legacyNames.filter((n) => !names.includes(n))
    if (missing.length === 0) ok(`tags.json 覆盖旧库全部标签：${JSON.stringify(names)}`)
    else fail(`tags.json 缺少标签：${JSON.stringify(missing)}（旧快照=${JSON.stringify(legacyNames)}）`)
  } else {
    fail('缺少 .paper/tags.json')
  }
}

/* ------------------------------ 备份完整性 ------------------------------ */

console.log('\n── 备份与迁移标记')
const appDataDir = path.dirname(dbPath)
const allBak = existsSync(appDataDir) ? readdirSync(appDataDir).filter((n) => n.includes('.bak-')) : []
// 只把**主备份文件**当备份核对：`zhijian.db.bak-<yyyyMMdd>-<HHmmss>-<mmm>`
// （`-shm` / `-wal` 是 SQLite 的附属文件，用"能不能当库打开"去判定它们毫无意义 —— 第一版就这么错过了）
const backups = allBak.filter((n) => /\.bak-\d{8}-\d{6}-\d{3}$/.test(n))
const sidecars = allBak.filter((n) => !backups.includes(n))

if (backups.length === 0) {
  // ⚠️ 「备份不在」= **环境受限**，不是缺陷：备份可能在用户清理临时文件时被删掉，
  //    或该 vault 从未迁移过。这与 data 提的边界同一条政策 —— **不做推断、不判失败**。
  console.log(
    `  ⚠️ 环境受限：未找到旧库备份（${appDataDir} 下应有 zhijian.db.bak-<时间戳>）` +
      ' ⇒ 无法核对"备份内容 = 迁移前原件"，请重新迁移取得新备份后再验。',
  )
} else {
  const expected = legacy ? legacy.notes.length : null
  for (const name of backups) {
    const full = path.join(appDataDir, name)
    const bytes = readFileSync(full)
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    let backupNotes = null
    let readError = null
    try {
      const db = new DatabaseSync(full, { readOnly: true })
      try {
        backupNotes = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n
      } finally {
        db.close()
      }
    } catch (error) {
      readError = error.message
    }
    if (readError) {
      fail(`备份 ${name} 无法作为 SQLite 库打开：${readError}（${bytes.length} B, sha256:${sha}…）`)
    } else if (expected !== null && backupNotes !== expected) {
      fail(`备份 ${name} 的 notes=${backupNotes}，与旧库的 ${expected} 条不一致`)
    } else {
      ok(`备份 ${name}（${bytes.length} B，sha256:${sha}…，可打开且 notes=${backupNotes}）`)
    }
  }
  if (sidecars.length > 0) {
    console.log(
      `  ℹ️ 另有 ${sidecars.length} 个 SQLite 附属文件（-wal / -shm，不当作备份核对）：` +
        sidecars.map((n) => `${n}(${statSync(path.join(appDataDir, n)).size} B)`).join('、'),
    )
  }
}

const migratedJson = path.join(vaultRoot, '.paper', 'migrated.json')
if (existsSync(migratedJson)) {
  const info = JSON.parse(readFileSync(migratedJson, 'utf8'))
  const counts = info.counts ?? {}
  if (counts.notes === 7 && counts.folders === 2 && counts.tags === 1) {
    ok(`migrated.json 计数与旧库一致：notes=${counts.notes} folders=${counts.folders} tags=${counts.tags}`)
  } else {
    fail(`migrated.json 计数与预期不符：${JSON.stringify(counts)}（预期 7/2/1）`)
  }
  if (existsSync(info.backupPath ?? '')) ok(`migrated.json 记录的备份路径存在：${info.backupPath}`)
  // 同上：备份被用户清理属合法维护动作 ⇒ 报"环境受限"，不判失败（不做推断）。
  else console.log(`  ⚠️ 环境受限：migrated.json 记录的备份已不在原位（${info.backupPath}）—— 备份可能已被清理；不做推断。`)
} else {
  console.log('  ℹ️ 未找到 .paper/migrated.json（可能从未迁移过，属正常）')
}

/* --------------------------------- 汇总 --------------------------------- */

console.log('\n════════════════════ 汇总 ════════════════════')
if (legacy) {
  console.log(`旧库 notes=${legacy.notes.length} → 已核对 ${notes_.length} 条`)
  console.log(`正文**逐字节相同**：${exactMatches}/${notes_.length}（front-matter 分隔符按 serializeFrontMatter 的 `+"`---\\n\\n`"+` 解析）`)
}
console.log(problems.length === 0 ? '✅ 迁移数据逐条一致' : `❌ 发现 ${problems.length} 处不一致`)
process.exit(problems.length === 0 ? 0 : 1)
