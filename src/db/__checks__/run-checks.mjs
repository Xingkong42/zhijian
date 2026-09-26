#!/usr/bin/env node
/**
 * 纸笺 · 数据层自检（不需要 Tauri / Rust / 桌面环境）
 * ============================================================================
 * 运行：node src/db/__checks__/run-checks.mjs        （退出码 0 = 全部通过）
 *
 * 阶段 A —— 迁移与 SQL 结构
 *   1. 用真实 SQLite 引擎（node:sqlite，3.53.x；应用运行时的 bundled 版本 3.46.0）
 *      整体执行 src-tauri/migrations/1_init.sql + 2_fts_trigram.sql；
 *   2. 执行 migration.check.sql 的 22 条断言（结构 / 索引 / FTS 触发器 / 中文检索行为 /
 *      存储类 / 外键 / settings 表）；
 *   3. 逐条 prepare 执行 src/db/schema.ts 的 SCHEMA_STATEMENTS + FTS_TRIGRAM_STATEMENTS
 *      （initDb() 就是逐条 execute，本步骤保证每条语句都能独立编译）；
 *   4. 复跑两份迁移验证幂等；
 *   5. 校验 schema.ts 与 migrations/*.sql 的一致性（条款逐句归一化比对）。
 *
 * 阶段 B —— 仓储全流程
 *   把 @tauri-apps/plugin-sql 换成 node:sqlite 适配器（loader.mjs + stub-*），
 *   直接在 Node 里 import 真实的 src/db/*.ts，跑
 *   initDb / notesRepo / foldersRepo / tagsRepo / searchRepo 的完整用例。
 *
 * 阶段 C —— 契约静态检查
 *   所有 SQL 常量的 $N 占位符必须按首现顺序严格递增（tauri-plugin-sql 按下标绑定），
 *   动态构造器（listAll / update）的代表性组合同理。
 *
 * t28 追加的三条收尾检查（防回归）：
 *   1. 临时根已清理（清理放在 finally，异常路径也会执行）；
 *   2. 注入 db 层的 FsPort 从未收到"临时根之外/相对路径"（否则会在仓库/CWD 造垃圾文件）；
 *   3. **仓库根目录未新增文件**（工作区零污染）。
 * ⚠️ 不要在 PowerShell 里用 `node run-checks.mjs | Select-Object -First N` 截断输出：
 *    管道提前关闭会**杀掉**本进程，finally 就不再执行（残留的临时根会在下次运行时被 janitor 清掉）。
 */

import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..')
const migrationsDir = path.join(projectRoot, 'src-tauri', 'migrations')
const MIGRATION_V1 = path.join(migrationsDir, '1_init.sql')
const MIGRATION_V2 = path.join(migrationsDir, '2_fts_trigram.sql')
const CHECK_SQL = path.join(here, 'migration.check.sql')

register(new URL('./loader.mjs', import.meta.url).href)

/* ------------------------------ 断言工具 ------------------------------ */

const results = []
let currentGroup = '(未分组)'

function group(title) {
  currentGroup = title
  console.log(`\n── ${title}`)
}

async function check(name, fn) {
  try {
    await fn()
    results.push({ group: currentGroup, name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ group: currentGroup, name, ok: false, error: message })
    console.log(`  ❌ ${name}\n     ↳ ${message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}：期望 ${b}，实际 ${a}`)
}

async function assertRejects(fn, pattern, message) {
  try {
    await fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (pattern && !pattern.test(text)) throw new Error(`${message ?? '错误信息不匹配'}：${text}`)
    return
  }
  throw new Error(`${message ?? '期望抛出可读 Error'}，但调用成功返回了`)
}

/** 归一化 SQL 文本：折叠空白、去掉尾部分号，用于 schema.ts ↔ migrations/*.sql 比对 */
function normalizeSql(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

/* ============================ 阶段 0：载入 ============================ */

const schema = await import('../schema.ts')
const db = await import('../index.ts')
const { notesRepo } = await import('../notes.ts')
const { foldersRepo } = await import('../folders.ts')
const { tagsRepo } = await import('../tags.ts')
const { searchRepo, buildSnippet, DEFAULT_SEARCH_LIMIT } = await import('../search.ts')
const stub = await import('./stub-plugin-sql.mjs')

/* --- t15：md 文件是真相源，所以自检必须先注入「真实文件系统 + 临时 vault」 ---
   --- t28：临时根用 mkdtemp 唯一化 + FsPort 加"仅限临时根内绝对路径"护栏 + finally 清理 --- */
const { nodeFsPort } = await import('./node-fs-port.mjs')
const { makeRunRoot, cleanupRunRoot, guardFsPort, snapshotWorkspace, diffWorkspace, listZeroByteRootFiles } = await import('./harness.mjs')

const runRoot = await makeRunRoot('dbcheck')
const vaultRoot = path.join(runRoot, 'Documents', '纸笺')
const appDataDir = path.join(runRoot, 'AppData')
await nodeFsPort.mkdir(vaultRoot, { recursive: true })
await nodeFsPort.mkdir(appDataDir, { recursive: true })
const guarded = guardFsPort(nodeFsPort, { root: runRoot, label: 'run-checks' })
db.configureStorage({
  fs: guarded.port,
  vaultRoot,
  appDataDir,
  legacyDbPath: path.join(appDataDir, 'zhijian.db'),
})
/** 运行前的工作区快照（收尾断言"仓库根目录未新增文件"） */
const workspaceBefore = snapshotWorkspace(projectRoot)

const v1Sql = readFileSync(MIGRATION_V1, 'utf8')
const v2Sql = readFileSync(MIGRATION_V2, 'utf8')
const checkSqlText = readFileSync(CHECK_SQL, 'utf8')

console.log('纸笺 · 数据层自检')
console.log(`项目根目录：${projectRoot}`)
console.log(`SQLite 引擎（自检替身）：${new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v}`)
console.log(`临时根（真实文件系统，唯一名）：${runRoot}`)

/* ================== 阶段 A：迁移 / 结构 / 行为断言 ================== */
/* 整个主体包在 try 里：任何未捕获异常都会被记成一条失败项，
   finally 里必定清理临时根 + 断言工作区零污染（t28）。 */
try {

group('A1 迁移文件：可解析、断言清单、幂等、逐条可执行')


await check('1_init.sql + 2_fts_trigram.sql + migration.check.sql 全部可被 SQLite 解析执行', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  scratch.exec(v1Sql)
  scratch.exec(v2Sql)
  scratch.exec(checkSqlText)
  scratch.close()
})

await check('migration.check.sql 的 22 条断言全部通过（ok = 1）', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  scratch.exec(v1Sql)
  scratch.exec(v2Sql)
  scratch.exec(checkSqlText)
  const rows = scratch.prepare('SELECT name, ok FROM check_results ORDER BY rowid').all()
  const failed = rows.filter((row) => Number(row.ok) !== 1)
  const total = rows.length
  scratch.close()
  assert(total >= 22, `断言条数不足：${total}`)
  assertEqual(failed.map((row) => row.name), [], 'migration.check.sql 有失败断言')
})

await check('schema.ts 的每条语句都能独立 prepare + execute（initDb 的执行粒度）', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  const statements = [...schema.SCHEMA_STATEMENTS, ...schema.FTS_TRIGRAM_STATEMENTS]
  for (const statement of statements) {
    scratch.prepare(statement).run()
  }
  // 再执行一次：全部 IF NOT EXISTS / 幂等
  for (const statement of statements) {
    scratch.prepare(statement).run()
  }
  scratch.close()
})

await check('复跑两份迁移：幂等（无异常且 FTS 行数不变）', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  scratch.exec(v1Sql)
  scratch.exec(v2Sql)
  scratch.exec(checkSqlText)
  const before = scratch.prepare('SELECT (SELECT COUNT(*) FROM notes) AS n, (SELECT COUNT(*) FROM notes_fts_trigram) AS t').get()
  scratch.exec(v1Sql)
  scratch.exec(v2Sql)
  const after = scratch.prepare('SELECT (SELECT COUNT(*) FROM notes) AS n, (SELECT COUNT(*) FROM notes_fts_trigram) AS t').get()
  scratch.close()
  assertEqual([after.n, after.t], [before.n, before.t], '复跑迁移后行数变化')
})

await check('SCHEMA_MIGRATIONS 版本单调递增，且 v2 标记为 optional', () => {
  const versions = schema.SCHEMA_MIGRATIONS.map((migration) => migration.version)
  assertEqual(versions, [1, 2], '迁移版本序列')
  assertEqual(schema.SCHEMA_VERSION, 2, 'SCHEMA_VERSION')
  assertEqual(schema.SCHEMA_MIGRATIONS[1].optional, true, 'v2 必须 optional')
  assertEqual(schema.SCHEMA_MIGRATIONS[0].optional, undefined, 'v1 不应标记 optional')
})

group('A2 schema.ts ↔ migrations/*.sql 双源一致性')

await check('SCHEMA_STATEMENTS 逐条出现在 1_init.sql 中', () => {
  const haystack = normalizeSql(v1Sql)
  const missing = schema.SCHEMA_STATEMENTS.map(normalizeSql).filter((statement) => !haystack.includes(statement))
  assertEqual(missing, [], 'schema.ts 有语句未落到 1_init.sql')
})

await check('FTS_TRIGRAM_STATEMENTS 逐条出现在 2_fts_trigram.sql 中', () => {
  const haystack = normalizeSql(v2Sql)
  const missing = schema.FTS_TRIGRAM_STATEMENTS.map(normalizeSql).filter((statement) => !haystack.includes(statement))
  assertEqual(missing, [], 'schema.ts 有语句未落到 2_fts_trigram.sql')
})

await check('2_fts_trigram.sql 不修改 v1 已发布对象（无 DROP/ALTER）', () => {
  const normalized = normalizeSql(v2Sql).toUpperCase()
  assert(!normalized.includes('DROP '), '可选迁移中不允许 DROP（可能让降级环境失去全文索引）')
  assert(!normalized.includes('ALTER '), '已发布迁移不允许 ALTER')
})

/* ================== 阶段 B：仓储全流程（真实 SQL） ================== */

group('B1 initDb / 能力探测')

await check('initDb() 打开连接、执行 v1+v2 迁移、探测到 trigram 可用', async () => {
  await db.initDb()
  assert(db.isDbReady(), 'isDbReady() 应为 true')
  assert(db.isFtsTrigramAvailable(), 'FTS5 trigram 应可用')
  const diagnostics = db.getFtsDiagnostics()
  assertEqual(diagnostics.strategy, 'fts5-trigram', '检索策略')
  assertEqual(diagnostics.fts5Compiled, true, 'ENABLE_FTS5 编译开关')
  assert(typeof diagnostics.sqliteVersion === 'string' && diagnostics.sqliteVersion.length > 0, 'SQLite 版本可读')
})

await check('initDb() 幂等：重复调用返回同一实例', async () => {
  const first = await db.initDb()
  const second = await db.initDb()
  assert(first === second, '重复 initDb() 不应重新打开连接')
})

await check('迁移记录写入 _zj_migrations（版本 1、2）', () => {
  const handle = stub.__handle()
  const versions = handle.prepare('SELECT version FROM _zj_migrations ORDER BY version').all().map((row) => Number(row.version))
  assertEqual(versions, [1, 2], '_zj_migrations 记录')
})

group('B2 foldersRepo')

const folderWork = await foldersRepo.create({ name: '工作' })
const folderChild = await foldersRepo.create({ name: '项目', parentId: folderWork.id })
const folderStudy = await foldersRepo.create({ name: '学习' })

await check('create：顶层与子级排序位各自独立递增', () => {
  assertEqual(folderWork.order, 0, '首个顶层 order')
  assertEqual(folderStudy.order, 1, '第二个顶层 order')
  assertEqual(folderChild.order, 0, '子级 order 独立计数')
  assertEqual(folderChild.parentId, folderWork.id, 'parentId')
})

await check('list：顶层优先，同层按 sort_order（另含 name 字段完整性）', async () => {
  const list = await foldersRepo.list()
  assertEqual(list.map((folder) => folder.name), ['工作', '学习', '项目'], '扁平列表顺序')
  assert(list.every((folder) => typeof folder.createdAt === 'number' && folder.createdAt > 0), 'createdAt 应为毫秒数')
})

await check('tree：递归结构与 children', async () => {
  const tree = await foldersRepo.tree()
  assertEqual(tree.map((node) => node.name), ['工作', '学习'], '根节点')
  assertEqual(tree[0].children.map((node) => node.name), ['项目'], '子节点')
})

await check('rename：改名后返回最新实体；空名抛可读 Error', async () => {
  const renamed = await foldersRepo.rename(folderStudy.id, '  读书  ')
  assertEqual(renamed.name, '读书', '名称应 trim')
  await assertRejects(() => foldersRepo.rename(folderStudy.id, '   '), /不能为空/, '空名应报错')
  await assertRejects(() => foldersRepo.create({ name: '' }), /不能为空/, '空名创建应报错')
})

/* ------------------------------ notesRepo ------------------------------ */

group('B3 notesRepo：增删改查')

const noteMeeting = await notesRepo.create({ title: '会议纪要', content: '第一季度规划：桌面端应用。' })
const noteNotebook = await notesRepo.create({ title: '我的笔记本', content: '这是第一篇笔记，讲中文全文检索。' })
const noteWork = await notesRepo.create({
  folderId: folderWork.id,
  title: '工作笔记',
  content: '项目排期与里程碑。',
  tags: ['工作', '重要'],
})

await check('create：收件箱新笔记排在最前，字段落库正确', async () => {
  const inbox = await notesRepo.listByFolder(null)
  assertEqual(inbox.map((note) => note.id), [noteNotebook.id, noteMeeting.id], '收件箱顺序（新的在前）')
  assertEqual(noteNotebook.folderId, null, 'folderId')
  assertEqual(noteNotebook.deletedAt, null, 'deletedAt')
  assertEqual(noteNotebook.pinned, false, 'pinned 默认 false')
  assertEqual(noteWork.tags, ['工作', '重要'], 'tags')
})

await check('create：标签自动建定义 + note_tags 关系 + JSON 镜像（三处一致）', async () => {
  const handle = stub.__handle()
  const row = handle.prepare('SELECT tags FROM notes WHERE id = ?').get(noteWork.id)
  assertEqual(JSON.parse(row.tags), ['工作', '重要'], 'notes.tags JSON 镜像')
  const links = handle.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE note_id = ?').get(noteWork.id)
  assertEqual(Number(links.c), 2, 'note_tags 关系条数')
  const tagNames = (await tagsRepo.list()).map((tag) => tag.name)
  assert(tagNames.includes('工作') && tagNames.includes('重要'), '标签定义自动创建')
})

await check('create：不存在的 folderId 抛可读 Error', async () => {
  await assertRejects(() => notesRepo.create({ folderId: 'not-exist' }), /文件夹不存在/, '非法 folderId')
})

await check('get / listAll / listByFolder / listByTag 过滤正确', async () => {
  const fetched = await notesRepo.get(noteMeeting.id)
  assertEqual(fetched.title, '会议纪要', 'get.title')
  assertEqual(await notesRepo.get('not-exist'), null, 'get 不存在的 id 返回 null')
  assertEqual((await notesRepo.listByFolder(folderWork.id)).map((note) => note.id), [noteWork.id], 'listByFolder')
  assertEqual((await notesRepo.listByTag('重要')).map((note) => note.id), [noteWork.id], 'listByTag')
  assertEqual((await notesRepo.listAll()).length, 3, 'listAll 默认排除软删除')
})

await check('update：字段更新 + 自动刷新 updatedAt', async () => {
  const before = (await notesRepo.get(noteMeeting.id)).updatedAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  const updated = await notesRepo.update(noteMeeting.id, {
    title: '会议纪要 v2',
    content: '改成了完全不同的内容。',
    pinned: true,
  })
  assertEqual(updated.title, '会议纪要 v2', 'title')
  assertEqual(updated.pinned, true, 'pinned')
  assert(updated.updatedAt > before, 'updatedAt 必须刷新')
})

await check('update：folderId 未提供时不清空，显式 null 才清空', async () => {
  const kept = await notesRepo.update(noteWork.id, { title: '工作笔记 v2' })
  assertEqual(kept.folderId, folderWork.id, '未提供 folderId 时应保持原值')
  const cleared = await notesRepo.update(noteWork.id, { folderId: null })
  assertEqual(cleared.folderId, null, '显式 null 应清空')
  await notesRepo.update(noteWork.id, { folderId: folderWork.id })
})

await check('update：空 patch 也会刷新 updatedAt', async () => {
  const before = (await notesRepo.get(noteNotebook.id)).updatedAt
  await new Promise((resolve) => setTimeout(resolve, 5))
  const touched = await notesRepo.update(noteNotebook.id, {})
  assert(touched.updatedAt > before, '空 patch 的 updatedAt 未刷新')
})

await check('update：tags patch 同步 note_tags 与 JSON 镜像', async () => {
  const updated = await notesRepo.update(noteMeeting.id, { tags: ['重要'] })
  assertEqual(updated.tags, ['重要'], 'tags 返回值')
  const handle = stub.__handle()
  const links = handle.prepare(
    'SELECT COUNT(*) AS c FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? AND t.name = ?',
  ).get(noteMeeting.id, '重要')
  assertEqual(Number(links.c), 1, 'note_tags 应指向"重要"')
})

await check('setTags：覆盖式（幂等），返回最新 Note', async () => {
  const first = await notesRepo.setTags(noteNotebook.id, ['重要', '重要', ' '])
  assertEqual(first.tags, ['重要'], '规范化 + 去重')
  const second = await notesRepo.setTags(noteNotebook.id, ['重要'])
  assertEqual(second.tags, ['重要'], '重复调用结果一致')
  const cleared = await notesRepo.setTags(noteNotebook.id, [])
  assertEqual(cleared.tags, [], '清空标签')
})

await check('软删除 / 回收站视图 / 恢复 / 物理删除', async () => {
  await notesRepo.remove(noteMeeting.id)
  assertEqual(await notesRepo.get(noteMeeting.id), null, '软删除后 get 返回 null')
  assertEqual((await notesRepo.listAll()).some((note) => note.id === noteMeeting.id), false, '默认列表不含软删除')
  assertEqual(
    (await notesRepo.listAll({ onlyDeleted: true })).map((note) => note.id),
    [noteMeeting.id],
    '回收站视图',
  )
  assertEqual((await notesRepo.listAll({ includeDeleted: true })).length, 3, 'includeDeleted')

  const restored = await notesRepo.restore(noteMeeting.id)
  assertEqual(restored.deletedAt, null, '恢复后 deletedAt 为 null')
  assertEqual((await notesRepo.listAll()).length, 3, '恢复后回到正常列表')

  await notesRepo.remove(noteMeeting.id)
  await notesRepo.hardDelete(noteMeeting.id)
  assertEqual(await notesRepo.get(noteMeeting.id), null, '物理删除后不可读')
  const handle = stub.__handle()
  const fts = handle.prepare('SELECT COUNT(*) AS c FROM notes_fts_trigram WHERE note_id = ?').get(noteMeeting.id)
  assertEqual(Number(fts.c), 0, '物理删除应清理 FTS 行')
  await assertRejects(() => notesRepo.hardDelete('not-exist'), /不存在/, '删除不存在的笔记应报错')
})

group('B4 notesRepo：拖拽排序 move')

const folderSort = await foldersRepo.create({ name: '排序测试' })
const noteA = await notesRepo.create({ folderId: folderSort.id, title: 'A' })
const noteB = await notesRepo.create({ folderId: folderSort.id, title: 'B' })
const noteC = await notesRepo.create({ folderId: folderSort.id, title: 'C' })

const titlesIn = async (folderId) => (await notesRepo.listByFolder(folderId)).map((note) => note.title)

await check('新笔记排在文件夹最前（C, B, A）', async () => {
  assertEqual(await titlesIn(folderSort.id), ['C', 'B', 'A'], '初始顺序')
})

await check('move 到 index 0：同文件夹内整数重排', async () => {
  await notesRepo.move(noteA.id, { targetIndex: 0 })
  assertEqual(await titlesIn(folderSort.id), ['A', 'C', 'B'], '移到最前')
  const handle = stub.__handle()
  const orders = handle.prepare('SELECT title, sort_order FROM notes WHERE folder_id = ? ORDER BY sort_order').all(folderSort.id)
  assertEqual(orders.map((row) => Number(row.sort_order)), [0, 1, 2], 'sort_order 应为连续整数')
})

await check('move 到末尾 / 中间', async () => {
  await notesRepo.move(noteA.id, { targetIndex: 2 })
  assertEqual(await titlesIn(folderSort.id), ['C', 'B', 'A'], '移到末尾')
  await notesRepo.move(noteA.id, { targetIndex: 1 })
  assertEqual(await titlesIn(folderSort.id), ['C', 'A', 'B'], '移到中间')
})

await check('move 越界 targetIndex 视为末尾', async () => {
  await notesRepo.move(noteA.id, { targetIndex: 99 })
  assertEqual(await titlesIn(folderSort.id), ['C', 'B', 'A'], '越界不报错')
})

await check('move 跨文件夹：目标文件夹重排 + 原文件夹移除', async () => {
  const moved = await notesRepo.move(noteA.id, { targetIndex: 0, folderId: folderWork.id })
  assertEqual(moved.folderId, folderWork.id, 'folderId 应更新')
  assertEqual((await titlesIn(folderSort.id)).includes('A'), false, '原文件夹不应再有 A')
  assertEqual((await titlesIn(folderWork.id))[0], 'A', '目标文件夹首位应是 A')
  const handle = stub.__handle()
  const row = handle.prepare('SELECT typeof(updated_at) AS t FROM notes WHERE id = ?').get(noteA.id)
  assertEqual(row.t, 'integer', 'updated_at 必须是 INTEGER 存储类（CAST 生效）')
})

await check('move：不存在的笔记 / 文件夹抛可读 Error', async () => {
  await assertRejects(() => notesRepo.move('not-exist', { targetIndex: 0 }), /不存在/, '不存在的笔记')
  await assertRejects(() => notesRepo.move(noteB.id, { targetIndex: 0, folderId: 'not-exist' }), /文件夹不存在/, '不存在的文件夹')
})

group('B5 notesRepo：counts 与目录删除语义')

await check('counts：all / trash / byFolder / byTag', async () => {
  const handle = stub.__handle()
  const live = Number(handle.prepare('SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NULL').get().c)
  const trash = Number(handle.prepare('SELECT COUNT(*) AS c FROM notes WHERE deleted_at IS NOT NULL').get().c)
  const counts = await notesRepo.counts()
  assertEqual(counts.all, live, 'all')
  assertEqual(counts.trash, trash, 'trash')
  assertEqual(counts.byFolder[folderSort.id] ?? 0, 2, 'byFolder（排序测试文件夹剩 B、C）')
  assert(typeof counts.byTag['重要'] === 'number', 'byTag 应包含"重要"')
})

await check('foldersRepo.remove：子树删除 + 其中笔记回到收件箱（并刷新 updatedAt）', async () => {
  const beforeInbox = (await notesRepo.listByFolder(null)).length
  await foldersRepo.remove(folderWork.id)
  const foldersNow = (await foldersRepo.list()).map((folder) => folder.id)
  assertEqual(foldersNow.includes(folderWork.id), false, '父文件夹已删除')
  assertEqual(foldersNow.includes(folderChild.id), false, '子文件夹应被级联删除')
  const inbox = await notesRepo.listByFolder(null)
  assertEqual(inbox.length > beforeInbox, true, '原文件夹内的笔记应回到收件箱')
  assert(inbox.every((note) => note.folderId === null), '收件箱笔记 folderId 必须为 null')
})

group('B5b 排序 / deletedAt patch / 组合过滤')

await check('update({ deletedAt })：同一入口也能软删除与恢复', async () => {
  const note = await notesRepo.create({ title: 'deletedAt 用例' })
  const trashed = await notesRepo.update(note.id, { deletedAt: Date.now() })
  assert(trashed.deletedAt !== null, 'update 应能写入 deletedAt')
  assertEqual(await notesRepo.get(note.id), null, '软删除后 get 为 null')
  const restored = await notesRepo.update(note.id, { deletedAt: null })
  assertEqual(restored.deletedAt, null, 'deletedAt = null 即恢复')
  await notesRepo.hardDelete(note.id)
})

await check('listAll 排序：order / updatedAt / createdAt / title × direction', async () => {
  const folder = await foldersRepo.create({ name: '排序断言' })
  const beta = await notesRepo.create({ folderId: folder.id, title: 'Beta', content: 'b' })
  await new Promise((resolve) => setTimeout(resolve, 3))
  const alpha = await notesRepo.create({ folderId: folder.id, title: 'Alpha', content: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 3))
  await notesRepo.update(beta.id, { content: 'b2' })

  const byOrder = await notesRepo.listAll({ folderId: folder.id })
  assertEqual(byOrder.map((note) => note.title), ['Alpha', 'Beta'], '默认 order（新建在前）')
  const byUpdated = await notesRepo.listAll({ folderId: folder.id, sortBy: 'updatedAt' })
  assertEqual(byUpdated[0].title, 'Beta', 'updatedAt 默认方向 desc')
  const byCreated = await notesRepo.listAll({ folderId: folder.id, sortBy: 'createdAt', direction: 'asc' })
  assertEqual(byCreated.map((note) => note.title), ['Beta', 'Alpha'], 'createdAt asc')
  const byTitle = await notesRepo.listAll({ folderId: folder.id, sortBy: 'title' })
  assertEqual(byTitle.map((note) => note.title), ['Alpha', 'Beta'], 'title asc（NOCASE）')

  await notesRepo.setTags(beta.id, ['排序标签'])
  const combo = await notesRepo.listAll({ folderId: folder.id, tagName: '排序标签' })
  assertEqual(combo.map((note) => note.title), ['Beta'], 'folder + tagName 组合过滤')

  await notesRepo.hardDelete(beta.id)
  await notesRepo.hardDelete(alpha.id)
  await foldersRepo.remove(folder.id)
})

group('B6 tagsRepo')

await check('create：重复名抛可读 Error（CONSTRAINT）', async () => {
  const tag = await tagsRepo.create({ name: '读书' })
  assertEqual(tag.color, '#C9A227', '默认色')
  await assertRejects(() => tagsRepo.create({ name: '读书' }), /已存在/, '重复标签名')
  await assertRejects(() => tagsRepo.create({ name: '  ' }), /不能为空/, '空标签名')
  const colored = await tagsRepo.create({ name: '灵感', color: '#5B7C99' })
  assertEqual(colored.color, '#5B7C99', '自定义色')
})

await check('rename：改名成功 / 重名报错 / 不存在报错', async () => {
  const tag = (await tagsRepo.list()).find((item) => item.name === '灵感')
  const renamed = await tagsRepo.rename(tag.id, '灵感 2')
  assertEqual(renamed.name, '灵感 2', '改名结果')
  await assertRejects(() => tagsRepo.rename(tag.id, '读书'), /已存在/, '重名')
  await assertRejects(() => tagsRepo.rename('not-exist', 'x'), /不存在/, '不存在的标签')
})

await check('setNoteTags：幂等替换 + 自动建标签 + 返回最终名单', async () => {
  const note = await notesRepo.create({ title: '标签用例' })
  const first = await tagsRepo.setNoteTags(note.id, [' 甲 ', '乙', '乙', ''])
  assertEqual(first, ['甲', '乙'], '规范化 + 去重')
  const second = await tagsRepo.setNoteTags(note.id, ['甲', '乙'])
  assertEqual(second, ['甲', '乙'], '重复调用幂等')
  const third = await tagsRepo.setNoteTags(note.id, [])
  assertEqual(third, [], '清空')
  const handle = stub.__handle()
  const links = handle.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE note_id = ?').get(note.id)
  assertEqual(Number(links.c), 0, '清空后不应残留关系')
  const names = (await tagsRepo.list()).map((tag) => tag.name)
  assert(names.includes('甲') && names.includes('乙'), '自动创建的标签定义应保留')
  await assertRejects(() => tagsRepo.setNoteTags('not-exist', ['甲']), /不存在/, '不存在的笔记')
})

await check('noteIdsByTag：排除软删除笔记', async () => {
  const note = await notesRepo.create({ title: '标签查询用例' })
  await tagsRepo.setNoteTags(note.id, ['查询标签'])
  const tag = (await tagsRepo.list()).find((item) => item.name === '查询标签')
  assertEqual(await tagsRepo.noteIdsByTag(tag.id), [note.id], '命中笔记')
  await notesRepo.remove(note.id)
  assertEqual(await tagsRepo.noteIdsByTag(tag.id), [], '软删除后应排除')
  await notesRepo.restore(note.id)
})

await check('remove：删除标签定义 + 从所有笔记的 tags 镜像中剔除', async () => {
  const note = await notesRepo.create({ title: '删标签用例' })
  await tagsRepo.setNoteTags(note.id, ['待删', '保留'])
  const doomed = (await tagsRepo.list()).find((item) => item.name === '待删')
  await tagsRepo.remove(doomed.id)
  const after = await notesRepo.get(note.id)
  assertEqual(after.tags, ['保留'], 'notes.tags 镜像应剔除已删标签')
  assertEqual((await tagsRepo.list()).some((tag) => tag.name === '待删'), false, '标签定义应删除')
  assertEqual(await tagsRepo.noteIdsByTag(doomed.id), [], '关系应清空')
  await assertRejects(() => tagsRepo.remove('not-exist'), /不存在/, '不存在的标签')
})

group('B6b tagsRepo.updateColor（t18 侧栏改颜色）')

await check('updateColor：写入 tags.json + 索引 color + 返回更新后的 Tag', async () => {
  const tag = await tagsRepo.create({ name: '颜色用例', color: '#C9A227' })
  const updated = await tagsRepo.updateColor(tag.id, '#5B7C99')
  assertEqual(updated.id, tag.id, 'id 不变')
  assertEqual(updated.name, '颜色用例', '名字不变')
  assertEqual(updated.color, '#5B7C99', '返回规范化后的颜色')
  const listed = (await tagsRepo.list()).find((item) => item.id === tag.id)
  assertEqual(listed.color, '#5B7C99', '索引行的 color 应同步')
  const meta = JSON.parse(readFileSync(path.join(vaultRoot, '.paper', 'tags.json'), 'utf8'))
  assertEqual(meta['颜色用例'].color, '#5B7C99', 'tags.json 里的颜色应同步')
  assertEqual(meta['颜色用例'].id, tag.id, 'tags.json 保留原 id')
})

await check('updateColor：口径与 tagColorOf 一致（3/4/6/8 位 hex；空值与非法值均抛错）', async () => {
  const tag = await tagsRepo.create({ name: '颜色规范化' })
  assertEqual((await tagsRepo.updateColor(tag.id, '#abc')).color, '#AABBCC', '#rgb 应展开为大写 #RRGGBB')
  assertEqual((await tagsRepo.updateColor(tag.id, '#abcd')).color, '#AABBCCDD', '#rgba 应展开为 #RRGGBBAA')
  assertEqual((await tagsRepo.updateColor(tag.id, '#aabbccdd')).color, '#AABBCCDD', '8 位 hex 应大写规范化')
  assertEqual((await tagsRepo.updateColor(tag.id, '#123456')).color, '#123456', '6 位 hex 原样（大写）')
  await assertRejects(() => tagsRepo.updateColor(tag.id, '  '), /不能为空/, '空值应抛可读错误')
  await assertRejects(() => tagsRepo.updateColor(tag.id, '#zz'), /格式非法/, '#zz 应被拒绝')
  await assertRejects(() => tagsRepo.updateColor(tag.id, 'red'), /格式非法/, 'red 应被拒绝')
  await assertRejects(() => tagsRepo.updateColor(tag.id, '#12345'), /格式非法/, '位数不合法应被拒绝')
  await assertRejects(() => tagsRepo.updateColor('not-exist', '#000000'), /不存在/, '不存在的标签应抛错')
})

await check('updateColor：同色重复调用幂等（tags.json 与索引都不被重写）', async () => {
  const tag = await tagsRepo.create({ name: '颜色幂等', color: '#C9A227' })
  const tagsJsonPath = path.join(vaultRoot, '.paper', 'tags.json')
  const first = await tagsRepo.updateColor(tag.id, '#7BA184')
  const bytesAfterFirst = readFileSync(tagsJsonPath, 'utf8')
  const statAfterFirst = await nodeFsPort.stat(tagsJsonPath)

  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await tagsRepo.updateColor(tag.id, '#7BA184')
  assertEqual(second, first, '两次调用返回的 Tag 应完全一致')
  assertEqual(readFileSync(tagsJsonPath, 'utf8'), bytesAfterFirst, 'tags.json 内容不应变化')
  assertEqual(
    (await nodeFsPort.stat(tagsJsonPath)).mtimeMs,
    statAfterFirst.mtimeMs,
    '同色重复调用不得重写 tags.json（mtime 应不变）',
  )

  const lowercase = await tagsRepo.updateColor(tag.id, '#7ba184')
  assertEqual(lowercase.color, '#7BA184', '大小写不同的同色同样视为幂等')
  assertEqual(
    (await tagsRepo.list()).find((item) => item.id === tag.id).color,
    '#7BA184',
    '索引里的颜色应保持',
  )
})

await check('updateColor：不重写任何 md、不刷新笔记 updatedAt', async () => {
  const note = await notesRepo.create({ title: '改色不影响笔记', content: '内容不变', tags: ['颜色用例'] })
  const before = await notesRepo.get(note.id)
  const tag = (await tagsRepo.list()).find((item) => item.name === '颜色用例')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await tagsRepo.updateColor(tag.id, '#4F6B58')
  const after = await notesRepo.get(note.id)
  assertEqual(after.updatedAt, before.updatedAt, '笔记 updatedAt 不得变化')
  assertEqual(after.content, before.content, '笔记内容不得变化')
  assertEqual(after.tags, before.tags, '标签集合不得变化')
  // md 文件也没有被重写：定位该笔记文件并核对（颜色不应出现在 md 里）
  const dirs = [vaultRoot]
  let matched = null
  while (dirs.length > 0) {
    const dir = dirs.shift()
    for (const entry of await nodeFsPort.readDir(dir)) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory) {
        if (!entry.name.startsWith('.')) dirs.push(abs)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      const raw = readFileSync(abs, 'utf8')
      if (raw.includes(note.id)) matched = raw
    }
  }
  assert(matched, '应能定位到该笔记的 md 文件')
  assert(matched.includes('内容不变'), 'md 内容应保持原样')
  assert(!matched.includes('#4F6B58'), '改颜色不应写进 md（md 里没有颜色字段）')
})

group('B7 searchRepo：中文检索两条路径')

const searchNotebook = await notesRepo.create({ title: '我的笔记本', content: '这是第一篇笔记，讲中文全文检索。' })
const searchMeeting = await notesRepo.create({ title: 'Meeting notes', content: 'Quarterly planning for the desktop app.' })
const searchTrigram = await notesRepo.create({ title: '搜索测试', content: 'FTS5 trigram tokenizer 让 中文检索 可用。' })
const searchTrashed = await notesRepo.create({ title: '草稿', content: '中文检索 已删除' })
await notesRepo.remove(searchTrashed.id)
const searchPercent = await notesRepo.create({ title: '进度', content: '达成率 100% 完成，含 a_b 变量名。' })

await check('空 / 全空白查询返回 []', async () => {
  assertEqual(await searchRepo.search(''), [], '空串')
  assertEqual(await searchRepo.search('   \n '), [], '全空白')
  assertEqual(await searchRepo.search(undefined), [], 'undefined')
})

await check('中文 ≥3 字 → FTS5 trigram 路径（bm25 + <mark> snippet）', async () => {
  const hits = await searchRepo.search('中文检索')
  assertEqual(hits.map((hit) => hit.note.id), [searchTrigram.id], '命中集合（软删除笔记不出现）')
  assert(typeof hits[0].rank === 'number', 'rank 应为 number（bm25）')
  assert(hits[0].snippet.includes('<mark>中文检索</mark>'), `snippet 应高亮命中词：${hits[0].snippet}`)
  assert(hits[0].note.title === '搜索测试', 'note 应为完整领域模型')
})

await check('中文 2 字 → LIKE 兜底（trigram 覆盖不到）', async () => {
  const hits = await searchRepo.search('笔记')
  const ids = hits.map((hit) => hit.note.id)
  assert(ids.includes(searchNotebook.id), '应命中「我的笔记本」')
  assert(!ids.includes(searchTrashed.id), '软删除笔记不应出现')
  assert(hits[0].snippet.includes('<mark>笔记</mark>'), `snippet 应高亮：${hits[0].snippet}`)
})

await check('英文词 → 命中；大小写不敏感', async () => {
  const hits = await searchRepo.search('quarterly')
  assertEqual(hits.map((hit) => hit.note.id), [searchMeeting.id], '英文命中')
  const upper = await searchRepo.search('QUARTERLY')
  assertEqual(upper.length, 1, '大小写不敏感')
})

await check('LIKE 兜底的 % / _ 按字面量处理（不产生通配符误命中）', async () => {
  const percent = await searchRepo.search('100%')
  assertEqual(percent.map((hit) => hit.note.id), [searchPercent.id], '"100%" 应精确字面命中')
  const underscore = await searchRepo.search('a_b')
  assertEqual(underscore.map((hit) => hit.note.id), [searchPercent.id], '"a_b" 应精确字面命中')
  const wildcardLike = await searchRepo.search('1%0')
  assertEqual(wildcardLike, [], '"1%0" 不应被当成通配符')
})

await check('limit 生效且被夹紧到安全范围', async () => {
  const limited = await searchRepo.search('笔记', 1)
  assertEqual(limited.length, 1, 'limit = 1')
  const fallback = await searchRepo.search('笔记', 0)
  assert(fallback.length <= DEFAULT_SEARCH_LIMIT, '非法 limit 应回落默认值')
  const huge = await searchRepo.search('', 9999)
  assertEqual(huge, [], '空查询即使 limit 很大也返回 []')
})

await check('恢复软删除笔记后重新可被检索', async () => {
  await notesRepo.restore(searchTrashed.id)
  const hits = await searchRepo.search('已删除')
  assert(hits.some((hit) => hit.note.id === searchTrashed.id), '恢复后应能检索到')
  await notesRepo.remove(searchTrashed.id)
})

await check('buildSnippet：HTML 转义 + 只保留 <mark> 高亮 + 超窗省略号', async () => {
  const escaped = buildSnippet('<script>alert(1)</script> 中文检索 测试', '中文检索')
  assert(!escaped.includes('<script>'), `原始 HTML 必须转义：${escaped}`)
  assert(escaped.includes('&lt;script&gt;'), '尖括号应转义')
  assert(escaped.includes('<mark>中文检索</mark>'), '命中词应高亮')
  const longText = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`
  const windowed = buildSnippet(longText, '关键词')
  assert(windowed.startsWith('…') && windowed.endsWith('…'), '超窗应有省略号')
  assert(windowed.length < longText.length, '应截断')
  assertEqual(buildSnippet('', 'x'), '', '空文本返回空串')
})

await check('检索策略诊断快照自洽', () => {
  const diagnostics = db.getFtsDiagnostics()
  assertEqual(diagnostics.strategy, db.isFtsTrigramAvailable() ? 'fts5-trigram' : 'like', 'strategy 与 isFtsTrigramAvailable 一致')
  assertEqual(diagnostics.trigramReady, true, 'trigramReady')
  assertEqual(diagnostics.reason, null, 'reason 应为 null')
})

group('B8 收尾')

await check('closeDb() 后可重新 initDb()（连接生命周期可控）', async () => {
  await db.closeDb()
  assertEqual(db.isDbReady(), false, 'closeDb 后 isDbReady 应为 false')
  await db.initDb()
  assertEqual(db.isDbReady(), true, '重新 initDb 应成功')
})

/* ==================== 阶段 C：契约静态检查 ==================== */

group('C1 SQL 占位符契约（$N 按首现顺序严格递增）')

const parameterized = Object.entries(schema.SQL).filter(([, sql]) => /\$\d/.test(sql))
const parameterizedIndex = Object.entries(schema.INDEX_SQL).filter(([, sql]) => /\$\d/.test(sql))

await check(`SQL 常量（${parameterized.length} 条带参语句）占位符编号连续且按首现顺序`, () => {
  const problems = []
  for (const [key, sql] of parameterized) {
    const numbers = schema.scanParamNumbers(sql)
    const expected = numbers.map((_, index) => index + 1)
    if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
      problems.push(`${key}: ${JSON.stringify(numbers)}`)
    }
  }
  assertEqual(problems, [], '占位符顺序异常')
})

await check(`INDEX_SQL 常量（${parameterizedIndex.length} 条带参语句）占位符编号连续且按首现顺序`, () => {
  const problems = []
  for (const [key, sql] of parameterizedIndex) {
    const numbers = schema.scanParamNumbers(sql)
    const expected = numbers.map((_, index) => index + 1)
    if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
      problems.push(`${key}: ${JSON.stringify(numbers)}`)
    }
  }
  assertEqual(problems, [], '索引层占位符顺序异常')
})

await check('INDEX_DDL_STATEMENTS 可独立 prepare + execute，且包含文件定位列', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  for (const statement of schema.INDEX_DDL_STATEMENTS) scratch.prepare(statement).run()
  // 再跑一次：DROP/CREATE 幂等
  for (const statement of schema.INDEX_DDL_STATEMENTS) scratch.prepare(statement).run()
  const noteColumns = scratch.prepare(`SELECT name FROM pragma_table_info('notes')`).all().map((row) => row.name)
  const folderColumns = scratch.prepare(`SELECT name FROM pragma_table_info('folders')`).all().map((row) => row.name)
  scratch.close()
  for (const column of ['rel_path', 'file_mtime', 'file_size']) {
    assert(noteColumns.includes(column), `notes 缺少 ${column}`)
  }
  assert(folderColumns.includes('path'), 'folders 缺少 path')
})

await check('动态构造器：listAll 的代表性组合', () => {
  const cases = [
    ['默认', schema.buildNotesListQuery()],
    ['folderId=null', schema.buildNotesListQuery({ folderId: null })],
    ['folderId=id', schema.buildNotesListQuery({ folderId: 'f1' })],
    ['tagName', schema.buildNotesListQuery({ tagName: '工作' })],
    ['回收站', schema.buildNotesListQuery({ onlyDeleted: true })],
    ['includeDeleted + updatedAt', schema.buildNotesListQuery({ includeDeleted: true, sortBy: 'updatedAt' })],
    ['title asc', schema.buildNotesListQuery({ sortBy: 'title', direction: 'asc' })],
    ['order desc', schema.buildNotesListQuery({ sortBy: 'order', direction: 'desc' })],
    ['folder+tag+trash', schema.buildNotesListQuery({ folderId: 'f1', tagName: 'x', onlyDeleted: true })],
  ]
  for (const [name, built] of cases) {
    const numbers = schema.scanParamNumbers(built.sql)
    const expected = built.values.map((_, index) => index + 1)
    assertEqual(numbers, expected, `listAll「${name}」占位符`)
  }
  assertEqual(schema.buildNotesListQuery({ folderId: 'f1', tagName: 'x', onlyDeleted: true }).values, ['f1', 'x'], '绑定值顺序')
})

await check('动态构造器：update 的代表性组合（含值顺序与 CAST）', () => {
  const full = schema.buildNoteUpdateQuery(
    'note-1',
    { title: 't', content: 'c', folderId: null, pinned: true, order: 2, deletedAt: null },
    1234,
  )
  assertEqual(schema.scanParamNumbers(full.sql), [1, 2, 3, 4, 5, 6, 7, 8], '占位符编号')
  assertEqual(full.values, ['t', 'c', null, 1, 2, null, 1234, 'note-1'], '绑定值顺序')
  assert(full.sql.includes('updated_at = CAST($7 AS INTEGER)'), 'updatedAt 必须刷新且 CAST 为 INTEGER')
  assert(full.sql.includes('WHERE id = $8'), 'WHERE 应使用最后一个占位符')

  const minimal = schema.buildNoteUpdateQuery('note-2', {}, 99)
  assertEqual(schema.scanParamNumbers(minimal.sql), [1, 2], '空 patch 占位符')
  assertEqual(minimal.values, [99, 'note-2'], '空 patch 绑定值')
})

await check('构造器产物可被真实 SQLite 执行（listAll / update 冒烟）', () => {
  const scratch = new DatabaseSync(':memory:')
  scratch.exec('PRAGMA foreign_keys = ON')
  scratch.exec(v1Sql)
  scratch.exec(v2Sql)
  const insert = scratch.prepare(
    `INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, CAST($6 AS INTEGER), CAST($7 AS INTEGER), CAST($8 AS INTEGER), CAST($9 AS INTEGER), NULL)`,
  )
  insert.run({ $1: 'p1', $2: '标题一', $3: '正文一', $4: null, $5: '[]', $6: 0, $7: 0, $8: 1, $9: 1 })
  insert.run({ $1: 'p2', $2: '标题二', $3: '正文二', $4: null, $5: '[]', $6: 1, $7: -1, $8: 2, $9: 2 })

  const list = schema.buildNotesListQuery({ folderId: null })
  const rows = scratch.prepare(list.sql).all(Object.fromEntries(list.values.map((value, index) => [`$${index + 1}`, value])))
  assertEqual(rows.map((row) => row.id), ['p2', 'p1'], 'pinned DESC, sort_order ASC')

  const update = schema.buildNoteUpdateQuery('p2', { title: '改后标题', pinned: true }, 999)
  scratch.prepare(update.sql).run(Object.fromEntries(update.values.map((value, index) => [`$${index + 1}`, value])))
  const row = scratch.prepare('SELECT title, pinned, typeof(updated_at) AS t FROM notes WHERE id = ?').get('p2')
  assertEqual([row.title, Number(row.pinned), row.t], ['改后标题', 1, 'integer'], 'update 效果')
  scratch.close()
})

/* ============================== 汇总 ============================== */

} catch (error) {
  // 未捕获异常（例如临时目录被外部清理掉）：记成一条失败项，保证 finally 与汇总照常执行
  results.push({
    group: 'runner',
    name: '运行期间发生未捕获异常',
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  })
} finally {
  /* ---------------- t28 收尾：必定清理 + 断言工作区零污染 ---------------- */
  await db.closeDb().catch(() => undefined)
  await cleanupRunRoot(runRoot)

  await check('收尾：临时根已清理（异常路径也不残留）', () => {
    assertEqual(existsSync(runRoot), false, `临时根应被删除：${runRoot}`)
  })

  await check('收尾：FsPort 从未收到临时根之外的路径（否则会在仓库里造垃圾）', () => {
    assertEqual(guarded.violations, [], '出现越界文件系统调用')
  })

  await check('收尾：仓库根目录未新增文件（工作区零污染）', () => {
    const diff = diffWorkspace(workspaceBefore, snapshotWorkspace(projectRoot))
    assertEqual(diff.addedFiles, [], `仓库根目录出现了新文件：${JSON.stringify(diff.addedFiles)}`)
    if (diff.addedDirs.length > 0 || diff.removed.length > 0) {
      console.log(`  ℹ️ 根目录目录级变化（不计失败）：新增目录=${JSON.stringify(diff.addedDirs)} 消失=${JSON.stringify(diff.removed)}`)
    }
    const zeroByte = listZeroByteRootFiles(projectRoot)
    if (zeroByte.length > 0) {
      console.log(
        `  ℹ️ 提示：仓库根目录已存在 0 字节文件 ${JSON.stringify(zeroByte)}（本次运行未新增；` +
          `若为 'x' 之类垃圾文件，请手工确认是否该删除）`,
      )
    }
  })

const failed = results.filter((result) => !result.ok)
const passed = results.length - failed.length

console.log('\n' + '─'.repeat(72))
for (const result of results) {
  if (!result.ok) console.log(`❌ [${result.group}] ${result.name}\n   ↳ ${result.error}`)
}
console.log(`总计 ${results.length} 项：通过 ${passed}，失败 ${failed.length}`)
console.log(failed.length === 0 ? '✅ 数据层自检全部通过' : '❌ 数据层自检存在失败项')

process.exitCode = failed.length === 0 ? 0 : 1
}

