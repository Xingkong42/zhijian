#!/usr/bin/env node
/**
 * 纸笺 · 「md 文件为真相源 + SQLite 可重建索引」自检
 * ============================================================================
 * 运行：node src/db/__checks__/fs-store-checks.mjs      （退出码 0 = 全部通过）
 *
 * 全程使用**真实文件系统**（临时目录）与**真实 SQLite 引擎**：
 *  - 通过仓库自带的 __checks__/loader.mjs 把 @tauri-apps/plugin-sql 换成
 *    node:sqlite 适配器，再注入 node-fs-port（node:fs/promises）；
 *  - 于是应用里同一套 src/db/** 代码在 Node 下跑完整流程：
 *    写 md → 索引 → 搜索 → 回收站 → 外部编辑 → 索引重建 → 旧库迁移。
 *
 * 覆盖（每个场景都是独立的临时目录 + 独立的内存数据库）：
 *  1. 往返一致：中文标题 / 正文含 `---` / 含 `:` / 标题含换行与特殊字符
 *  2. 文件名规则：净化非法字符、空标题 → 无标题-<短id>、重名加 -2、超长截断
 *  3. 标题变更 → 文件改名且内容不丢；重名冲突
 *  4. 软删除 → .trash/ → 恢复往返；彻底删除
 *  5. 删除索引后 rebuildIndex() → 与重建前**逐条一致**
 *  6. 外部编辑（VS Code 改标题/正文、新增文件、删除文件）→ syncIndex 可见
 *  7. 目录 = 文件夹：嵌套、改名后 id 稳定、删除后笔记回收到收件箱
 *  8. 标签：用者存、声明者存、无人使用且未声明则消失
 *  9. 迁移：真实旧库（7 笔记 / 2 文件夹 / 1 标签，含中文诗词）→ 逐条核对
 *     + 备份文件 + 幂等（跑两次结果相同）+ 失败不产生残缺数据
 */

import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..')

register(new URL('./loader.mjs', import.meta.url).href)

const db = await import('../index.ts')
const { notesRepo } = await import('../notes.ts')
const { foldersRepo } = await import('../folders.ts')
const { tagsRepo } = await import('../tags.ts')
const { searchRepo } = await import('../search.ts')
const { parseFrontMatter, sanitizeStem } = await import('../frontmatter.ts')
const { createSqlLegacyReader, migrateLegacyToVault } = await import('../migrate.ts')
const { nodeFsPort, listTree, readTextIfExists } = await import('./node-fs-port.mjs')
const { makeRunRoot, cleanupRunRoot, guardFsPort, snapshotWorkspace, diffWorkspace, assertInsideRoot, listZeroByteRootFiles } = await import('./harness.mjs')

/* ------------------------------ 断言工具 ------------------------------ */

const results = []
let currentGroup = '(未分组)'
const group = (title) => {
  currentGroup = title
  console.log(`\n── ${title}`)
}
const check = async (name, fn) => {
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const assertEqual = (actual, expected, message) => {
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
    return text
  }
  throw new Error(`${message ?? '期望抛出可读 Error'}，但调用成功返回了`)
}

/* ------------------------------ 场景工具 ------------------------------ */
/* t28：所有场景都放在**同一个进程唯一临时根**之下；注入 db 层的 FsPort 带越界护栏；
   直接 fs 写入也强制校验"在临时根内"，杜绝任何把临时路径当相对路径处理的可能。 */

const runRoot = await makeRunRoot('fsstore')
const guarded = guardFsPort(nodeFsPort, { root: runRoot, label: 'fs-store-checks' })
const workspaceBefore = snapshotWorkspace(projectRoot)
const scenarios = []
let scenarioSeq = 0

/** 直接 fs 操作的路径护栏（防止绕过 FsPort 的裸路径写入） */
function insideRunRoot(target) {
  assertInsideRoot(runRoot, target, 'fs-store-checks')
  return target
}

async function freshScenario(tag) {
  const root = path.join(runRoot, `${tag}-${++scenarioSeq}`)
  const vaultRoot = path.join(root, 'Documents', '纸笺')
  const appDataDir = path.join(root, 'AppData')
  await nodeFsPort.mkdir(vaultRoot, { recursive: true })
  await nodeFsPort.mkdir(appDataDir, { recursive: true })
  await db.closeDb()
  db.configureStorage({
    fs: guarded.port,
    vaultRoot,
    appDataDir,
    legacyDbPath: path.join(appDataDir, 'zhijian.db'),
  })
  await db.initDb()
  scenarios.push(root)
  return { root, vaultRoot, appDataDir, vault: (rel) => path.join(vaultRoot, rel) }
}

/** 读取 vault 里所有 md（返回 rel → 解析结果） */
async function readAllNotes(vaultRoot) {
  const map = new Map()
  for (const rel of await listTree(vaultRoot)) {
    if (rel.endsWith('/') || !rel.toLowerCase().endsWith('.md')) continue
    const raw = await readTextIfExists(path.join(vaultRoot, rel))
    map.set(rel, parseFrontMatter(raw ?? ''))
  }
  return map
}

console.log('纸笺 · md 文件真相源 / 索引 / 迁移 自检')
console.log(`项目根目录：${projectRoot}`)
console.log(`临时根（唯一名）：${runRoot}`)

/* 主体包在 try 里：未捕获异常记成失败项，finally 里必定清理 + 断言零污染（t28） */
try {

/* ==================== 场景 1：往返一致与文件名规则 ==================== */

group('1 往返一致（front-matter 边界情况）')

const s1 = await freshScenario('roundtrip')

await check('中文标题 + 正文含 `---` + 含 `:` 往返一致', async () => {
  const content = '静夜思\n\n---\n\n床前明月光：疑是地上霜。\n举头望明月，低头思故乡。'
  const note = await notesRepo.create({ title: '静夜思·李白', content, tags: ['诗词'] })
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry, '应按 front-matter id 找到文件')
  const [rel, parsed] = entry
  assert(rel.endsWith('静夜思·李白.md'), `文件名应由标题净化而来：${rel}`)
  assertEqual(parsed.data.title, '静夜思·李白', 'front-matter 标题')
  assertEqual(parsed.body, content, '正文应逐字一致（含 `---` 与 `:`）')
  assertEqual(parsed.data.tags, ['诗词'], '标签')
  const readBack = await notesRepo.get(note.id)
  assertEqual(readBack.content, content, '经索引读回也应一致')
})

await check('标题含换行 → 折叠为空格（文件名与 front-matter 都单行）', async () => {
  const note = await notesRepo.create({ title: '第一行\n第二行', content: '正文' })
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry, '应找到文件')
  assert(entry[0].endsWith('第一行 第二行.md'), `文件名应折叠换行：${entry[0]}`)
  assertEqual(String(entry[1].data.title).includes('\n'), false, 'front-matter 标题不得含换行')
})

await check('标题含引号与冒号 → 正确转义与还原', async () => {
  const title = '他说："你好"：世界'
  const note = await notesRepo.create({ title, content: 'x' })
  const readBack = await notesRepo.get(note.id)
  assertEqual(readBack.title, title, '标题往返一致（引号/冒号转义正确）')
})

await check('标签含空格与特殊字符 → 序列化/解析往返一致', async () => {
  const note = await notesRepo.create({ title: '标签边界', content: 'x', tags: ['待办 清单', 'a:b', '#重要'] })
  const readBack = await notesRepo.get(note.id)
  assertEqual(readBack.tags, ['待办 清单', 'a:b', '#重要'], '标签往返一致')
})

group('2 文件名规则')

await check('非法字符 `\\/:*?"<>|` 被净化，首尾点/空格去掉', () => {
  assertEqual(sanitizeStem('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij', '非法字符应全部去除')
  assertEqual(sanitizeStem('  .标题.  '), '标题', '首尾点与空白应去除')
  assertEqual(sanitizeStem('CON'), '_CON', 'Windows 保留名应避让')
})

await check('超长标题 → 截断到上限（不含 .md）', () => {
  const stem = sanitizeStem('长'.repeat(200))
  assert(stem.length <= 80, `截断后长度应 ≤ 80，实际 ${stem.length}`)
})

await check('空标题 → 无标题-<短id>.md', async () => {
  const note = await notesRepo.create({ title: '', content: '无标题内容' })
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry, '应找到文件')
  assert(/^无标题-[A-Za-z0-9]{1,6}\.md$/.test(path.basename(entry[0])), `文件名应为 无标题-<短id>.md：${entry[0]}`)
  assertEqual(entry[1].body, '无标题内容', '正文不丢')
})

await check('同名标题（不同笔记）→ 自动加 -2 后缀', async () => {
  const a = await notesRepo.create({ title: '重名测试', content: 'A' })
  const b = await notesRepo.create({ title: '重名测试', content: 'B' })
  const list = await readAllNotes(s1.vaultRoot)
  const names = [...list.entries()]
    .filter(([, parsed]) => [a.id, b.id].includes(parsed.data.id))
    .map(([rel]) => path.basename(rel))
    .sort()
  assertEqual(names, ['重名测试-2.md', '重名测试.md'], '第二个同名文件应加 -2')
})

group('3 标题变更 → 文件改名且内容不丢')

await check('改标题 → 文件改名、正文与 id 不变、旧文件消失', async () => {
  const note = await notesRepo.create({ title: '旧标题', content: '内容不能丢' })
  const before = await readAllNotes(s1.vaultRoot)
  const oldRel = [...before.entries()].find(([, parsed]) => parsed.data.id === note.id)[0]
  const updated = await notesRepo.update(note.id, { title: '新标题' })
  const after = await readAllNotes(s1.vaultRoot)
  assert(!after.has(oldRel), `旧文件应被删除：${oldRel}`)
  const entry = [...after.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry, '应存在改名后的文件')
  assertEqual(path.basename(entry[0]), '新标题.md', '新文件名')
  assertEqual(entry[1].body, '内容不能丢', '正文不丢')
  assertEqual(updated.id, note.id, 'id 不变')
  assertEqual((await notesRepo.get(note.id)).title, '新标题', '索引同步')
})

await check('改标题撞已有文件名 → 新文件加 -2，旧笔记内容互不影响', async () => {
  const first = await notesRepo.create({ title: '撞名A', content: 'A 的内容' })
  const second = await notesRepo.create({ title: '撞名B', content: 'B 的内容' })
  await notesRepo.update(second.id, { title: '撞名A' })
  const list = await readAllNotes(s1.vaultRoot)
  const mine = [...list.entries()].filter(([, parsed]) => [first.id, second.id].includes(parsed.data.id))
  assertEqual(mine.length, 2, '两条笔记都应存在（不得互相覆盖）')
  const contents = mine.map(([, parsed]) => parsed.body).sort()
  assertEqual(contents, ['A 的内容', 'B 的内容'], '内容各自完好')
  assertEqual(
    mine.map(([rel]) => path.basename(rel)).sort(),
    ['撞名A-2.md', '撞名A.md'],
    '第二个应加 -2',
  )
  assertEqual((await notesRepo.get(first.id)).content, 'A 的内容', '第一条内容未被覆盖')
})

/* ==================== 场景 4：回收站往返 ==================== */

group('4 软删除 → .trash/ → 恢复 → 彻底删除')

await check('软删除：文件进 .trash/，原路径消失，trash.json 记录原始文件夹', async () => {
  const folder = await foldersRepo.create({ name: '草稿箱' })
  const note = await notesRepo.create({ folderId: folder.id, title: '待删笔记', content: '内容' })
  const before = await readAllNotes(s1.vaultRoot)
  const originalRel = [...before.entries()].find(([, parsed]) => parsed.data.id === note.id)[0]
  await notesRepo.remove(note.id)
  const after = await readAllNotes(s1.vaultRoot)
  assert(!after.has(originalRel), '原路径应消失')
  const trashed = [...after.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(trashed && trashed[0].startsWith('.trash/'), `应移到 .trash/：${trashed?.[0]}`)
  const trashMeta = JSON.parse((await readTextIfExists(path.join(s1.vaultRoot, '.paper', 'trash.json'))) ?? '{}')
  const record = Object.values(trashMeta).find((item) => item.id === note.id)
  assert(record, 'trash.json 应登记该笔记')
  assertEqual(record.originalFolderRel, '草稿箱', '应记录原始文件夹')
  assert(record.deletedAt > 0, '应记录删除时间')
})

await check('恢复：文件回到原文件夹，trash.json 记录被清理', async () => {
  const folder = (await foldersRepo.list()).find((item) => item.name === '草稿箱')
  const trashed = (await notesRepo.listAll({ onlyDeleted: true })).find((item) => item.title === '待删笔记')
  assert(trashed, '回收站里应有该笔记')
  const restored = await notesRepo.restore(trashed.id)
  assertEqual(restored.deletedAt, null, 'deletedAt 应清空')
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === trashed.id)
  assert(entry[0].startsWith('草稿箱/'), `应回到原文件夹：${entry[0]}`)
  const trashMeta = JSON.parse((await readTextIfExists(path.join(s1.vaultRoot, '.paper', 'trash.json'))) ?? '{}')
  assertEqual(Object.values(trashMeta).some((item) => item.id === trashed.id), false, 'trash.json 应清理')
})

await check('彻底删除：文件消失，索引行与 FTS 行都被清理', async () => {
  const note = await notesRepo.create({ title: '彻底删除用例', content: '独一无二的标记词 ZJDROP99' })
  await notesRepo.remove(note.id)
  await notesRepo.hardDelete(note.id)
  const list = await readAllNotes(s1.vaultRoot)
  assertEqual([...list.values()].some((parsed) => parsed.data.id === note.id), false, '文件应被删除')
  assertEqual(await notesRepo.get(note.id), null, '索引应无该行')
  const handle = (await import('./stub-plugin-sql.mjs')).__handle()
  const fts = handle.prepare('SELECT COUNT(*) AS c FROM notes_fts_trigram WHERE note_id = ?').get(note.id)
  assertEqual(Number(fts.c), 0, 'FTS 行应被清理')
})

/* ================== 场景 5/6：索引重建与外部编辑 ================== */

group('5 索引可纯由文件重建')

await check('rebuildIndex() 后：搜索命中逐条一致（id/标题/片段 + 相关度次序）', async () => {
  const before = await searchRepo.search('静夜思')
  assert(before.length > 0, '前置：重建前应有命中')
  const snapshot = before.map((hit) => ({ id: hit.note.id, snippet: hit.snippet, title: hit.note.title }))
  const orderBefore = [...before].sort((a, b) => a.rank - b.rank).map((hit) => hit.note.id)
  const countsBefore = await notesRepo.counts()

  const result = await db.rebuildIndex()
  assert(result.total >= 1, '重建后索引里应有笔记')

  const after = await searchRepo.search('静夜思')
  assertEqual(
    after.map((hit) => ({ id: hit.note.id, snippet: hit.snippet, title: hit.note.title })),
    snapshot,
    '重建前后搜索结果应逐条一致',
  )
  assertEqual(
    [...after].sort((a, b) => a.rank - b.rank).map((hit) => hit.note.id),
    orderBefore,
    '相关度次序应一致（bm25 绝对值依赖 FTS 统计量，不逐位比对）',
  )
  assertEqual(await notesRepo.counts(), countsBefore, '计数一致')
})

await check('索引表被 DROP 后仍能重建（证明"可重建"）', async () => {
  const handle = (await import('./stub-plugin-sql.mjs')).__handle()
  for (const table of ['notes_fts_trigram', 'notes_fts', 'note_tags', 'notes', 'tags', 'folders']) {
    handle.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  // 索引确实没了（读会失败）—— 但 md 文件还在
  await assertRejects(() => notesRepo.listAll(), /no such table|读取笔记失败/, '索引表已删除时应读不到')
  const filesStillThere = await readAllNotes(s1.vaultRoot)
  assert(filesStillThere.size > 0, '文件必须还在（真相源）')

  const result = await db.rebuildIndex()
  assert(result.total > 0, 'rebuildIndex 应把笔记找回来')
  const notes = await notesRepo.listAll()
  assertEqual(notes.length, filesStillThere.size, '列表应恢复且条数与文件数一致')
  const hit = await searchRepo.search('静夜思')
  assert(hit.length > 0, '搜索应恢复')
})

group('6 外部编辑可见（VS Code 场景）')

await check('外部改标题/正文 → syncIndex 后索引更新', async () => {
  const note = await notesRepo.create({ title: '外部编辑前', content: '原始正文' })
  const list = await readAllNotes(s1.vaultRoot)
  const rel = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)[0]
  const abs = path.join(s1.vaultRoot, rel)
  const raw = readFileSync(abs, 'utf8')
  writeFileSync(insideRunRoot(abs), raw.replace('title: 外部编辑前', 'title: 外部编辑后').replace('原始正文', '外部改写后的正文'), 'utf8')
  await db.syncIndex()
  const read = await notesRepo.get(note.id)
  assertEqual(read.title, '外部编辑后', '标题应随之更新')
  assertEqual(read.content, '外部改写后的正文', '正文应随之更新')
  const hits = await searchRepo.search('外部改写后')
  assert(hits.some((hit) => hit.note.id === note.id), '新内容应可被搜索到')
})

await check('外部新增 md（无 front-matter）→ 纳入管理并补写 id', async () => {
  const abs = path.join(s1.vaultRoot, '诗抄目录', 'external.md')
  await nodeFsPort.mkdir(path.dirname(abs), { recursive: true })
  writeFileSync(insideRunRoot(abs), '# 手写笔记\n\n天生我材必有用。\n', 'utf8')
  await db.syncIndex()
  const all = await notesRepo.listAll()
  const created = all.find((note) => note.content.includes('天生我材必有用'))
  assert(created, '外部文件应被纳入索引')
  const parsed = parseFrontMatter(readFileSync(abs, 'utf8'))
  assert(parsed.hasFrontMatter, '首次纳入应补写 front-matter')
  assertEqual(parsed.data.id, created.id, '补写的 id 应与索引一致')
  assertEqual(parsed.data.title, '手写笔记', '无 title 时由正文首行推导')
  const folder = (await foldersRepo.list()).find((item) => item.name === '诗抄目录')
  assert(folder, '外部目录应成为文件夹')
  assertEqual(created.folderId, folder.id, '笔记应归属该文件夹')
})

await check('外部删除 md → syncIndex 后索引行消失', async () => {
  const abs = path.join(s1.vaultRoot, '诗抄目录', 'external.md')
  await nodeFsPort.remove(abs)
  await db.syncIndex()
  const all = await notesRepo.listAll()
  assertEqual(all.some((note) => note.content.includes('天生我材必有用')), false, '索引行应随文件消失')
})

await check('外部重命名文件 → id 不变（索引按 rel_path/id 双路匹配）', async () => {
  const note = await notesRepo.create({ title: '重命名前', content: '外部重命名用例' })
  const list = await readAllNotes(s1.vaultRoot)
  const rel = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)[0]
  await nodeFsPort.rename(path.join(s1.vaultRoot, rel), path.join(s1.vaultRoot, '被手工改名.md'))
  await db.syncIndex()
  const read = await notesRepo.get(note.id)
  assert(read, 'id 应仍可读（不得因文件改名而丢失）')
  assertEqual(read.content, '外部重命名用例', '内容不变')
  const rows = await notesRepo.listAll()
  assertEqual(rows.filter((item) => item.id === note.id).length, 1, '不应出现重复行')
})

await check('写入是原子的：vault 里不残留 *.tmp-* 临时文件', async () => {
  const tree = await listTree(s1.vaultRoot)
  const leftovers = tree.filter((rel) => rel.includes('.tmp-'))
  assertEqual(leftovers, [], '不应有临时文件残留')
})

/* ==================== 场景 7：文件夹（目录）语义 ==================== */

group('7 文件夹 = 子目录（嵌套 / 改名 / 删除）')

await check('嵌套目录 → tree 结构与父子关系正确', async () => {
  const parent = await foldersRepo.create({ name: '文集' })
  const child = await foldersRepo.create({ name: '唐诗', parentId: parent.id })
  const tree = await foldersRepo.tree()
  const parentNode = tree.find((node) => node.id === parent.id)
  assert(parentNode, '父文件夹应在树里')
  assertEqual(parentNode.children.map((node) => node.id), [child.id], '子文件夹挂载正确')
})

await check('目录改名 → folder id 保持不变（上层持有的 id 不失效）', async () => {
  const folder = (await foldersRepo.list()).find((item) => item.name === '文集')
  const renamed = await foldersRepo.rename(folder.id, '文集改名')
  assertEqual(renamed.id, folder.id, 'id 必须稳定')
  assertEqual(renamed.name, '文集改名', '名称更新')
  const tree = await foldersRepo.tree()
  const node = tree.find((item) => item.id === folder.id)
  assertEqual(node.children.length, 1, '子目录应跟随')
  assertEqual(node.children[0].name, '唐诗', '子目录名不变')
})

await check('删除文件夹 → 子树内笔记移回收件箱（文件与标签都不丢）', async () => {
  const folder = await foldersRepo.create({ name: '待删目录' })
  const sub = await foldersRepo.create({ name: '子目录', parentId: folder.id })
  const note = await notesRepo.create({ folderId: sub.id, title: '目录内笔记', content: '别丢我', tags: ['珍稀标签'] })
  await foldersRepo.remove(folder.id)
  const read = await notesRepo.get(note.id)
  assert(read, '笔记必须还在')
  assertEqual(read.folderId, null, '应回到收件箱')
  assertEqual(read.tags, ['珍稀标签'], '标签不应丢')
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry && !entry[0].includes('待删目录'), `文件应移出被删目录：${entry?.[0]}`)
  assertEqual((await foldersRepo.list()).some((item) => item.name === '待删目录'), false, '目录应删除')
})

/* ==================== 场景 8：标签派生规则 ==================== */

group('8 标签来自 front-matter')

await check('某标签仍被使用时存在；最后一个使用者移除后消失', async () => {
  const only = await notesRepo.create({ title: '标签存活用例', content: 'x', tags: ['临时标签'] })
  let names = (await tagsRepo.list()).map((tag) => tag.name)
  assert(names.includes('临时标签'), '使用中的标签应存在')
  await notesRepo.setTags(only.id, [])
  await db.syncIndex()
  names = (await tagsRepo.list()).map((tag) => tag.name)
  assertEqual(names.includes('临时标签'), false, '没有任何笔记使用后应消失')
})

await check('声明过的标签（未被使用）依然存在；改名会改写所有相关笔记的 front-matter', async () => {
  const declared = await tagsRepo.create({ name: '声明标签', color: '#5B7C99' })
  assertEqual((await tagsRepo.list()).some((tag) => tag.id === declared.id), true, '声明标签应进索引')
  const note = await notesRepo.create({ title: '标签改写用例', content: 'x', tags: ['声明标签'] })
  await tagsRepo.rename(declared.id, '声明标签2')
  const read = await notesRepo.get(note.id)
  assertEqual(read.tags, ['声明标签2'], '笔记 front-matter 应被改写')
  const list = await readAllNotes(s1.vaultRoot)
  const entry = [...list.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assertEqual(entry[1].data.tags, ['声明标签2'], '文件里的标签也应改写')
})

await check('改色真相源：故意污染索引里的 color → rebuildIndex() 后回到 tags.json 的颜色', async () => {
  const { dbExecute } = await import('../connection.ts')
  const tag = await tagsRepo.create({ name: '真相源颜色', color: '#C9A227' })
  const updated = await tagsRepo.updateColor(tag.id, '#4F6B58')
  assertEqual(updated.color, '#4F6B58', '改色应先落到返回值')

  // 把索引里的颜色改脏（模拟"索引只是缓存"被破坏）
  await dbExecute('故意污染索引颜色', `UPDATE tags SET color = '#000000' WHERE id = $1`, [tag.id])
  assertEqual(
    (await tagsRepo.list()).find((item) => item.id === tag.id).color,
    '#000000',
    '前置：索引已被污染',
  )

  await db.rebuildIndex()
  const after = (await tagsRepo.list()).find((item) => item.id === tag.id)
  assert(after, '重建后标签仍应存在')
  assertEqual(after.color, '#4F6B58', '重建后颜色应来自 .paper/tags.json（真相源）')

  const raw = readFileSync(path.join(s1.vaultRoot, '.paper', 'tags.json'), 'utf8')
  assertEqual(JSON.parse(raw)['真相源颜色'].color, '#4F6B58', 'tags.json 里保存的即是新色')
})

/* ==================== 场景 9：旧库无损迁移 ==================== */

group('9 旧库 → md 迁移（无损 / 备份 / 幂等 / 失败安全）')

const LEGACY_NOTES = [
  { id: 'legacy-1', title: '静夜思', content: '床前明月光，疑是地上霜。\n举头望明月，低头思故乡。', folder: 'f-poem', tags: ['唐诗', '李白'], pinned: 1, order: 0, created: 1700000001000, updated: 1700000002000, deleted: null },
  { id: 'legacy-2', title: '水调歌头', content: '明月几时有？把酒问青天。', folder: 'f-poem', tags: ['宋词'], pinned: 0, order: 1, created: 1700000003000, updated: 1700000004000, deleted: null },
  { id: 'legacy-3', title: '登鹳雀楼', content: '白日依山尽，黄河入海流。', folder: 'f-poem-sub', tags: ['唐诗'], pinned: 1, order: 0, created: 1700000005000, updated: 1700000006000, deleted: null },
  { id: 'legacy-4', title: '会议纪要', content: '讨论：md 作为真相源。', folder: null, tags: ['工作'], pinned: 0, order: -1, created: 1700000007000, updated: 1700000008000, deleted: null },
  { id: 'legacy-5', title: '待办清单', content: '- [ ] 迁移数据\n- [x] 备份旧库', folder: null, tags: ['工作', '待办'], pinned: 0, order: 0, created: 1700000009000, updated: 1700000010000, deleted: null },
  { id: 'legacy-6', title: '', content: '无标题的旧笔记内容', folder: null, tags: [], pinned: 0, order: 1, created: 1700000011000, updated: 1700000012000, deleted: null },
  { id: 'legacy-7', title: '已删除的旧笔记', content: '这条在回收站里', folder: 'f-poem', tags: ['唐诗'], pinned: 0, order: 2, created: 1700000013000, updated: 1700000014000, deleted: 1700000015000 },
]

await check('准备旧库：v1 结构 + 7 条笔记 / 2 个文件夹 / 1 个标签 + 旧库文件', async () => {
  const s9 = await freshScenario('migrate')
  // 旧库内容通过当前连接写入（模拟升级前的库），并落一个真实文件供备份
  const { dbExecute } = await import('../connection.ts')
  await dbExecute('准备旧文件夹', `INSERT INTO folders (id, name, parent_id, sort_order, created_at) VALUES ('f-poem', '诗词', NULL, 0, 1699999999000)`)
  await dbExecute('准备旧文件夹', `INSERT INTO folders (id, name, parent_id, sort_order, created_at) VALUES ('f-poem-sub', '唐诗', 'f-poem', 0, 1699999999500)`)
  await dbExecute('准备旧标签', `INSERT INTO tags (id, name, color, created_at) VALUES ('t-tang', '唐诗', '#5B7C99', 1699999999000)`)
  await dbExecute('准备旧标签', `INSERT INTO tags (id, name, color, created_at) VALUES ('t-work', '工作', '#C9A227', 1699999999000)`)
  for (const note of LEGACY_NOTES) {
    await dbExecute(
      '准备旧笔记',
      `INSERT INTO notes (id, title, content, folder_id, tags, pinned, sort_order, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, CAST($6 AS INTEGER), CAST($7 AS INTEGER), CAST($8 AS INTEGER), CAST($9 AS INTEGER), CAST($10 AS INTEGER))`,
      [note.id, note.title, note.content, note.folder, JSON.stringify(note.tags), note.pinned, note.order, note.created, note.updated, note.deleted],
    )
  }
  await dbExecute('准备旧关系', `INSERT INTO note_tags (note_id, tag_id) VALUES ('legacy-1', 't-tang')`)
  await dbExecute('准备旧关系', `INSERT INTO note_tags (note_id, tag_id) VALUES ('legacy-3', 't-tang')`)
  await dbExecute('准备旧关系', `INSERT INTO note_tags (note_id, tag_id) VALUES ('legacy-4', 't-work')`)
  // 真实旧库文件（备份源）：写入可识别的内容，稍后逐字节比对备份
  writeFileSync(insideRunRoot(path.join(s9.appDataDir, 'zhijian.db')), 'SQLite format 3\0ZJ-LEGACY-DB-MARKER', 'utf8')
  assertEqual((await notesRepo.listAll({ includeDeleted: true })).length, 7, '旧库应有 7 条')
})

await check('迁移：7 条笔记全部成文件，逐条核对 id/标题/正文/标签/置顶/时间戳', async () => {
  const result = await migrateLegacyToVault()
  assertEqual(result.status, 'migrated', '应执行迁移')
  assertEqual(result.notes, 7, '迁移笔记数')
  assertEqual(result.folders, 2, '迁移文件夹数')
  assert(result.backupPath, '应产生备份路径')

  const s9Vault = db.getStorage().vaultRoot
  const files = await readAllNotes(s9Vault)
  const byId = new Map()
  for (const [rel, parsed] of files) byId.set(parsed.data.id, { rel, parsed })

  for (const expected of LEGACY_NOTES) {
    const found = byId.get(expected.id)
    assert(found, `应生成 id=${expected.id} 的文件`)
    assertEqual(found.parsed.data.title, expected.title || path.basename(found.rel, '.md'), `${expected.id} 标题`)
    assertEqual(found.parsed.body, expected.content, `${expected.id} 正文`)
    assertEqual(found.parsed.data.tags, expected.tags, `${expected.id} 标签`)
    assertEqual(found.parsed.data.pinned, expected.pinned === 1, `${expected.id} 置顶`)
    assertEqual(found.parsed.data.created, expected.created, `${expected.id} 创建时间`)
    assertEqual(found.parsed.data.updated, expected.updated, `${expected.id} 更新时间`)
    assertEqual(found.parsed.data.order, expected.order, `${expected.id} 排序位`)
    if (expected.deleted !== null) {
      assert(found.rel.startsWith('.trash/'), `${expected.id} 应落在 .trash/`)
    } else if (expected.folder === 'f-poem') {
      assert(found.rel.startsWith('诗词/'), `${expected.id} 应在「诗词」目录`)
    } else if (expected.folder === 'f-poem-sub') {
      assert(found.rel.startsWith('诗词/唐诗/'), `${expected.id} 应在「诗词/唐诗」目录`)
    } else {
      assert(!found.rel.includes('/'), `${expected.id} 应在收件箱（根目录）`)
    }
  }
  assertEqual(files.size, 7, '文件总数应为 7')
})

await check('迁移：备份文件存在且与旧库逐字节一致', async () => {
  const s9Vault = db.getStorage().vaultRoot
  const s9AppData = db.getStorage().appDataDir
  const meta = JSON.parse(readFileSync(path.join(s9Vault, '.paper', 'migrated.json'), 'utf8'))
  assert(meta.backupPath, 'migrated.json 应记录备份路径')
  const backup = readFileSync(meta.backupPath, 'utf8')
  assertEqual(backup, 'SQLite format 3\0ZJ-LEGACY-DB-MARKER', '备份应是旧库的逐字节副本')
  assert(meta.backupPath.includes('.bak-'), `备份文件名应带时间戳：${meta.backupPath}`)
  assert(meta.backupPath.startsWith(s9AppData), '备份应位于应用数据目录')
})

await check('迁移后重建索引：搜索结果与旧库内容一致', async () => {
  await db.rebuildIndex()
  const hits = await searchRepo.search('明月')
  const ids = hits.map((hit) => hit.note.id).sort()
  assert(ids.includes('legacy-1') && ids.includes('legacy-2'), `应命中旧库诗词：${JSON.stringify(ids)}`)
  const counts = await notesRepo.counts()
  assertEqual(counts.all, 6, '未删除的旧笔记数')
  assertEqual(counts.trash, 1, '回收站里的旧笔记数')
  const folders = (await foldersRepo.list()).map((item) => item.name).sort()
  assertEqual(folders, ['唐诗', '诗词'], '文件夹应来自目录结构')
  const tagNames = (await tagsRepo.list()).map((tag) => tag.name).sort()
  assert(['唐诗', '工作'].every((name) => tagNames.includes(name)), `旧标签应保留：${JSON.stringify(tagNames)}`)
})

await check('幂等：再次迁移 → skipped(already-migrated)，文件集合与内容完全不变', async () => {
  const s9Vault = db.getStorage().vaultRoot
  const before = await readAllNotes(s9Vault)
  const snapshot = [...before.entries()].map(([rel, parsed]) => [rel, parsed.body, parsed.data.title])
  const again = await migrateLegacyToVault()
  assertEqual(again.status, 'skipped', '不应重复迁移')
  assertEqual(again.reason, 'already-migrated', '原因码')
  const after = await readAllNotes(s9Vault)
  assertEqual([...after.entries()].map(([rel, parsed]) => [rel, parsed.body, parsed.data.title]), snapshot, '文件集合应完全不变')
})

await check('失败安全：vault 非空时拒绝迁移（不覆盖已有文件）', async () => {
  const s9Vault = db.getStorage().vaultRoot
  await nodeFsPort.remove(path.join(s9Vault, '.paper', 'migrated.json'))
  const before = await readAllNotes(s9Vault)
  const result = await migrateLegacyToVault()
  assertEqual(result.status, 'skipped', '应跳过')
  assertEqual(result.reason, 'vault-not-empty', '原因码')
  assertEqual((await readAllNotes(s9Vault)).size, before.size, '文件数不变')
})

await check('失败安全：备份失败 → 中止迁移且 vault 无任何新增文件', async () => {
  const root = path.join(runRoot, 'backupfail')
  const vaultRoot = path.join(root, 'Documents', '纸笺')
  const appDataDir = path.join(root, 'AppData')
  await nodeFsPort.mkdir(vaultRoot, { recursive: true })
  await nodeFsPort.mkdir(appDataDir, { recursive: true })
  // 用一个**目录**冒充旧库文件：exists=true，copyFile 必失败
  const fakeDb = path.join(appDataDir, 'zhijian.db')
  await nodeFsPort.mkdir(fakeDb, { recursive: true })
  await db.closeDb()
  db.configureStorage({ fs: nodeFsPort, vaultRoot, appDataDir, legacyDbPath: fakeDb })
  await db.initDb()

  const reader = {
    dbPath: fakeDb,
    read: async () => ({
      notes: [
        {
          id: 'will-fail', title: '不该出现的笔记', content: '备份失败就不该落盘',
          folder_id: null, tags: '[]', pinned: 0, sort_order: 0,
          created_at: 1, updated_at: 2, deleted_at: null,
        },
      ],
      folders: [],
      tags: [],
      noteTags: [],
    }),
  }
  const message = await assertRejects(() => migrateLegacyToVault({ reader, force: true }), /备份失败/, '应因备份失败而中止')
  assert(message.includes('未对现有数据做任何改动'), `错误信息应说明未改动数据：${message}`)
  const files = await readAllNotes(vaultRoot)
  assertEqual([...files.keys()], [], '不得产生任何笔记文件')
  assertEqual(await readTextIfExists(path.join(vaultRoot, '.paper', 'migrated.json')), null, '不得写迁移记录')
})

await check('失败安全：源读取失败 → 抛可读错误且 vault 保持空', async () => {
  const root = path.join(runRoot, 'readfail')
  const vaultRoot = path.join(root, 'Documents', '纸笺')
  const appDataDir = path.join(root, 'AppData')
  await nodeFsPort.mkdir(vaultRoot, { recursive: true })
  await nodeFsPort.mkdir(appDataDir, { recursive: true })
  await db.closeDb()
  db.configureStorage({ fs: nodeFsPort, vaultRoot, appDataDir, legacyDbPath: path.join(appDataDir, 'zhijian.db') })
  await db.initDb()
  const reader = {
    dbPath: path.join(appDataDir, 'zhijian.db'),
    read: async () => {
      throw new Error('模拟旧库损坏：disk image is malformed')
    },
  }
  const message = await assertRejects(() => migrateLegacyToVault({ reader, force: true }), /迁移中止|读取旧数据库失败/, '应抛可读错误')
  assert(message.includes('未改动'), `错误信息应说明未改动数据：${message}`)
  assertEqual([...(await readAllNotes(vaultRoot)).keys()], [], 'vault 应保持空')
})

/* ==================== 场景 10：标签计数（t35 回归） ==================== */

group('10 标签对笔记的计数（t35：打标签后立即正确）')

const s10 = await freshScenario('tagcounts')

/** 扫描 vault 的 md（排除 .trash）统计每个标签下的笔记数 —— 真值源口径 */
async function tagCountsFromFiles(vaultRoot) {
  const files = await readAllNotes(vaultRoot)
  const counts = {}
  for (const [rel, parsed] of files) {
    if (rel.startsWith('.trash/')) continue
    for (const name of parsed.data.tags ?? []) {
      counts[name] = (counts[name] ?? 0) + 1
    }
  }
  return counts
}

await check('0 条：声明过但无人使用的标签 → 计数 0（不出现在 byTag 里）', async () => {
  await tagsRepo.create({ name: '888' })
  const counts = await notesRepo.counts()
  assertEqual(counts.byTag['888'] ?? 0, 0, '没有笔记使用时应为 0')
  assertEqual((await tagsRepo.list()).some((tag) => tag.name === '888'), true, '但标签本身仍存在')
})

await check('1 条（用户原话场景）：给一条笔记打上 888 → 计数立即为 1', async () => {
  const note = await notesRepo.create({ title: '一篇笔记', content: '正文' })
  await tagsRepo.setNoteTags(note.id, ['888'])
  // 不做任何 sync/rebuild —— 计数必须"立即"正确
  const counts = await notesRepo.counts()
  assertEqual(counts.byTag['888'] ?? 0, 1, '888 应有 1 条（修复前显示 0）')
  assertEqual(counts.byTag['888'] ?? 0, (await tagCountsFromFiles(s10.vaultRoot))['888'] ?? 0, '应与 md 真值源一致')
})

await check('编辑器/列表路径（notesRepo.update({ tags })）同样立即正确', async () => {
  const note = await notesRepo.create({ title: '走 update 打标签', content: 'x' })
  await notesRepo.update(note.id, { tags: ['编辑器标签'] })
  const counts = await notesRepo.counts()
  assertEqual(counts.byTag['编辑器标签'] ?? 0, 1, 'update 路径也必须是 1')
})

await check('多条：3 条笔记打同一标签 → 3；一笔记多标签 → 各自都计', async () => {
  const a = await notesRepo.create({ title: '多标签 A', content: 'a', tags: ['批量标签', '多标签之一'] })
  const b = await notesRepo.create({ title: '多标签 B', content: 'b', tags: ['批量标签', '多标签之二'] })
  const c = await notesRepo.create({ title: '多标签 C', content: 'c', tags: ['批量标签'] })
  const counts = await notesRepo.counts()
  assertEqual(counts.byTag['批量标签'] ?? 0, 3, '3 条笔记')
  assertEqual(counts.byTag['多标签之一'] ?? 0, 1, '一条笔记的多个标签各自计数')
  assertEqual(counts.byTag['多标签之二'] ?? 0, 1, '一条笔记的多个标签各自计数')
  assertEqual(await notesRepo.listByTag('批量标签').then((list) => list.length), 3, 'listByTag 数量一致')
  void [a, b, c]
})

await check('软删除：进回收站的笔记不再计入（恢复后重新计入）', async () => {
  const tagged = (await notesRepo.listByTag('批量标签'))[0]
  await notesRepo.remove(tagged.id)
  let counts = await notesRepo.counts()
  assertEqual(counts.byTag['批量标签'] ?? 0, 2, '回收站里的笔记应排除')
  await notesRepo.restore(tagged.id)
  counts = await notesRepo.counts()
  assertEqual(counts.byTag['批量标签'] ?? 0, 3, '恢复后应重新计入')
})

await check('真值源等价：byTag 与「扫描 md 统计」（排除 .trash）逐条一致', async () => {
  const fromFiles = await tagCountsFromFiles(s10.vaultRoot)
  const counts = await notesRepo.counts()
  const names = new Set([...Object.keys(fromFiles), ...Object.keys(counts.byTag)])
  const mismatches = []
  for (const name of names) {
    const expected = fromFiles[name] ?? 0
    const actual = counts.byTag[name] ?? 0
    if (expected !== actual) mismatches.push(`${name}: 索引=${actual} 文件=${expected}`)
  }
  // 反向：索引里不应出现文件里没有的标签
  assertEqual(mismatches, [], '计数必须等于 md 里实际带该标签的笔记数')
  assert(Object.keys(fromFiles).length >= 4, `真值源应至少覆盖 4 个标签：${JSON.stringify(fromFiles)}`)
})

await check('索引重建后计数不变（计数来自投影，重建不改真值）', async () => {
  const before = await notesRepo.counts()
  await db.rebuildIndex()
  const after = await notesRepo.counts()
  assertEqual(after.byTag, before.byTag, '重建前后 byTag 必须一致')
  assertEqual(after, before, '重建前后计数完全一致')
})

group('11 索引变更信号（t35 的刷新机制）')

await check('写操作通知订阅者；同一次用户动作合并为一次投递', async () => {
  db.resetIndexMutationListeners()
  let notifications = 0
  const unsubscribe = db.onIndexMutated(() => {
    notifications += 1
  })
  assertEqual(db.indexMutationListenerCount(), 1, '应有 1 个订阅者')

  await notesRepo.create({ title: '通知用例', content: 'x', tags: ['通知标签', '另一个'] })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assertEqual(notifications, 1, `一次新建（含标签/关系多次索引写）应合并为 1 次通知，实际 ${notifications}`)
  unsubscribe()
  db.resetIndexMutationListeners()
})

await check('只读操作绝不通知（否则订阅者 reload 会自激循环）', async () => {
  db.resetIndexMutationListeners()
  let notifications = 0
  const unsubscribe = db.onIndexMutated(() => {
    notifications += 1
  })
  await notesRepo.counts()
  await notesRepo.listAll()
  await notesRepo.listByTag('批量标签')
  await foldersRepo.list()
  await foldersRepo.tree()
  await tagsRepo.list()
  await notesRepo.get('not-exist')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assertEqual(notifications, 0, `只读操作不应通知，实际 ${notifications} 次`)
  unsubscribe()
  db.resetIndexMutationListeners()
})

await check('连续动作合并为一次通知；订阅者抛错被隔离；取消订阅后停止', async () => {
  db.resetIndexMutationListeners()
  let notifications = 0
  const unsubscribe = db.onIndexMutated(() => {
    notifications += 1
  })
  // 第二个订阅者故意抛错：不得影响第一个订阅者，也不得让写入方失败
  const unsubscribeThrower = db.onIndexMutated(() => {
    throw new Error('故意抛错：订阅者异常必须被隔离')
  })
  assertEqual(db.indexMutationListenerCount(), 2, '应有 2 个订阅者')

  // ① 一串动作（打标签 / 改色 / 建文件夹 / 删标签）在防抖窗口内 → 合并为 1 次投递
  const note = await notesRepo.create({ title: '信号用例', content: 'x' })
  await tagsRepo.setNoteTags(note.id, ['信号标签'])
  const tag = (await tagsRepo.list()).find((item) => item.name === '信号标签')
  await tagsRepo.updateColor(tag.id, '#5B7C99')
  await foldersRepo.create({ name: '信号文件夹' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assertEqual(notifications, 1, `窗口内的一串动作应合并为 1 次，实际 ${notifications}`)

  // ② 隔开窗口的单个动作 → 每次各 1 次
  await tagsRepo.remove(tag.id)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assertEqual(notifications, 2, `隔开的动作应各通知一次，实际 ${notifications}`)

  // ③ 重建索引（t20/F2 那条路径）也必须通知
  await db.rebuildIndex()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assertEqual(notifications, 3, `rebuildIndex 应通知，实际 ${notifications}`)

  // ④ 取消订阅后不再收到
  unsubscribe()
  unsubscribeThrower()
  await notesRepo.create({ title: '取消订阅后', content: 'y' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assertEqual(notifications, 3, '取消订阅后不应再收到通知')
  assertEqual(db.indexMutationListenerCount(), 0, '订阅者应已移除')
  db.resetIndexMutationListeners()
})

await check('订阅者视角（模拟 App.useMeta）：打标签后徽标数据自动变 1，无需任何手动刷新', async () => {
  db.resetIndexMutationListeners()
  const s11 = await freshScenario('badge')

  // 完全照 App.useMeta 的 reload 复刻：订阅索引变更 → 重新拉取 folders/tags/counts
  let badgeCounts = null
  const unsubscribe = db.onIndexMutated(() => {
    void (async () => {
      const [tree, tagList, nextCounts] = await Promise.all([
        foldersRepo.tree(),
        tagsRepo.list(),
        notesRepo.counts(),
      ])
      void tree
      void tagList
      badgeCounts = nextCounts
    })()
  })

  // 初始状态：还没有任何笔记 → 徽标 0
  badgeCounts = await notesRepo.counts()
  assertEqual(badgeCounts.byTag['888'] ?? 0, 0, '初始应为 0')

  // 用户动作：新建一条笔记并打上 888（编辑器/列表走的就是这条路径）
  const note = await notesRepo.create({ title: '用户的一条笔记', content: '正文' })
  await tagsRepo.setNoteTags(note.id, ['888'])
  await new Promise((resolve) => setTimeout(resolve, 120)) // 等防抖投递 + 订阅者 reload 完成

  assert(badgeCounts, '订阅者应已重新拉取到计数')
  assertEqual(badgeCounts.byTag['888'] ?? 0, 1, `徽标数据应自动变为 1（无需手动刷新），实际 ${JSON.stringify(badgeCounts.byTag)}`)
  assertEqual(badgeCounts.byTag['888'] ?? 0, (await tagCountsFromFiles(s11.vaultRoot))['888'] ?? 0, '与 md 真值源一致')
  unsubscribe()
  db.resetIndexMutationListeners()
})

/* ==================== 场景 12：导入笔记（t37 · 需求 A） ==================== */

group('12 导入 md 笔记（t37-A：通用 Markdown + 边界）')

const s12 = await freshScenario('import')
const importRoot = path.join(runRoot, 'sources')
await nodeFsPort.mkdir(importRoot, { recursive: true })

/** 在源目录里写一个纯文本 md（UTF-8） */
async function writeSource(name, text) {
  const absolute = path.join(importRoot, name)
  await nodeFsPort.mkdir(path.dirname(absolute), { recursive: true })
  writeFileSync(insideRunRoot(absolute), text, 'utf8')
  return absolute
}

/** 在源目录里写一个"二进制"文件（用于非 UTF-8 边界） */
function writeSourceBytes(name, bytes) {
  const absolute = path.join(importRoot, name)
  writeFileSync(insideRunRoot(absolute), Buffer.from(bytes))
  return absolute
}

await check('无 front-matter：标题取首个 # 标题，正文逐字保留（含标题行），补写规范 front-matter', async () => {
  const sourceText = '# 我的导入标题\n\n正文第一行\n\n- 列表项\n'
  const source = await writeSource('no-fm.md', sourceText)
  const result = await db.importMarkdownPaths([source])
  assertEqual([result.imported, result.skipped, result.failed], [1, 0, 0], `应成功 1 条：${result.summary}`)
  assert(result.summary.includes('成功 1 条'), `summary 应可读：${result.summary}`)
  const note = (await notesRepo.listAll()).find((item) => item.title === '我的导入标题')
  assert(note, '应能在索引里按标题找到导入的笔记')
  // 需求：「正文保持原样」⇒ 正文就是整篇原文（标题行也在正文里）
  assertEqual(note.content, sourceText.replace(/\r\n/g, '\n'), '正文应逐字保留原样')
  const files = await readAllNotes(s12.vaultRoot)
  const entry = [...files.entries()].find(([, parsed]) => parsed.data.id === note.id)
  assert(entry[1].hasFrontMatter, '应补写 front-matter')
  assertEqual(entry[1].data.title, '我的导入标题', 'front-matter 标题取自 # 标题行')
})

await check('无标题：正文没有 # 时标题取文件名（去扩展名）', async () => {
  const source = await writeSource('文件名即标题.md', '这是一段没有标题的正文。\n')
  const result = await db.importMarkdownPaths([source])
  assertEqual(result.imported, 1, result.summary)
  const note = (await notesRepo.listAll()).find((item) => item.content.includes('没有标题的正文'))
  assertEqual(note.title, '文件名即标题', '标题应来自文件名')
})

await check('有 front-matter：保留 tags/pinned/created/updated；id 冲突时重新分配', async () => {
  const existing = await notesRepo.create({ title: '已被占用的 id', content: '原有内容' })
  const source = await writeSource(
    'with-fm.md',
    [
      '---',
      `id: ${existing.id}`,
      'title: 带元数据的导入',
      'tags:',
      '  - 导入标签',
      'pinned: true',
      'created: 1700000001000',
      'updated: 1700000002000',
      'order: 999',
      '---',
      '',
      '带元数据的正文',
      '',
    ].join('\n'),
  )
  const result = await db.importMarkdownPaths([source])
  assertEqual(result.imported, 1, result.summary)
  const imported = (await notesRepo.listAll()).find((item) => item.title === '带元数据的导入')
  assert(imported, '应导入成功')
  assert(imported.id !== existing.id, 'id 冲突必须重新分配（不得抢占已有笔记 id）')
  assertEqual(imported.tags, ['导入标签'], '标签保留')
  assertEqual(imported.pinned, true, '置顶保留')
  assertEqual(imported.createdAt, 1700000001000, 'created 保留')
  assertEqual(imported.updatedAt, 1700000002000, 'updated 保留')
  assertEqual((await notesRepo.get(existing.id)).content, '原有内容', '已有笔记不得被覆盖')
})

await check('文件名冲突：不覆盖，自动加后缀且结果标记 renamed', async () => {
  // 两个不同目录下的同名文件 → 都落到收件箱 → 第二个必须加 -2
  const first = await writeSource('重名.md', '第一条内容\n')
  const second = await writeSource('另一处/重名.md', '第二条内容\n')
  const before = await db.importMarkdownPaths([first])
  const after = await db.importMarkdownPaths([second])
  assertEqual([before.imported, after.imported], [1, 1], '两条都应导入')
  assertEqual(after.files[0].renamed, true, `第二条应被标记重名改名：${JSON.stringify(after.files[0])}`)
  const files = await readAllNotes(s12.vaultRoot)
  const names = [...files.keys()].filter((rel) => !rel.startsWith('.'))
  assert(names.includes('重名.md') && names.includes('重名-2.md'), `应同时存在两个文件：${JSON.stringify(names)}`)
  const contents = [...files.values()].map((parsed) => parsed.body.trim()).sort()
  assert(contents.includes('第一条内容') && contents.includes('第二条内容'), '两条内容都完好（未互相覆盖）')
})

await check('边界：空文件 / 超大文件 / 非 UTF-8 → 跳过并给出可读原因（不产生 0 字节垃圾）', async () => {
  const empty = await writeSource('empty.md', '')
  const whitespace = await writeSource('blank.md', '   \n\t\n')
  const gbk = writeSourceBytes('gbk.md', [0xc4, 0xe3, 0xba, 0xc3, 0x0a]) // GBK「你好」
  const big = await writeSource('big.md', `# 大文件\n\n${'x'.repeat(200)}\n`)
  const result = await db.importMarkdownPaths([empty, whitespace, gbk, big], { maxBytes: 100 })

  assertEqual(result.imported, 0, `都不应导入：${JSON.stringify(result.files.map((f) => [path.basename(f.source), f.status, f.reason]))}`)
  assertEqual(result.skipped, 4, '四条都应计入 skipped')
  const reasonOf = (name) => result.files.find((item) => item.source.endsWith(name))?.reason ?? ''
  assert(reasonOf('empty.md').includes('空文件'), `空文件原因：${reasonOf('empty.md')}`)
  assert(reasonOf('blank.md').includes('空文件'), `纯空白原因：${reasonOf('blank.md')}`)
  assert(reasonOf('gbk.md').includes('UTF-8'), `非 UTF-8 原因：${reasonOf('gbk.md')}`)
  assert(reasonOf('big.md').includes('过大'), `超大原因：${reasonOf('big.md')}`)
  // 没有产生任何 0 字节垃圾笔记文件
  const files = await readAllNotes(s12.vaultRoot)
  const zeroByte = [...files.entries()].filter(([, parsed]) => parsed.body.trim() === '' && !parsed.data.title)
  assertEqual(zeroByte.length, 0, '不应产生空的垃圾笔记')
})

await check('边界：含 BOM → 剥离 BOM 后正常导入（标题不含 BOM）', async () => {
  const source = writeSourceBytes('bom.md', [
    0xef,
    0xbb,
    0xbf,
    ...Buffer.from('# BOM 标题\n\nBOM 正文\n', 'utf8'),
  ])
  const result = await db.importMarkdownPaths([source])
  assertEqual(result.imported, 1, result.summary)
  const note = (await notesRepo.listAll()).find((item) => item.content.includes('BOM 正文'))
  assertEqual(note.title, 'BOM 标题', 'BOM 必须被剥离（否则标题会带不可见字符）')
})

await check('目录导入：递归 + 保留子目录结构（子目录 → 文件夹）+ 跳过隐藏目录与非 md', async () => {
  const dir = path.join(importRoot, 'vault-like')
  await nodeFsPort.mkdir(path.join(dir, '子目录'), { recursive: true })
  await nodeFsPort.mkdir(path.join(dir, '.obsidian'), { recursive: true })
  writeFileSync(insideRunRoot(path.join(dir, '顶层.md')), '# 顶层\n\n顶层正文\n', 'utf8')
  writeFileSync(insideRunRoot(path.join(dir, '子目录', '深层.md')), '# 深层\n\n深层正文\n', 'utf8')
  writeFileSync(insideRunRoot(path.join(dir, '.obsidian', 'config.md')), '# 隐藏\n\n不该被导入\n', 'utf8')
  writeFileSync(insideRunRoot(path.join(dir, '忽略.txt')), '不是 md\n', 'utf8')

  const result = await db.importMarkdownPaths([dir], { extraTags: ['导入'] })
  assertEqual([result.imported, result.failed], [2, 0], `应导入 2 条：${JSON.stringify(result.files.map((f) => [f.status, f.reason]))}`)
  assert(result.summary.includes('新建文件夹'), `summary 应报告新建文件夹：${result.summary}`)

  const folders = (await foldersRepo.list()).map((folder) => folder.name)
  assert(folders.includes('子目录'), `应新建子目录对应的文件夹：${JSON.stringify(folders)}`)

  const all = await notesRepo.listAll()
  const deep = all.find((note) => note.title === '深层')
  assert(deep, '深层笔记应导入')
  assertEqual(deep.tags.includes('导入'), true, 'extraTags 应合并进标签')
  const deepFolder = (await foldersRepo.list()).find((folder) => folder.id === deep.folderId)
  assertEqual(deepFolder?.name, '子目录', '深层笔记应落在子目录对应的文件夹')
  assertEqual(all.some((note) => note.title === '隐藏'), false, '隐藏目录里的 md 不得导入')
  const searchHits = await searchRepo.search('深层正文')
  assert(searchHits.some((hit) => hit.note.id === deep.id), '导入后应可被全文搜索到')
})

/* ==================== 场景 13：更换数据目录（t37 · 需求 B） ==================== */

group('13 更换数据目录（t37-B：先复制 → 校验 → 再切换）')

const s13 = await freshScenario('relocate')
await notesRepo.create({ title: '搬迁样本一', content: '搬迁正文一', tags: ['搬迁'] })
await notesRepo.create({ title: '搬迁样本二', content: '搬迁正文二\n\n---\n\n含分隔线' })
const trashSample = await notesRepo.create({ title: '搬迁样本三', content: '回收站里也要搬' })
await notesRepo.remove(trashSample.id)
const sourceRootBefore = db.getStorage().vaultRoot

await check('正常往返：切换 → 校验（文件数/字节/抽样 sha256）→ 读回内容一致 → 旧目录保留', async () => {
  const targetRoot = path.join(runRoot, 'relocated-vault')
  const result = await db.relocateVault(targetRoot)
  assertEqual(result.status, 'relocated', `应切换成功：${result.reason ?? ''}${result.summary}`)
  assert(result.verification, '应给出校验快照')
  assertEqual(
    [result.verification.sourceFiles, result.verification.targetFiles],
    [result.verification.sourceFiles, result.verification.sourceFiles],
    '文件数应一致',
  )
  assertEqual(result.verification.sourceBytes, result.verification.targetBytes, '总字节应一致')
  assert(result.verification.sampled >= 1 && result.verification.sampleMatches === result.verification.sampled, '抽样应全部一致')
  assertEqual(result.verification.hashUnavailable, false, '应真的算了 sha256')
  assertEqual(result.oldDataKeptAt, sourceRootBefore, '必须告知旧数据仍在何处')
  assert(result.summary.includes('旧数据仍保留'), `summary 应明确告知旧目录：${result.summary}`)

  // 切换确实生效（内存配置 + 位置文件）
  assertEqual(db.getStorage().vaultRoot, targetRoot, '存储根应切到新目录')
  const location = await db.loadVaultLocation(db.getStorage().fs, db.getStorage().appDataDir)
  assertEqual(location, targetRoot, '位置文件应记录新目录（重启后生效）')

  // 读回：新旧两侧文件都在，且内容一致
  const notes = await notesRepo.listAll()
  assertEqual(notes.length, 2, '活着的笔记应还在')
  assertEqual((await notesRepo.listAll({ onlyDeleted: true })).length, 1, '回收站笔记应一并搬迁')
  const newFiles = await readAllNotes(targetRoot)
  const oldFiles = await readAllNotes(sourceRootBefore)
  assertEqual(newFiles.size, oldFiles.size, '新旧目录 md 数量一致（旧目录保留）')
  for (const [rel, parsed] of newFiles) {
    const oldParsed = oldFiles.get(rel)
    assert(oldParsed, `旧目录应仍有 ${rel}`)
    assertEqual(parsed.body, oldParsed.body, `${rel} 内容一致`)
  }
  assert(result.indexedNotes !== null && result.indexedNotes >= 2, `应重建索引：${result.indexedNotes}`)
})

await check('往返：切回原目录（restoreVaultRoot）后内容仍一致', async () => {
  const result = await db.restoreVaultRoot(sourceRootBefore)
  assertEqual(result.status, 'relocated', `应能切回：${result.reason ?? ''}`)
  assertEqual(db.getStorage().vaultRoot, sourceRootBefore, '存储根应回到原目录')
  const notes = await notesRepo.listAll()
  assertEqual(notes.length, 2, '笔记应完好')
  assertEqual((await notesRepo.get(trashSample.id)), null, '回收站笔记的软删除状态保持不变')
  const hits = await searchRepo.search('搬迁正文一')
  assert(hits.length >= 1, '切换后搜索仍可用')
})

await check('失败反证 A（复制失败）：原目录与配置完好，半成品副本被清理', async () => {
  const targetRoot = path.join(runRoot, 'relocate-fail-copy')
  let copies = 0
  const result = await db.relocateVault(targetRoot, {
    copyFile: async (from, to) => {
      copies += 1
      if (copies === 2) throw new Error('模拟复制中断：磁盘写满')
      await nodeFsPort.copyFile(from, to)
    },
  })
  assertEqual(result.status, 'failed', '应判定失败')
  assert(result.reason?.includes('复制失败'), `原因应可读：${result.reason}`)
  assertEqual(db.getStorage().vaultRoot, sourceRootBefore, '**存储根绝不能变**')
  assertEqual(existsSync(targetRoot), false, '半成品副本应被清理（删的是副本，不是原数据）')
  const notes = await notesRepo.listAll()
  assertEqual(notes.length, 2, '**原数据完好**')
  assertEqual((await notesRepo.get((await notesRepo.listAll())[0].id))?.content.length > 0, true, '原文可读')
  const locationAfter = await db.loadVaultLocation(db.getStorage().fs, db.getStorage().appDataDir)
  assertEqual(locationAfter, sourceRootBefore, '位置文件不得被改写')
})

await check('失败反证 B（校验不通过）：不切换、原数据完好', async () => {
  const targetRoot = path.join(runRoot, 'relocate-fail-verify')
  const result = await db.relocateVault(targetRoot, {
    sha256: async () => 'deadbeef'.repeat(8), // 两侧哈希"相同"但源/目标分别调用：这里恒返回同值
    beforeSwitch: async () => {
      throw new Error('模拟切换前发现异常')
    },
  })
  assertEqual(result.status, 'failed', '应判定失败')
  assert(result.reason?.includes('切换前'), `原因应可读：${result.reason}`)
  assertEqual(db.getStorage().vaultRoot, sourceRootBefore, '**存储根绝不能变**')
  const notes = await notesRepo.listAll()
  assertEqual(notes.length, 2, '**原数据完好**')

  // 真正让"校验不一致"发生：注入只在目标侧返回不同哈希的实现
  const targetRoot2 = path.join(runRoot, 'relocate-fail-hash')
  let calls = 0
  const result2 = await db.relocateVault(targetRoot2, {
    sha256: async () => {
      calls += 1
      return calls % 2 === 1 ? 'aaaa' : 'bbbb'
    },
  })
  assertEqual(result2.status, 'failed', '抽样哈希不一致应判定失败')
  assert(result2.reason?.includes('sha256'), `原因应提到 sha256：${result2.reason}`)
  assertEqual(db.getStorage().vaultRoot, sourceRootBefore, '**仍未切换**')
  assertEqual((await notesRepo.listAll()).length, 2, '**原数据仍完好**')
})

await check('前置拒绝：同目录 / 子目录 / 相对路径 / 目标非空 → 全部拒绝且原数据不变', async () => {
  const same = await db.relocateVault(sourceRootBefore)
  assertEqual(same.status, 'failed', '同目录应拒绝')
  assert(same.reason?.includes('相同'), same.reason ?? '')

  const inside = await db.relocateVault(path.join(sourceRootBefore, '子目录'))
  assertEqual(inside.status, 'failed', '当前目录内部应拒绝')
  assert(inside.reason?.includes('内部'), inside.reason ?? '')

  const relative = await db.relocateVault('relative-dir')
  assertEqual(relative.status, 'failed', '相对路径应拒绝')
  assert(relative.reason?.includes('绝对路径'), relative.reason ?? '')

  const occupied = path.join(runRoot, 'relocate-occupied')
  await nodeFsPort.mkdir(occupied, { recursive: true })
  writeFileSync(insideRunRoot(path.join(occupied, '别人的文件.txt')), '不该被覆盖', 'utf8')
  const nonEmpty = await db.relocateVault(occupied)
  assertEqual(nonEmpty.status, 'failed', '目标非空应拒绝')
  assert(nonEmpty.reason?.includes('空目录'), nonEmpty.reason ?? '')
  assertEqual(readFileSync(path.join(occupied, '别人的文件.txt'), 'utf8'), '不该被覆盖', '目标里的文件不得被碰')

  assertEqual(db.getStorage().vaultRoot, sourceRootBefore, '**四次拒绝后存储根都不变**')
  assertEqual((await notesRepo.listAll()).length, 2, '**原数据完好**')
})

/* ==================== 场景 14：跨文件夹整体重排 reorder（t42） ==================== */
/* t36 用户实测：「拖动排序无效、松手回归原位」。根因是「全部笔记」视图是**跨文件夹的全局
   列表**，而 `move` 只在笔记所属文件夹的子集里重排（各夹各自编 0..m-1 的重叠值）。
   t42 由 db 层提供唯一入口：按给定顺序整体重排、跨文件夹、order 唯一、**绝不刷 updatedAt**。
   本场景守住这些语义（store 侧「拖动 → 顺序落地」由 features/notes-list 的
   reorder-persistence.check.mjs 端到端覆盖，避免重复造断言）。 */

group('14 跨文件夹整体重排 reorder（t42：只改 order、绝不刷 updatedAt）')

const s14 = await freshScenario('reorder')
const s14Vault = s14.vaultRoot
const reoHandle = (await import('./stub-plugin-sql.mjs')).__handle()
const reoFolderA = await foldersRepo.create({ name: '重排甲' })
const reoFolderB = await foldersRepo.create({ name: '重排乙' })
/* 布局：1 条置顶（收件箱）+ 收件箱 2 条 + 甲夹 1 条 + 乙夹 1 条 = 跨 2 文件夹的全局列表 */
const reoPinned = await notesRepo.create({ title: '置顶条', content: '置顶正文 ZJREO-P', pinned: true })
const reoInboxA = await notesRepo.create({ title: '收件箱甲', content: '正文甲 ZJREO-A' })
const reoInFolderA = await notesRepo.create({ folderId: reoFolderA.id, title: '甲夹笔记', content: '正文乙 ZJREO-B' })
const reoInFolderB = await notesRepo.create({ folderId: reoFolderB.id, title: '乙夹笔记', content: '正文丙 ZJREO-C' })
const reoInboxD = await notesRepo.create({ title: '收件箱丁', content: '正文丁 ZJREO-D' })

/** 显示顺序：`listAll()` 缺省规范序 pinned DESC, sort_order ASC（等价于前端 sortNotes(notes,'order')） */
const reoDisplay = async () => (await notesRepo.listAll()).map((note) => note.id)
/** md 落盘：id → { rel, order }（含 .trash/ 里的软删除笔记） */
async function reoMdRows(vaultRoot) {
  const rows = new Map()
  for (const [rel, parsed] of await readAllNotes(vaultRoot)) {
    if (typeof parsed.data?.id !== 'string') continue
    rows.set(parsed.data.id, { rel, order: Number(parsed.data.order) })
  }
  return rows
}
/** 索引里的 id → sort_order（活着的笔记） */
const reoIndexOrders = () =>
  new Map(
    reoHandle
      .prepare('SELECT id, sort_order FROM notes WHERE deleted_at IS NULL')
      .all()
      .map((row) => [String(row.id), Number(row.sort_order)]),
  )
const reoRelRows = async (vaultRoot) =>
  [...(await reoMdRows(vaultRoot))].map(([id, row]) => [id, row.rel]).sort((a, b) => (a[0] < b[0] ? -1 : 1))

await check('三层一致：显示顺序 == 传入顺序，且 md order == 索引 sort_order == 数组下标', async () => {
  const desired = [reoPinned.id, reoInFolderB.id, reoInboxD.id, reoInFolderA.id, reoInboxA.id]
  const returned = await notesRepo.reorder(desired)
  assertEqual(returned.map((note) => note.id), desired, '返回值应按传入顺序（不含被跳过项）')
  assertEqual(await reoDisplay(), desired, '重新读库的显示顺序必须等于传入顺序（不再「回归原位」）')

  const mdRows = await reoMdRows(s14Vault)
  const indexOrders = reoIndexOrders()
  const mismatches = []
  desired.forEach((id, index) => {
    if (indexOrders.get(id) !== index) mismatches.push(`索引 ${id.slice(0, 8)}=${indexOrders.get(id)}≠${index}`)
    if (mdRows.get(id)?.order !== index) mismatches.push(`md ${id.slice(0, 8)}=${mdRows.get(id)?.order}≠${index}`)
  })
  assertEqual(mismatches, [], 'md front-matter / 索引 sort_order 都必须等于数组下标')
  assertEqual(
    [...new Set(indexOrders.values())].length,
    indexOrders.size,
    '重排后的 order 必须两两不同（唯一，避免合并时整块移位）',
  )
})

await check('只改 order：不重命名、不移动文件、folderId 不变、pinned 不变', async () => {
  const relBefore = await reoRelRows(s14Vault)
  /** 按 id 排序后再比对（重排会改显示顺序，逐位比对会因为"顺序变了"而假失败） */
  const pinRows = async () =>
    (await notesRepo.listAll())
      .map((note) => [note.id, note.pinned, note.folderId])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const pinBefore = await pinRows()
  const desired = [reoPinned.id, reoInboxA.id, reoInFolderB.id, reoInboxD.id, reoInFolderA.id]
  await notesRepo.reorder(desired)
  assertEqual(await reoRelRows(s14Vault), relBefore, '每篇笔记的相对路径都不应变（只改 front-matter 的 order）')
  assertEqual(await pinRows(), pinBefore, 'pinned / folderId 不得被重排改写（文件不能跨目录搬）')
  assertEqual(await reoDisplay(), desired, '显示顺序应为新传入的顺序')
})

await check('**updatedAt / createdAt 逐一不变**（重排不是内容变更，不污染「最近更新」）', async () => {
  const before = new Map((await notesRepo.listAll()).map((note) => [note.id, note]))
  await new Promise((resolve) => setTimeout(resolve, 5)) // 保证若实现错误地取 now()，时间戳会真的不同
  const ids = await reoDisplay()
  // ⚠️ 重排输入必须保持「置顶恒在最前」的规范序：`listAll()` 按 `pinned DESC, sort_order ASC`
  // 排序，若把置顶条（ids[0]）挪到非首位，读回时规范序会把它拉回首行 —— 那是**正确行为**，
  // 不是「重排失败」。本断言首版写成 [ids[2], ids[0], …]（置顶落到第二位）⇒ 误报
  // 「顺序不等于传入顺序」，并级联出「closeDb+initDb 后顺序不变 / database is not open」。
  // 故：保持 ids[0]（置顶条）在首位，只重排其余 4 条。
  await notesRepo.reorder([ids[0], ids[2], ids[1], ids[4], ids[3]])
  const after = await notesRepo.listAll()
  const changed = after
    .filter((note) => {
      const old = before.get(note.id)
      return old.updatedAt !== note.updatedAt || old.createdAt !== note.createdAt || old.title !== note.title || old.content !== note.content
    })
    .map((note) => note.title)
  assertEqual(changed, [], '任何笔记的 updatedAt / createdAt / 标题 / 正文都不得被重排改写')
  assertEqual(await reoDisplay(), [ids[0], ids[2], ids[1], ids[4], ids[3]], '顺序仍应等于传入顺序（置顶条保持首位，符合 pinned DESC 规范序）')
})

await check('重排不动索引以外的东西：FTS 行数 / 搜索 / 计数都不变', async () => {
  const ftsBefore = Number(reoHandle.prepare('SELECT COUNT(*) AS c FROM notes_fts_trigram').get().c)
  const countsBefore = await notesRepo.counts()
  const hitsBefore = (await searchRepo.search('正文甲 ZJREO-A')).map((hit) => hit.note.id)
  assert(hitsBefore.includes(reoInboxA.id), '前置：重排前应能搜到「收件箱甲」')

  const ids = await reoDisplay()
  await notesRepo.reorder([...ids].reverse())

  assertEqual(Number(reoHandle.prepare('SELECT COUNT(*) AS c FROM notes_fts_trigram').get().c), ftsBefore, 'FTS 行数不变')
  assertEqual(await notesRepo.counts(), countsBefore, '侧边栏计数不变')
  assertEqual(
    (await searchRepo.search('正文甲 ZJREO-A')).map((hit) => hit.note.id),
    hitsBefore,
    '重排不应改变搜索结果',
  )
})

await check('rebuildIndex() 后顺序与 order 值都不变（order 真的落在了 md 里）', async () => {
  const desired = await reoDisplay()
  const mdBefore = await reoMdRows(s14Vault)
  await db.rebuildIndex()
  assertEqual(await reoDisplay(), desired, '重建索引后显示顺序应不变')
  const mdAfter = await reoMdRows(s14Vault)
  for (const id of desired) {
    assertEqual(mdAfter.get(id)?.order, mdBefore.get(id)?.order, `重建索引后「${id.slice(0, 8)}」的 md order 应不变`)
  }
})

await check('closeDb + initDb（等价重启）后顺序不变', async () => {
  const desired = await reoDisplay()
  /* 重启前的双层快照：md front-matter 的 order + 索引 sort_order */
  const mdBefore = await reoMdRows(s14Vault)
  const indexBefore = reoIndexOrders()
  await db.closeDb()
  await db.initDb()
  assertEqual(await reoDisplay(), desired, '重启后显示顺序应不变')
  const mdAfter = await reoMdRows(s14Vault)
  // ⚠️ 必须先取「最新」句柄：stub 的 `Database.load()` 每次都会新建一个 `:memory:` 库
  // （见 stub-plugin-sql.mjs:34-40），因此 closeDb + initDb 之后**场景开头缓存的 reoHandle
  // 已经关闭**；继续用它做底层断言会报「database is not open」或读到空库。
  const freshHandle = (await import('./stub-plugin-sql.mjs')).__handle()
  const indexAfter = new Map(
    freshHandle
      .prepare('SELECT id, sort_order FROM notes WHERE deleted_at IS NULL')
      .all()
      .map((row) => [String(row.id), Number(row.sort_order)]),
  )
  // ⚠️ 不能用「显示下标 == order」比对：置顶笔记按 `pinned DESC` 恒排最前，它的 order 可为任意值
  // （例：置顶条 order=4 仍显示在第 0 位）—— 本断言要守的是「重启前后 order 逐篇不变」。
  for (const id of desired) {
    assertEqual(mdAfter.get(id)?.order, mdBefore.get(id)?.order, `重启后「${id.slice(0, 8)}」md order 应不变`)
    assertEqual(indexAfter.get(id), indexBefore.get(id), `重启后「${id.slice(0, 8)}」索引 sort_order 应不变`)
  }
})

await check('边界：空串 / 重复 id / 不存在的 id 一律跳过（拖拽不能被过期 id 整次拖失败）', async () => {
  const before = await notesRepo.listAll()
  const listed = [before[1].id, before[3].id]
  const orderById = async () =>
    (await notesRepo.listAll())
      .filter((note) => !listed.includes(note.id))
      .map((note) => [note.id, note.order])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const untouchedBefore = await orderById()
  const returned = await notesRepo.reorder([listed[0], '', listed[0], 'zj-not-exist-id', listed[1]])
  assertEqual(returned.map((note) => note.id), listed, '只返回真实存在且去重后的笔记，顺序保持')
  assertEqual(await orderById(), untouchedBefore, '未出现在数组里的笔记 order 必须原样保持')
  assertEqual((await notesRepo.listAll()).length, before.length, '不得凭空多/少笔记')
})

await check('边界：空数组是合法 no-op（返回 [] 且一切不变）', async () => {
  const before = (await notesRepo.listAll()).map((note) => [note.id, note.order, note.updatedAt])
  assertEqual(await notesRepo.reorder([]), [], '空数组应返回空结果')
  assertEqual(
    (await notesRepo.listAll()).map((note) => [note.id, note.order, note.updatedAt]),
    before,
    '空数组不得改动任何笔记',
  )
})

await check('软删除笔记出现在数组里也不复活：仍在回收站、文件仍在 .trash/', async () => {
  const doomed = await notesRepo.create({ title: '将被软删', content: 'ZJREO-TRASH 正文' })
  await notesRepo.remove(doomed.id)
  assertEqual(await notesRepo.get(doomed.id), null, '前置：软删除后 get 应为 null')

  const active = await reoDisplay()
  const returned = await notesRepo.reorder([...active, doomed.id])
  assertEqual(returned.map((note) => note.id), [...active, doomed.id], '回收站笔记也应能参与重排')

  assertEqual(await notesRepo.get(doomed.id), null, '**软删除笔记不得因重排复活**')
  assert(
    (await notesRepo.listAll({ onlyDeleted: true })).some((note) => note.id === doomed.id),
    '它仍应在回收站列表里',
  )
  assertEqual(await reoDisplay(), active, '回收站笔记不应混进活着的列表')
  assertEqual(
    (await reoMdRows(s14Vault)).get(doomed.id)?.rel.startsWith('.trash/'),
    true,
    '文件仍应留在 .trash/（不能被搬回根目录）',
  )
  const reloaded = await notesRepo.listAll({ onlyDeleted: true })
  const found = reloaded.find((note) => note.id === doomed.id)
  assertEqual(found?.content, 'ZJREO-TRASH 正文', '回收站笔记正文不得被重排改写')
})

/* ============================== 收尾 ============================== */

} catch (error) {
  // 未捕获异常（例如临时目录被外部清理）：记成失败项，finally 与汇总照常执行
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
console.log('\n' + '─'.repeat(72))
for (const result of failed) console.log(`❌ [${result.group}] ${result.name}\n   ↳ ${result.error}`)
console.log(`fs-store 自检：总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
console.log(failed.length === 0 ? '✅ md 真相源 / 索引重建 / 迁移 全部通过' : '❌ 存在失败项')
process.exitCode = failed.length === 0 ? 0 : 1
}

