// 纸笺 · QA 第二轮独立验证脚本 2/2：md 真相源 / 索引可重建 / 迁移无损（**用真实数据**）
//
// 与成员的 check:fs 的区别（为什么还要写这一份）：
//   · check:fs 跑的是**它自己造的临时场景**；本脚本跑的是**用户真实 vault 的只读副本**；
//   · 本脚本对 md 的解析、与旧库的逐条比对、污染手法与断言**全部自己实现**，
//     不复用 src/db/** 的解析结果作为「期望值」（避免用被测代码验证被测数据）。
//
// 三段：
//   A. 真实 vault 的文件系统证据（文件数/文件名/front-matter 字段/正文），我自己解析
//   B. **迁移无损**：与「迁移前原件」逐条比对 —— 原件 = **只读打开的应用备份快照**
//      （`.paper/migrated.json.backupPath`，或应用数据目录下最新的 `zhijian.db.bak-*`）
//   C. **md 才是真相源**：复制 vault 到临时根 → 先 `rebuildIndex()` → 污染索引 → 再 rebuild
//      → 必须回到文件真相（若 rebuild 后仍是污染值、或 md 被改写，则本段失败）
//
// 运行：node scripts/verify-md-truth.mjs [--vault "D:\\Document\\纸笺"]
//
// ============================================================================
// ## 取证对象（t43 修正，这是「不误报」的根本；勿改回去）
//
// | 段落 | 取证对象 | 会不会因「用户正常编辑」而误报 |
// | --- | --- | --- |
// | A | **活 vault**（当前磁盘上的 md） | 不会：断言只针对**结构**（有 md、front-matter 字段齐全、id 稳定），不断言条数或具体内容 |
// | B | **只读快照**：迁移前的 `zhijian.db.bak-*` | 不会：快照一旦生成就不再变；且对「迁移后被编辑过」的原件**主动跳过字段比对**（只查「id 还在 + `created` 未变」这两条**编辑不变**的事实） |
// | C | **一次性副本**（复制 vault 到临时根） | 不会：先在副本上 `rebuildIndex()` 再比，比的是「**索引 vs md 真相**」；真实 vault 全程只读 |
//
// ### 为什么**绝不**拿活索引当「迁移原件」（t43 修正的根因）
// 迁移后 `%APPDATA%\com.zhijian.app\zhijian.db` 已**被复用为可重建索引**，它本来就该
// 跟随 md 变化。旧版本拿它当"旧库原件"逐条比对 ⇒ **用户一正常编辑（改标题/加标签/新建笔记）
// 就必然误报**（实测：vault 长到 11 条时误报 9 项）。正确的区分是：
//   · 「迁移原件」= 只读备份快照（本文 B 段）
//   · 「索引 == md 真相」= 先 `rebuildIndex()` 再比（本文 C 段）
// 活索引只在 B 段末尾以 **ℹ️ 信息** 形式出现，**不参与任何断言**。
// ============================================================================

import { register } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertAbsolutePath, closeRealDatabase, openRealDatabaseReadOnly, requireEnvDir } from './lib/qa-paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

register(new URL('../src/db/__checks__/loader.mjs', import.meta.url).href)

let pass = 0
const failures = []
const ok = (m) => {
  pass += 1
  console.log(`  ✅ ${m}`)
}
const bad = (m) => {
  failures.push(m)
  console.log(`  ❌ ${m}`)
}
const assert = (cond, m) => {
  if (cond) ok(m)
  else bad(m)
  return cond
}
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/* ------------------------------ 真实路径定位 ------------------------------ */

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) if (argv[i]?.startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]
  return out
}
const args = parseArgs(process.argv.slice(2))
const VAULT_CANDIDATES = [
  args.vault,
  'D:\\Document\\纸笺',
  path.join(os.homedir(), 'Documents', '纸笺'),
  path.join(os.homedir(), '文档', '纸笺'),
].filter(Boolean)
const vaultRoot = VAULT_CANDIDATES.find((p) => existsSync(p))

console.log('纸笺 · md 真相源 / 索引可重建 / 迁移无损（真实数据只读核对）')

/* ------------------------------ A. 文件系统证据 ------------------------------ */

console.log('\n── A. 真实 vault 的文件系统证据（自己解析 front-matter）')

/** 我自己写的极简 front-matter 解析器（不 import src/db/frontmatter.ts，避免用被测代码当期望值） */
function myParseFrontMatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { meta: {}, body: raw, hasYaml: false }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value)
    else if (/^-?\d+$/.test(value)) value = Number(value)
    else if (value === 'true' || value === 'false') value = value === 'true'
    else if (value.startsWith('[')) {
      try {
        value = JSON.parse(value)
      } catch {
        /* 保持字符串 */
      }
    }
    meta[key] = value
  }
  return { meta, body: match[0] ? raw.slice(match[0].length) : raw, hasYaml: true }
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push({ full, rel: path.relative(base, full).replace(/\\/g, '/') })
  }
  return out
}

if (!vaultRoot) {
  bad(`未找到真实 vault（候选：${VAULT_CANDIDATES.join(' / ')}）⇒ 标【受限】，不做推断`)
} else {
  assertAbsolutePath(vaultRoot, '真实 vault')
  const all = walk(vaultRoot)
  const mds = all.filter((f) => f.rel.toLowerCase().endsWith('.md') && !f.rel.startsWith('.trash/'))
  ok(`vault 根（绝对路径）：${vaultRoot}`)
  ok(`vault 内文件总数 ${all.length}，其中 md ${mds.length} 个、.paper 元数据 ${all.filter((f) => f.rel.startsWith('.paper/')).length} 个`)

  // 逐个 md：front-matter 字段 + 正文
  const parsed = []
  const requiredFields = ['id', 'title', 'tags', 'pinned', 'created', 'updated', 'order']
  let missingField = 0
  for (const file of mds) {
    const raw = readFileSync(file.full, 'utf8')
    const { meta, body, hasYaml } = myParseFrontMatter(raw)
    const missing = requiredFields.filter((k) => !(k in meta))
    if (!hasYaml || missing.length) missingField += 1
    parsed.push({ rel: file.rel, bytes: statSync(file.full).size, meta, body, missing })
    console.log(
      `     · ${file.rel}  ${statSync(file.full).size}B  id=${meta.id ?? '?'} title=${JSON.stringify(meta.title ?? null)} ` +
        `tags=${JSON.stringify(meta.tags ?? null)} pinned=${meta.pinned} order=${meta.order} 正文字符数=${body.trim().length}`,
    )
  }
  assert(mds.length > 0, `存在真实 .md 文件（${mds.length} 个）`)
  assert(missingField === 0, `每个 md 都有 YAML front-matter 且字段齐全（id/title/tags/pinned/created/updated/order）—— 缺字段的文件 ${missingField} 个`)
  assert(
    parsed.every((p) => typeof p.meta.id === 'string' && p.meta.id.length >= 8),
    '每个 md 的 front-matter 都带**稳定 id**（这是「文件名改了 id 也不变」的基础）',
  )
  const nonEmptyBodies = parsed.filter((p) => p.body.trim().length > 0).length
  ok(`含非空正文的 md：${nonEmptyBodies}/${parsed.length}（其余是真实的空笔记）`)

  /* ---------------- B. 迁移无损：以**只读备份快照**为原件 ---------------- */

  console.log('\n── B. 迁移无损：与「迁移前原件（只读备份快照）」比对（**不是**与活索引比对）')

  try {
    const appDataDir = requireEnvDir('APPDATA', '应用数据目录定位', 'com.zhijian.app')
    const migrated = JSON.parse(readFileSync(path.join(vaultRoot, '.paper/migrated.json'), 'utf8'))

    /** 快照定位：优先 migrated.json 记录的备份；否则取应用数据目录里最新的 zhijian.db.bak-* */
    let backupPath = null
    if (typeof migrated.backupPath === 'string' && existsSync(migrated.backupPath)) {
      backupPath = migrated.backupPath
    } else {
      const candidates = readdirSync(appDataDir)
        .filter((name) => /^zhijian\.db\.bak-/.test(name) && !/-wal$|-shm$/.test(name))
        .map((name) => path.join(appDataDir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      backupPath = candidates[0] ?? null
    }

    if (!backupPath) {
      bad(`找不到迁移前备份快照（migrated.json.backupPath 不存在，且 ${appDataDir} 下无 zhijian.db.bak-*）⇒ 无法核对迁移，标【受限】，不做推断`)
    } else {
      const snapshot = openRealDatabaseReadOnly(assertAbsolutePath(backupPath, '迁移前备份快照'))
      try {
        ok(`取证对象 = **迁移前只读快照**：${backupPath}（${statSync(backupPath).size}B，以 ${snapshot.mode} 打开；尝试链：${snapshot.attempts.join(' → ')}）`)
        const rows = snapshot.db
          .prepare('SELECT id,title,content,folder_id,tags,pinned,sort_order,created_at,updated_at FROM notes')
          .all()
        const folders = snapshot.db.prepare('SELECT id,name FROM folders').all()
        const tags = snapshot.db.prepare('SELECT id,name,color FROM tags').all()
        ok(`快照内容（迁移时刻的事实，不随用户编辑变化）：notes=${rows.length} folders=${folders.length} tags=${tags.length}`)

        assert(
          migrated.counts?.notes === rows.length &&
            migrated.counts?.folders === folders.length &&
            migrated.counts?.tags === tags.length,
          `migrated.json 计数与快照一致：notes=${migrated.counts?.notes}/${rows.length} folders=${migrated.counts?.folders}/${folders.length} tags=${migrated.counts?.tags}/${tags.length}`,
        )

        // 按**稳定 id** 在全部 md（含 .trash/）里找原件
        const completedAt = Number(migrated.completedAt ?? 0)
        const allMdParsed = walk(vaultRoot)
          .filter((f) => f.rel.toLowerCase().endsWith('.md'))
          .map((f) => ({ ...f, ...myParseFrontMatter(readFileSync(f.full, 'utf8')) }))
        const byId = new Map(allMdParsed.map((p) => [p.meta?.id, p]))

        let present = 0
        let untouched = 0
        let editedSince = 0
        const realDiffs = []
        for (const row of rows) {
          const md = byId.get(row.id)
          if (!md) {
            console.log(`     ℹ️  快照原件 ${row.id}（${JSON.stringify(row.title)}）已不在 vault（含 .trash）⇒ 迁移后被用户删除，**不计为迁移缺陷**`)
            continue
          }
          present += 1

          // ① 编辑不变的字段：id / created —— 任何编辑都不该改动它们 ⇒ 可安全硬断言
          if (Number(row.created_at) !== Number(md.meta.created)) {
            realDiffs.push(`${md.rel}：created 与快照不一致（快照 ${row.created_at} ≠ md ${md.meta.created}）`)
          }

          // ② 「迁移后被编辑过」的原件：跳过字段比对（避免误报）
          const updatedSame = Number(row.updated_at) === Number(md.meta.updated)
          const mtimeAfterMigration = completedAt > 0 && statSync(md.full).mtimeMs > completedAt
          if (!updatedSame || mtimeAfterMigration) {
            editedSince += 1
            const why = !updatedSame ? 'updated 变了' : '文件 mtime 晚于迁移完成时间'
            console.log(`     ℹ️  ${md.rel}：迁移后被编辑过（${why}）⇒ 字段比对跳过（这正是旧版本误报的地方）`)
            continue
          }

          // ③ 「迁移后未被动过」的原件：逐字段硬比对
          //    防御：front-matter 的 tags 有两种合法写法（`tags: []` 与空值 `tags:`），
          //    非数组一律按「无标签」归一化，避免格式差异被当成迁移差异（误报）。
          const mdTags = Array.isArray(md.meta.tags) ? md.meta.tags : []
          const checks = {
            正文: String(row.content ?? '').trim() === md.body.trim(),
            标题: String(row.title ?? '') === String(md.meta.title ?? ''),
            置顶: Boolean(row.pinned) === Boolean(md.meta.pinned),
            排序: Number(row.sort_order) === Number(md.meta.order),
            标签: JSON.stringify(JSON.parse(row.tags || '[]')) === JSON.stringify(mdTags),
          }
          const failed = Object.entries(checks).filter(([, same]) => !same).map(([k]) => k)
          if (failed.length) realDiffs.push(`${md.rel}：${failed.join('/')} 与快照不一致`)
          else untouched += 1
        }

        assert(rows.length === 0 || present > 0, `快照 ${rows.length} 条原件中，仍有 ${present} 条在 vault 里（按稳定 id 匹配，改名/移动目录不影响）`)
        assert(
          realDiffs.length === 0,
          `迁移保真：**编辑不变字段**（id/created）${present}/${present} 条一致；「迁移后未被改动」的 ${untouched} 条逐字段（正文/标题/置顶/排序/标签）一致；` +
            `因迁移后被编辑而跳过字段比对的 ${editedSince} 条（**主动跳过，避免用户正常编辑造成误报**）；真实差异 ${realDiffs.length} 条`,
        )
        realDiffs.forEach((d) => console.log(`     ❌ ${d}`))

        // 目录 / 标签：按 **id** 比对（用户改名不影响；只要求「原件不丢」）
        const foldersJson = JSON.parse(readFileSync(path.join(vaultRoot, '.paper/folders.json'), 'utf8'))
        const tagsJson = JSON.parse(readFileSync(path.join(vaultRoot, '.paper/tags.json'), 'utf8'))
        const folderIds = new Set(Object.values(foldersJson).map((v) => v?.id))
        const tagIds = new Set(Object.values(tagsJson).map((v) => v?.id))
        const lostFolders = folders.filter((f) => !folderIds.has(f.id))
        const lostTags = tags.filter((t) => !tagIds.has(t.id))
        assert(
          lostFolders.length === 0,
          `快照 ${folders.length} 个目录的 id 全部仍能在 .paper/folders.json 里找到（改名安全：只比 id；丢失 ${lostFolders.length} 个${lostFolders.length ? `：${lostFolders.map((f) => f.name).join('、')}` : ''}）`,
        )
        assert(
          lostTags.length === 0,
          `快照 ${tags.length} 个标签的 id 全部仍能在 .paper/tags.json 里找到（丢失 ${lostTags.length} 个${lostTags.length ? `：${lostTags.map((t) => t.name).join('、')}` : ''}）`,
        )

        // 活索引只作 ℹ️ 信息（**不作断言**：索引本就该跟随 md 变化）
        try {
          const livePath = path.join(appDataDir, 'zhijian.db')
          if (existsSync(livePath)) {
            const live = openRealDatabaseReadOnly(livePath)
            try {
              const liveCount = live.db.prepare('SELECT COUNT(*) c FROM notes').get().c
              console.log(
                `     ℹ️  活索引（**仅供参考，不作断言**）：notes=${liveCount}；当前 vault 有 ${mds.length} 个 md。` +
                  '两者不必相等（索引按需同步/可重建）—— 需要"索引 == md 真相"的结论请看 C 段（先 rebuild 再比）。',
              )
            } finally {
              closeRealDatabase(live)
            }
          }
        } catch (error) {
          console.log(`     ℹ️  读取活索引失败（不影响本段结论）：${error instanceof Error ? error.message : error}`)
        }
      } finally {
        closeRealDatabase(snapshot)
      }
    }
  } catch (error) {
    bad(`B 段失败：${error instanceof Error ? error.message : error}`)
  }

  /* --------------------- C. md 是真相源：污染索引 → rebuild --------------------- */

  console.log('\n── C. md 是真相源：复制真实 vault → 建索引 → **污染索引** → rebuild 回到文件真相')

  const runRoot = path.join(os.tmpdir(), `zhijian-qa-md-truth-${process.pid}-${Date.now()}`)
  try {
    // 复制真实 vault（只读源 → 临时根；源目录不动）
    const vaultCopy = path.join(runRoot, 'Documents', '纸笺')
    mkdirSync(vaultCopy, { recursive: true })
    for (const file of all) {
      const target = path.join(vaultCopy, file.rel)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(file.full, target)
    }
    const copiedMds = walk(vaultCopy).filter((f) => f.rel.toLowerCase().endsWith('.md'))
    const hashesBefore = new Map(copiedMds.map((f) => [f.rel, sha(f.full)]))
    ok(`已把真实 vault 复制到临时根（${copiedMds.length} 个 md + ${all.length - mds.length} 个元数据文件）：${runRoot}`)

    const appDataDir = path.join(runRoot, 'AppData')
    mkdirSync(appDataDir, { recursive: true })

    const db = await import('../src/db/index.ts')
    const { notesRepo } = await import('../src/db/notes.ts')
    const { tagsRepo } = await import('../src/db/tags.ts')
    const { nodeFsPort } = await import('../src/db/__checks__/node-fs-port.mjs')
    const { __handle } = await import('../src/db/__checks__/stub-plugin-sql.mjs')

    await db.closeDb()
    db.configureStorage({
      fs: nodeFsPort,
      vaultRoot: vaultCopy,
      appDataDir,
      legacyDbPath: path.join(appDataDir, 'zhijian.db'),
    })
    await db.initDb()
    const first = await db.rebuildIndex()
    ok(`rebuildIndex() 首次：total=${first.total}（从 md 建索引）`)

    const baselineNotes = await notesRepo.listAll()
    const baselineTags = await tagsRepo.list()
    const baseline = new Map(baselineNotes.map((n) => [n.id, n.title]))
    ok(`索引读回：notes=${baselineNotes.length}、tags=${baselineTags.length}（${baselineTags.map((t) => `${t.name}=${t.color}`).join(', ')}）`)
    assert(baselineNotes.length === mds.length, `索引里的笔记数(${baselineNotes.length}) == vault 里的 md 数(${mds.length})`)

    // 索引确实是「读的来源」：污染它，读出来必须是脏的（否则说明读的不是索引 → 后面的 rebuild 无意义）
    const raw = __handle()
    const victim = baselineNotes[0]
    const truthTitle = victim.title
    const dirtyTitle = `POLLUTED-${Date.now()}`
    const dirtyColor = '#000000'
    const truthColor = baselineTags[0]?.color ?? '#C9A227'
    raw.prepare('UPDATE notes SET title = ? WHERE id = ?').run(dirtyTitle, victim.id)
    raw.prepare('UPDATE tags SET color = ?').run(dirtyColor)
    const afterPollution = (await notesRepo.listAll()).find((n) => n.id === victim.id)
    const tagsAfterPollution = await tagsRepo.list()
    assert(afterPollution?.title === dirtyTitle, `污染索引后读到的确是脏值（title=${afterPollution?.title}）⇒ 上层读的**就是索引**，不是每次都读文件`)
    assert(tagsAfterPollution[0]?.color === dirtyColor, `标签颜色同样读自索引（${tagsAfterPollution[0]?.color}）`)

    // 重建 → 必须回到文件/.paper 真相
    const second = await db.rebuildIndex()
    ok(`rebuildIndex() 第二次（污染后重建）：total=${second.total}`)
    const repaired = (await notesRepo.listAll()).find((n) => n.id === victim.id)
    const tagsRepaired = await tagsRepo.list()
    assert(repaired?.title === truthTitle, `重建后标题回到 md 真相（${JSON.stringify(repaired?.title)} === ${JSON.stringify(truthTitle)}）`)
    assert(repaired?.content === victim.content, '重建后正文与污染前一致（md 未被索引污染）')
    assert(tagsRepaired[0]?.color === truthColor, `重建后标签颜色回到 .paper/tags.json 真相（${tagsRepaired[0]?.color} === ${truthColor}）`)

    // md 文件本身不得被 rebuild 改写（真相源是文件，重建只读文件）
    const changed = copiedMds.filter((f) => hashesBefore.get(f.rel) !== sha(f.full))
    assert(changed.length === 0, `rebuild 没有改写任何 md 文件（${copiedMds.length} 个文件 sha256 全部不变）`)

    // 索引整表 DROP → 再重建，仍能回到同一批笔记（可重建性）
    for (const stmt of [
      'DROP TABLE IF EXISTS notes_fts_trigram',
      'DROP TABLE IF EXISTS notes_fts',
      'DROP TABLE IF EXISTS note_tags',
      'DROP TABLE IF EXISTS notes',
      'DROP TABLE IF EXISTS tags',
      'DROP TABLE IF EXISTS folders',
    ]) {
      raw.exec(stmt)
    }
    const third = await db.rebuildIndex()
    const rebuilt = await notesRepo.listAll()
    const sameIds = JSON.stringify([...rebuilt].map((n) => n.id).sort()) === JSON.stringify([...baselineNotes].map((n) => n.id).sort())
    assert(third.total === baselineNotes.length && sameIds, `索引表被整表 DROP 后重建：total=${third.total}、id 集合与基线一致=${sameIds}`)
    await db.closeDb()
  } catch (error) {
    bad(`C 段失败：${error instanceof Error ? error.message : error}`)
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
    ok(`临时根已清理：${!existsSync(runRoot)}`)
  }
}

console.log('\n' + '─'.repeat(74))
console.log(`md 真相源核对：通过 ${pass}，失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('✅ md 文件为真相源 / 索引可重建 / 迁移逐条无损 全部通过')
