// 纸笺 · QA 独立验证脚本 2/4：迁移不可变性 + 双迁移源一致性 + FTS5/中文检索
//
// 三件事，全部**独立复算**，不依赖 src/db/__checks__/run-checks.mjs 的结论：
//   A. 迁移不可变性：sqlx 把迁移 SQL 的 SHA-384 记进 `_sqlx_migrations`。
//      重新对 src-tauri/migrations/1_init.sql 的原始字节做 SHA-384，
//      与真实开发库里的记录比对 —— 相等即证明「该文件自 Rust 迁移器执行后一字未改」。
//   B. 双迁移源一致性：src/db/schema.ts 的 SCHEMA_STATEMENTS / FTS_TRIGRAM_STATEMENTS
//      与 migrations/*.sql 的语句集**双向**比对（既不能漏、也不能重复）。
//   C. FTS5 虚拟表 + 同步触发器 + 中文检索两条路径（含 v1 unicode61 不用于中文的实证）。
//
// 运行：node scripts/verify-migrations.mjs
//
// ============================================================================
// ## 【为什么本脚本必须断言绝对路径、且绝不以可写方式打开真实开发库】（t30 加固）
//
// 背景（data 在 t28 排查「仓库根残留 0 字节 `x` 文件」时发现本文件的两处隐患，
// 我在 t30 复现并修复；以下实证来自我自己的实验，勿改回去）：
//
//   1) 旧代码 `path.join(process.env.APPDATA ?? '', 'com.zhijian.app', 'zhijian.db')`
//      —— 环境变量缺失/为空时首段退化成空串，`path.join` 于是返回**相对路径**。
//   2) 相对路径传给 SQLite **不会报错**，而是被静默解析到**进程工作目录**并创建文件；
//      新库在第一次写入前恰好是 **0 字节**，于是"一切正常"与"仓库里多出垃圾文件"同时成立：
//      ```
//      $ node -e "new DatabaseSync('x')"      # CWD = 临时目录
//      opened relative path OK, select -> 1
//      x     0                                 # ← 0 字节垃圾文件，就是这么来的
//      ```
//      开发态 CWD = 仓库根 ⇒ 垃圾文件落在仓库里；打包后 CWD = 安装目录 ⇒ 更难定位。
//   3) 旧代码 `new DatabaseSync(dbPath)` 默认是**读写**模式打开**真实开发库**
//      —— 校验脚本不该有改写用户数据的可能（WAL 模式还有恢复/checkpoint 等写入路径）。
//
// 因此本文件遵守三条铁律（工具在 scripts/lib/qa-paths.mjs）：
//   · 环境变量读取显式判空 → 缺失时**抛可读错误**，绝不回落相对路径；
//   · 所有拼接后的路径过 `assertAbsolutePath`（宁可失败，也不在 CWD 里读写）；
//   · 真实开发库**只读**打开；WAL 让只读受限时退化为「复制含 -wal/-shm 的副本后再读」，
//     副本在系统临时目录里（可写无风险），**真实库永不可写**。
//
// 已知细节（实测，见 t30 报告）：WAL 模式下即便是 `readOnly: true` 的连接，SQLite 也必须
// 把 `-shm` 锁索引以读写方式打开做读者登记 ⇒ 实测 `-shm` 的 **mtime 会前进**，
// 但三件套的 **SHA-256 完全不变**（主库与 `-wal` 连 mtime 都不变）。
// 若某次取证要求「连时间戳都不许动」，用 `ZHIJIAN_QA_DB_MODE=replica` 走纯副本路径：
//     node scripts/verify-migrations.mjs            # 默认：真实库·只读
//     ZHIJIAN_QA_DB_MODE=replica node ...           # 严格零副作用：副本·只读
//
// ## 取证对象（t43 审计结论：本脚本**没有**「拿活数据当快照」的问题）
//   · 迁移 SQL：`src-tauri/migrations/*.sql`（**静态快照**，提交态）与 `schema.ts` 的常量；
//   · 真实库：只读打开，且只读取**写一次**的表 —— `_sqlx_migrations`（sqlx 在 v1 执行时写入
//     checksum/描述，此后不再变）、`_zj_migrations`（前端迁移器版本号）。**用户正常编辑笔记
//     不会改动这两张表**，所以不会误报；
//   · C 段用**内存库**（`:memory:`）跑纯 SQL 行为断言。
// 唯一脆弱点：若用户把整个索引库删掉（应用自身就说「索引数据库位置（可删除，能从 md 重建）」），
// 本脚本会拿不到 checksum 反证 —— 那时打印的是**「证据缺失」**（并给出补救方式），
// **不是**「迁移被改坏」，两者不可混为一谈。
// ============================================================================

import { register } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 只用于内存库（C 段）：**真实开发库一律走 scripts/lib/qa-paths.mjs 的只读/副本策略**
import { DatabaseSync } from 'node:sqlite'
import {
  assertAbsolutePath,
  closeRealDatabase,
  isAbsolutePath,
  openRealDatabaseReadOnly,
  requireEnvDir,
} from './lib/qa-paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const MIG_V1 = path.join(root, 'src-tauri', 'migrations', '1_init.sql')
const MIG_V2 = path.join(root, 'src-tauri', 'migrations', '2_fts_trigram.sql')

register(new URL('../src/db/__checks__/loader.mjs', import.meta.url).href)
const schema = await import('../src/db/schema.ts')

let pass = 0
const failures = []
function ok(m) { pass += 1; console.log(`  ✅ ${m}`) }
function bad(m) { failures.push(m); console.log(`  ❌ ${m}`) }
function assert(cond, m) { if (cond) ok(m); else bad(m); return cond }

const norm = (sql) =>
  sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()

const sqlV1 = readFileSync(MIG_V1, 'utf8')
const sqlV2 = readFileSync(MIG_V2, 'utf8')

/* ==================== A0. 路径安全自检（t30 加固，先跑） ==================== */

console.log('── A0. 路径与真实库访问安全（防「相对路径静默落到 CWD」与「写真实库」）')

// A0-1 环境变量缺失/为空时必须抛可读错误，而不是回落相对路径
const envProbe = (value) => {
  const saved = process.env.__ZJ_QA_PROBE__
  if (value === undefined) delete process.env.__ZJ_QA_PROBE__
  else process.env.__ZJ_QA_PROBE__ = value
  try {
    requireEnvDir('__ZJ_QA_PROBE__', '自检探针')
    return { threw: false }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (saved === undefined) delete process.env.__ZJ_QA_PROBE__
    else process.env.__ZJ_QA_PROBE__ = saved
  }
}
for (const [label, value] of [['未设置(undefined)', undefined], ['空字符串', ''], ['纯空白', '   ']]) {
  const r = envProbe(value)
  assert(
    r.threw === true && /未设置或为空/.test(r.message ?? ''),
    `环境变量${label} → 抛可读错误而非回落相对路径（${r.threw ? r.message.slice(0, 46) : '未抛错！'}…）`,
  )
}

// A0-2 拼接后的路径必须过绝对路径断言（相对路径一律拒绝）
const absProbe = (value) => {
  try {
    assertAbsolutePath(value, '自检探针')
    return { threw: false }
  } catch (error) {
    return { threw: true }
  }
}
assert(absProbe('com.zhijian.app\\zhijian.db').threw === true, "相对路径 'com.zhijian.app\\zhijian.db' 被 assertAbsolutePath 拒绝（这正是旧代码在环境变量缺失时会拼出的值）")
assert(absProbe('').threw === true, "空字符串被 assertAbsolutePath 拒绝")
assert(absProbe(path.join(root, 'src-tauri', 'migrations', '1_init.sql')).threw === false, '绝对路径（仓库内迁移文件）通过断言')

// A0-4 机制自检：`{ readOnly: true }` 在本 Node 版本下**确实禁止写入**
//      （只在系统临时目录的文件上验证，绝不碰真实库）
{
  const probeFile = assertAbsolutePath(
    path.join(tmpdir(), `zhijian-qa-ro-probe-${process.pid}-${Date.now()}.db`),
    '只读机制探针库',
  )
  try {
    const seed = new DatabaseSync(probeFile)
    seed.exec('CREATE TABLE t(x)')
    seed.close()

    let rejected = false
    let message = ''
    let ro = null
    try {
      ro = new DatabaseSync(probeFile, { readOnly: true })
      ro.exec('CREATE TABLE t2(x)') // 只读连接上写入必须失败
    } catch (error) {
      rejected = true
      message = error instanceof Error ? error.message : String(error)
    } finally {
      // 写入失败会跳过 close，Windows 下会锁住文件导致清理失败 —— 这里务必关掉
      try {
        ro?.close()
      } catch {
        /* 已关闭或无法关闭都不影响结论 */
      }
    }
    assert(
      rejected,
      `机制自检：只读连接写入被拒绝 ⇒ { readOnly: true } 生效（${message.slice(0, 72)}…）`,
    )
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        rmSync(`${probeFile}${suffix}`, { force: true })
      } catch {
        /* 清理失败只影响整洁度，不影响结论 */
      }
    }
  }
}

// A0-3 与 data 新增的 src/db/paths.ts::assertAbsolutePath 交叉核对（同一语义，两处实现）
try {
  const business = await import('../src/db/paths.ts')
  const cases = ['C:\\a\\b', '/a/b', '\\\\srv\\share\\x', 'a\\b', 'com.zhijian.app\\zhijian.db', '']
  const mismatch = cases.filter((c) => business.isAbsolutePath(c) !== isAbsolutePath(c))
  assert(
    mismatch.length === 0,
    `我的 isAbsolutePath 与 src/db/paths.ts::isAbsolutePath 在 ${cases.length} 个代表用例上判定一致（不一致 ${mismatch.length} 个）`,
  )
} catch (error) {
  console.log(`  ℹ️  未能交叉核对 src/db/paths.ts（不影响本脚本结论）：${error instanceof Error ? error.message.split('\n')[0] : error}`)
}

/* ============================ A. 迁移不可变性 ============================ */

console.log('\n── A. 迁移不可变性（用真实开发库记录的 sqlx checksum 反证文件未被改动）')

/** 真实开发库路径：环境变量缺失时抛可读错误（**不回落到相对路径**，见文件头实证） */
let dbPath = null
try {
  dbPath = requireEnvDir('APPDATA', '真实开发库定位', 'com.zhijian.app', 'zhijian.db')
} catch (error) {
  bad(`无法定位真实开发库，已拒绝回落相对路径：${error instanceof Error ? error.message : error}`)
  console.log('     ↳ 本次运行判定为**失败**（退出码非 0）：宁可失败，也不在进程工作目录下读写文件。')
}

if (dbPath === null) {
  // 明确跳过 A 段（B/C 段不需要真实库，仍会执行）；失败已计入 failures ⇒ 退出码非 0
} else if (!existsSync(dbPath)) {
  bad(
    `找不到索引/迁移库：${dbPath} ⇒ 本次**证据缺失**（不是「迁移被改坏」）。` +
      '注意该库是可重建索引（应用设置里明说「可删除，能从 md 重建」）：' +
      '如需 checksum 反证，请先启动一次纸笺让它重建索引库，或先跑 md 真相源核对（scripts/verify-md-truth.mjs）。',
  )
} else {
  // 只读打开真实库；WAL 受限时自动退化为「复制含 -wal/-shm 的副本后再读」，真实库永不可写。
  // 打开失败也要给出可读结论（不能让栈追踪打断 B/C 段）。
  let handle = null
  try {
    handle = openRealDatabaseReadOnly(dbPath)
  } catch (error) {
    bad(`打开真实开发库失败（已按「只读 → 副本」策略尝试，绝未以可写方式触碰真实库）：${error instanceof Error ? error.message : error}`)
  }

  if (handle === null) {
    // 打开失败：失败已计入 failures ⇒ 退出码非 0；B/C 段不需要真实库，仍会执行
  } else try {
    const db = handle.db
    ok(`真实开发库存在（绝对路径）：${dbPath}`)
    ok(`打开方式：**${handle.mode}**（尝试链：${handle.attempts.join(' → ')}）`)
    if (handle.mode === '真实库·只读' && existsSync(`${dbPath}-shm`)) {
      console.log('  ℹ️  WAL 只读连接的已知细节：SQLite 会把 -shm 以读写方式打开做读者登记，')
      console.log('     实测 -shm 的 mtime 会前进，但三件套 SHA-256 完全不变（数据零写入）。')
      console.log('     要求连时间戳都不动时：ZHIJIAN_QA_DB_MODE=replica 走纯副本。')
    }
    if (handle.replica) {
      ok(`已复制副本到临时目录（真实库未被触碰）：${handle.replica.files.map((f) => `${f.suffix}=${f.bytes}B`).join(', ')}`)
    }
    const rows = db.prepare('SELECT version, description, success, checksum FROM _sqlx_migrations ORDER BY version').all()
    ok(`_sqlx_migrations 记录：${rows.map((r) => `v${r.version}:${r.description}(success=${r.success})`).join(', ')}`)

    const v1 = rows.find((r) => r.version === 1)
    if (!v1) {
      bad('开发库中没有 v1 迁移记录')
    } else {
      const actual = createHash('sha384').update(readFileSync(MIG_V1)).digest()
      const stored = Buffer.from(v1.checksum)
      assert(
        stored.length === actual.length && stored.equals(actual),
        `1_init.sql 的 SHA-384 与 _sqlx_migrations 记录**逐字节一致** ⇒ 文件自执行以来未被改动（${actual.toString('hex').slice(0, 24)}…）`,
      )
      if (!(stored.length === actual.length && stored.equals(actual))) {
        bad(`期望 ${stored.toString('hex').slice(0, 32)}… 实际 ${actual.toString('hex').slice(0, 32)}…`)
      }
    }

    // Rust 侧只登记了 v1（v2 故意不登记，否则不支持 trigram 的环境整库打不开）
    const libRs = readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8')
    const registered = [...libRs.matchAll(/include_str!\("\.\.\/migrations\/([^"]+)"\)/g)].map((m) => m[1])
    assert(
      JSON.stringify(registered) === JSON.stringify(['1_init.sql']),
      `lib.rs::MIGRATION_SOURCES 只 include_str! 了 ${JSON.stringify(registered)}（v2 故意不登记给 sqlx）`,
    )

    // 运行库里的 FTS 对象与版本表
    const names = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'notes_fts%' OR name LIKE 'trg_notes%' ORDER BY type, name").all()
    const trigramPresent = names.some((n) => n.name === 'notes_fts_trigram')
    ok(`运行库里的 FTS 对象：${names.map((n) => `${n.type}:${n.name}`).join(', ')}`)
    assert(trigramPresent, '真实运行库中 notes_fts_trigram 存在 ⇒ 运行时确实启用了 v2（trigram 可用）〔活对象：若索引库被删除/尚未重建，本次该项为证据缺失，而非回归〕')
    const zj = db.prepare('SELECT version FROM _zj_migrations ORDER BY version').all().map((r) => r.version)
    assert(JSON.stringify(zj) === '[1,2]', `前端迁移器 _zj_migrations 版本 = ${JSON.stringify(zj)}（预期 [1,2]）`)
  } catch (error) {
    bad(`A 段读取真实库时出错（已按只读/副本策略，真实库未被写入）：${error instanceof Error ? error.message : error}`)
  } finally {
    // 关闭只读连接并清理副本（副本为一次性临时目录）
    if (handle) closeRealDatabase(handle)
  }
}

/* ====================== B. 双迁移源一致性（双向） ====================== */

console.log('\n── B. schema.ts ↔ migrations/*.sql 语句集双向比对')

/**
 * 按分号切分 SQL 语句，但**不切碎 CREATE TRIGGER ... BEGIN ... END** 块
 * （触发器体内的分号不是语句边界）。
 */
function splitStatements(sql) {
  const cleaned = sql.replace(/--[^\n]*/g, '')
  const out = []
  let buf = ''
  for (const piece of cleaned.split(';')) {
    buf = buf ? `${buf};${piece}` : piece
    const text = buf.trim()
    if (!text) {
      buf = ''
      continue
    }
    // 触发器块：从 CREATE TRIGGER 起累积，直到以 END 结束
    if (/^CREATE\s+TRIGGER/i.test(text) && !/\bEND\s*$/i.test(text)) continue
    out.push(text)
    buf = ''
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

const v1Set = new Map()
const v1List = splitStatements(sqlV1)
for (const s of v1List) v1Set.set(norm(s), (v1Set.get(norm(s)) ?? 0) + 1)
const v2Set = new Map()
const v2List = splitStatements(sqlV2)
for (const s of v2List) v2Set.set(norm(s), (v2Set.get(norm(s)) ?? 0) + 1)
ok(`语句切分：1_init.sql ${v1List.length} 条、2_fts_trigram.sql ${v2List.length} 条（触发器块未被切碎）`)

const schemaSet = schema.SCHEMA_STATEMENTS.map(norm)
const ftsSet = schema.FTS_TRIGRAM_STATEMENTS.map(norm)

assert(
  new Set(schemaSet).size === schemaSet.length,
  `SCHEMA_STATEMENTS 无重复语句（${schemaSet.length} 条）`,
)
assert(
  new Set(ftsSet).size === ftsSet.length,
  `FTS_TRIGRAM_STATEMENTS 无重复语句（${ftsSet.length} 条）`,
)

const missingInV1 = schemaSet.filter((s) => !v1Set.has(s))
assert(missingInV1.length === 0, `SCHEMA_STATEMENTS 每条都能在 1_init.sql 找到（漏执行数 = ${missingInV1.length}）`)
if (missingInV1.length) missingInV1.forEach((s) => bad(`  漏: ${s.slice(0, 90)}…`))

const missingInV2 = ftsSet.filter((s) => !v2Set.has(s))
assert(missingInV2.length === 0, `FTS_TRIGRAM_STATEMENTS 每条都能在 2_fts_trigram.sql 找到（漏执行数 = ${missingInV2.length}）`)
if (missingInV2.length) missingInV2.forEach((s) => bad(`  漏: ${s.slice(0, 90)}…`))

// 反向：迁移文件里除「回填 INSERT」外，不应有 schema.ts 不知道的语句
const backfill = ftsSet.includes(norm('INSERT INTO notes_fts_trigram(title, content, note_id) SELECT title, content, id FROM notes'))
const extraV2 = [...v2Set.keys()].filter((s) => !ftsSet.includes(s))
assert(
  extraV2.length === 0,
  `2_fts_trigram.sql 没有 schema.ts 未登记的语句（额外 ${extraV2.length} 条）${backfill ? '（回填 INSERT 已登记）' : ''}`,
)
if (extraV2.length) extraV2.forEach((s) => bad(`  额外: ${s.slice(0, 90)}…`))

/* ================= C. FTS5 虚拟表 / 触发器 / 中文检索 ================= */

console.log('\n── C. 全新库上应用两份迁移：FTS5 虚拟表、同步触发器、中文检索')

const mem = new DatabaseSync(':memory:')
mem.exec(sqlV1)
mem.exec(sqlV2)

const trigramAvailable = (() => {
  try {
    mem.exec("CREATE VIRTUAL TABLE temp.__probe USING fts5(x, tokenize='trigram')")
    mem.exec('DROP TABLE temp.__probe')
    return true
  } catch {
    return false
  }
})()
assert(trigramAvailable, `node:sqlite ${mem.prepare('select sqlite_version() v').get().v} 支持 FTS5 + trigram tokenizer`)

const objects = mem
  .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'notes_fts%' OR name LIKE 'trg_notes%' ORDER BY type, name")
  .all()
const has = (t, n) => objects.some((o) => o.type === t && o.name === n)
assert(has('table', 'notes_fts'), 'FTS5 虚拟表 notes_fts（v1 unicode61）已创建')
assert(has('table', 'notes_fts_trigram'), 'FTS5 虚拟表 notes_fts_trigram（v2 trigram）已创建')
for (const t of ['trg_notes_ai', 'trg_notes_au', 'trg_notes_ad', 'trg_notes_tri_ai', 'trg_notes_tri_au', 'trg_notes_tri_ad']) {
  assert(has('trigger', t), `同步触发器 ${t} 已创建`)
}

// 插一条中文笔记（走 real SQL，不经过仓储代码）
const now = Date.now()
mem.prepare(
  'INSERT INTO notes(id,title,content,folder_id,tags,pinned,sort_order,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
).run('n1', '我的笔记本', '这是一段关于中文检索的正文，包含便签二字。', null, '[]', 0, 0, now, now, null)

const c = (sql, ...p) => mem.prepare(sql).all(...p).length
assert(
  c("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?", '笔记') === 0,
  'v1 unicode61 表：MATCH「笔记」= 0 命中 ⇒ **确认 v1 表不用于中文子串检索**',
)
assert(
  c("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?", '我的笔记本') === 1,
  'v1 unicode61 表：MATCH「我的笔记本」（整词）= 1 命中 ⇒ 连续汉字是单 token 的直接证据',
)
assert(
  c("SELECT rowid FROM notes_fts_trigram WHERE notes_fts_trigram MATCH ?", '笔记') === 0,
  'trigram 表：MATCH「笔记」（2 字，短于 3） = 0 命中 ⇒ trigram 的硬限制，必须走 LIKE 兜底',
)
assert(
  c("SELECT rowid FROM notes_fts_trigram WHERE notes_fts_trigram MATCH ?", '笔记本') === 1,
  'trigram 表：MATCH「笔记本」（3 字）= 1 命中 ⇒ **≥3 字符中文子串可命中**',
)
assert(
  c("SELECT rowid FROM notes_fts_trigram WHERE notes_fts_trigram MATCH ?", '中文检索') === 1,
  'trigram 表：MATCH「中文检索」（正文 4 字）= 1 命中 ⇒ 正文也可检索',
)
assert(
  c("SELECT id FROM notes WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'", '%笔记%', '%笔记%') === 1,
  'LIKE 兜底：「%笔记%」= 1 命中 ⇒ **<3 字符路径真实可用**',
)
assert(
  c("SELECT id FROM notes WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'", '%便签%', '%便签%') === 1,
  'LIKE 兜底：「%便签%」（2 字，正文命中）= 1 命中',
)
assert(
  c("SELECT id FROM notes WHERE title LIKE ? ESCAPE '\\'", '%笔记%') === 1,
  '任务书要求的场景成立：「我的笔记本」能被「笔记」搜到（LIKE 路径）',
)

// 触发器同步（INSERT / UPDATE / DELETE）
mem.prepare(
  'INSERT INTO notes(id,title,content,folder_id,tags,pinned,sort_order,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
).run('n2', '触发器同步测试', 'alpha', null, '[]', 0, 0, now, now, null)
assert(
  c('SELECT rowid FROM notes_fts_trigram WHERE note_id = ?', 'n2') === 1,
  'INSERT 后 trigram 表出现对应行（trg_notes_tri_ai 生效）',
)
mem.prepare('UPDATE notes SET content = ? WHERE id = ?').run('beta', 'n2')
assert(
  c('SELECT rowid FROM notes_fts_trigram WHERE note_id = ? AND notes_fts_trigram MATCH ?', 'n2', 'beta') === 1 &&
    c('SELECT rowid FROM notes_fts_trigram WHERE note_id = ? AND notes_fts_trigram MATCH ?', 'n2', 'alpha') === 0,
  'UPDATE 后 trigram 表内容替换、旧词消失（trg_notes_tri_au 生效，无重复行）',
)
mem.prepare('DELETE FROM notes WHERE id = ?').run('n2')
assert(c('SELECT rowid FROM notes_fts_trigram WHERE note_id = ?', 'n2') === 0, 'DELETE 后 trigram 行被清除（trg_notes_tri_ad 生效）')

// 幂等：重跑两份迁移不破坏数据、不重复
const before = c('SELECT rowid FROM notes_fts_trigram')
mem.exec(sqlV1)
mem.exec(sqlV2)
const after = c('SELECT rowid FROM notes_fts_trigram')
assert(after === 1 && before === 1, `重跑两份迁移幂等：trigram 行数 ${before} → ${after}（回填 DELETE+INSERT 重建索引）`)

// 迁移文件不得修改已发布的 v1 对象
assert(
  !/\b(DROP|ALTER)\b/i.test(sqlV2),
  '2_fts_trigram.sql 中不存在 DROP/ALTER（不修改 v1 已发布对象）',
)

// 默认主题（需求 m：默认淡黄色）
assert(schema.DEFAULT_THEME_ID === 'paper-yellow', `DEFAULT_THEME_ID = ${schema.DEFAULT_THEME_ID}（默认淡黄色主题）`)
const py = schema.THEMES.find((t) => t.id === 'paper-yellow')
assert(
  py?.light?.['zj-bg'] === '#FDF8EC' && py?.dark?.['zj-bg'] !== undefined,
  `paper-yellow 主题定义完整：light.zj-bg=${py?.light?.['zj-bg']}、dark.zj-bg=${py?.dark?.['zj-bg']}；共 ${schema.THEMES.length} 套主题`,
)

mem.close()

console.log('\n' + '─'.repeat(72))
console.log(`迁移/检索核对：通过 ${pass}，失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('✅ 迁移不可变性 + 双源一致性 + FTS5/中文检索 全部通过')
