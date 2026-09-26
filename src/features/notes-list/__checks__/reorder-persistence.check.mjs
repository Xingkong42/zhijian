#!/usr/bin/env node
/**
 * 纸笺 · 拖动排序持久化自检（t36）
 * ============================================================================
 * 运行：node src/features/notes-list/__checks__/reorder-persistence.check.mjs
 *      退出码 0 = 全部通过；非 0 = 有断言失败（打印完整诊断）
 *
 * ## 这个脚本要守住什么（t36 用户实测：「能拖，松手后自动回归原位」）
 * t15 之后 md 是真相源：`move` 要把新的 `order` 写进**每一篇相关笔记的 front-matter**
 * 并同步索引，读取路径又可能被「索引增量 sync / rebuildIndex」覆盖。所以这里用
 * **真实临时 vault + 真实 SQLite**（复用 db 层自检的 loader 与 FsPort）断言三层一致：
 *
 *   ① 前端显示顺序（`sortNotes(notes,'order')`，等于 db 的 `scopeInbox/scopeFolder` 规范序）
 *   ② 索引顺序（`notesRepo.listAll()` 返回的 order 值）
 *   ③ md 落盘的 order（每篇文件 front-matter 的 `order:`）
 *   ④ `closeDb + initDb`（等价重启）与 `rebuildIndex()` 之后顺序不变
 *
 * ## 已知缺口（本脚本会**打印**但不断言，因为修在 db 层）
 * `notesRepo.move` 只在**该笔记所属文件夹**的子集里重排（`scopeInbox/scopeFolder`），
 * 而「全部笔记」视图是**跨文件夹的全局列表**：UI 落点是全局下标，放进 `move` 会被
 * `Math.min(targetIndex, others.length)` 夹住，且各文件夹各自重排成 `0..m-1` 的**重叠值**，
 * 全局合并后整块都可能移位 —— 这就是用户看到的「拖了没反应 / 回原位」。
 * 精确修复需要 db 侧提供一个「按给定顺序整体重排（跨文件夹、唯一 order、不刷 updatedAt）」
 * 的入口（已按任务要求发消息给 data），本脚本的场景 0 会把现状与该缺口都打印出来。
 *
 * 只读业务代码、只写**临时目录**，结束必定清理并断言工作区零污染（同 t28 口径）。
 */

import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..', '..')

register(new URL('../../../db/__checks__/loader.mjs', import.meta.url).href)

const db = await import('../../../db/index.ts')
const { notesRepo } = await import('../../../db/notes.ts')
const { foldersRepo } = await import('../../../db/folders.ts')
const { parseFrontMatter } = await import('../../../db/frontmatter.ts')
const { sortNotes } = await import('../ordering.ts')
const { useNotesStore: notesStore } = await import('../../../store/notes.ts')
const { nodeFsPort, listTree, readTextIfExists } = await import('../../../db/__checks__/node-fs-port.mjs')
const {
  makeRunRoot,
  cleanupRunRoot,
  guardFsPort,
  snapshotWorkspace,
  diffWorkspace,
  listZeroByteRootFiles,
} = await import('../../../db/__checks__/harness.mjs')

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

/* ------------------------------ 场景工具 ------------------------------ */

const runRoot = await makeRunRoot('reorder')
const guarded = guardFsPort(nodeFsPort, { root: runRoot, label: 'reorder-persistence' })
const workspaceBefore = snapshotWorkspace(projectRoot)
const scenarioRoots = []

async function freshScenario(tag) {
  const root = path.join(runRoot, `${tag}-${scenarioRoots.length + 1}`)
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
  scenarioRoots.push(root)
  return { vaultRoot }
}

/** 读 vault 里每篇 md 的 front-matter：{ rel, id, order } */
async function mdRows(vaultRoot) {
  const rows = []
  for (const rel of await listTree(vaultRoot)) {
    if (rel.endsWith('/') || !rel.toLowerCase().endsWith('.md')) continue
    const raw = await readTextIfExists(path.join(vaultRoot, rel))
    const data = parseFrontMatter(raw ?? '').data
    rows.push({
      rel,
      id: typeof data?.id === 'string' ? data.id : null,
      order: Number.isFinite(Number(data?.order)) ? Number(data.order) : null,
      pinned: data?.pinned === true,
    })
  }
  return rows
}

/**
 * 规范序（= db 侧 `SQL.scopeInbox/scopeFolder` 的 ORDER BY，也是前端 `sortNotes('order')`）：
 * `pinned DESC, sort_order ASC, created_at ASC, id ASC`
 * 用它断言「显示顺序本身」而不是去比对 `listAll()` 的原始行顺序 ——
 * 后者的 tie-break 是 `id ASC`（不含 created_at），并列时与规范序不同，
 * 那是**并列时的显示细节**，不是拖拽失败的根因（但本脚本会把它打印出来备查）。
 */
function canonicalOrder(notes) {
  return [...notes].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.order - b.order ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** 三层一致性：① 显示顺序是规范序 ② 每篇 md 的 order == 索引/内存的 order ③ 顺序稳定 */
async function assertThreeLayers(vaultRoot, label, expectedTitles) {
  const list = await notesRepo.listAll()
  const display = sortNotes(list, 'order')
  const rows = await mdRows(vaultRoot)
  const mdOrderById = new Map(rows.map((row) => [row.id, row.order]))

  assertEqual(
    display.map((note) => note.id),
    canonicalOrder(list).map((note) => note.id),
    `${label}：显示顺序不是规范序（pinned→order→createdAt→id）`,
  )
  assertEqual(
    display.map((note) => note.title),
    expectedTitles,
    `${label}：显示顺序不符合预期`,
  )
  for (const note of list) {
    assert(mdOrderById.has(note.id), `${label}：md 里找不到「${note.title}」（${note.id.slice(0, 8)}）`)
    assertEqual(
      mdOrderById.get(note.id),
      note.order,
      `${label}：「${note.title}」md 落盘的 order 与索引 order 不一致`,
    )
  }
  // listAll 原始行顺序：置顶区在前，且**同一区组内** order 单调不减
  // （跨 pinned 边界时 order 值不保证单调：move 是按"列表位置"重新编号的，见场景 2）
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1]
    const current = list[index]
    assert(
      Number(previous.pinned) >= Number(current.pinned),
      `${label}：listAll 原始顺序没有把置顶项排在前面：` +
        `${previous.title}(pinned=${previous.pinned}) → ${current.title}(pinned=${current.pinned})`,
    )
    if (Number(previous.pinned) === Number(current.pinned)) {
      assert(
        previous.order <= current.order,
        `${label}：listAll 同一置顶区组内 order 非单调：` +
          `${previous.title}(order=${previous.order}) → ${current.title}(order=${current.order})`,
      )
    }
  }
  return { list, display, rows }
}

console.log('纸笺 · 拖动排序持久化自检（t36）')
console.log(`项目根目录：${projectRoot}`)
console.log(`临时根（唯一名）：${runRoot}`)

/** 复刻用户真实数据布局：4 条收件箱 + 2 条「诗词」 + 1 条「文学」 */
async function seedMixed(tag) {
  const scenario = await freshScenario(tag)
  const work = await foldersRepo.create({ name: '诗词' })
  const lit = await foldersRepo.create({ name: '文学' })
  const ids = new Map()
  for (const title of ['无标题-1', '无标题-2', '无标题-3', '无标题-4']) {
    ids.set(title, (await notesRepo.create({ title, content: `正文 ${title}` })).id)
  }
  for (const title of ['水调歌头', '无标题-45f2df']) {
    ids.set(title, (await notesRepo.create({ title, folderId: work.id })).id)
  }
  ids.set('无标题-231dba', (await notesRepo.create({ title: '无标题-231dba', folderId: lit.id })).id)
  return { ...scenario, ids }
}

const displayTitles = async () => sortNotes(await notesRepo.listAll(), 'order').map((n) => n.title)
const displayNotes = async () => sortNotes(await notesRepo.listAll(), 'order')

/** dnd-kit `arrayMove` 的等价实现（此处不引依赖，语义：移除自身后插到 to） */
function arrayMove(list, from, to) {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

try {
  /* ==================== 场景 0：跨文件夹「全部笔记」的坐标系 ==================== */

  group('0 坐标系：显示下标 vs 文件夹规范序下标（跨文件夹的「全部笔记」）')

  /* 先做「现状诊断」：这个场景单独一套 vault（db 绑定的就是它），
     模拟 UI 把**全局显示下标**直接交给 `notesRepo.move` 的旧行为。 */
  const s0raw = await seedMixed('mixed-raw')
  const rawBefore = await displayNotes()
  const rawMoving = rawBefore[3]
  await notesRepo.move(rawMoving.id, { targetIndex: 0 })
  const rawAfter = await displayNotes()
  console.log(
    `     [诊断·现状] 「${rawMoving.title}」从显示下标 3 拖到 0 → 实际落点 ` +
      `${rawAfter.findIndex((n) => n.id === rawMoving.id)}（全局下标被夹进它所属文件夹的子集 → 落不到目标位）`,
  )
  const loneNote = rawAfter.find(
    (note) =>
      note.folderId !== null && rawAfter.filter((mate) => mate.folderId === note.folderId).length === 1,
  )
  if (loneNote) {
    const beforePos = rawAfter.findIndex((n) => n.id === loneNote.id)
    await notesRepo.move(loneNote.id, { targetIndex: 0 })
    const loneAfter = await displayNotes()
    const afterPos = loneAfter.findIndex((n) => n.id === loneNote.id)
    console.log(
      `     [诊断·现状] 独自占一个文件夹的「${loneNote.title}」拖到显示下标 0：位置 ${beforePos} → ${afterPos}${
        afterPos === beforePos
          ? '（未变 ⇒ 该文件夹没有同夹邻居，插入位置恒为 0 ⇒ 用户报告的「回归原位」）'
          : '（落点与拖放位置不一致）'
      }`,
    )
  }
  void s0raw

  /* 再做「修复后」场景：独立 vault，断言换算 + 三层一致 + 重启稳定。 */
  const s0 = await seedMixed('mixed')

  await check('三层一致（新建后基准）：显示顺序是规范序 + md/索引 order 逐篇一致', async () => {
    await assertThreeLayers(s0.vaultRoot, '跨文件夹初始', await displayTitles())
  })

  /* 这一条就是用户报告的场景的**端到端断言**，走 store（captain 裁定 t42 方案 A：
     `store.move` 在 activeView==='all' 时改调 `notesRepo.reorder(orderedIds)`）。
     在 t42 落地前 `reorder` 不存在 ⇒ 明确打印「⏳ 待 t42」，不做假绿、也不把现状当通过。 */
  const repoWithReorder = /** @type {{ reorder?: (ids: readonly string[]) => Promise<unknown[]> }} */ (
    notesRepo
  )
  if (typeof repoWithReorder.reorder === 'function') {
    await check('【t42 已落地】「全部笔记」拖到全局第 k 位：顺序精确 == 期望 且 updatedAt 不变', async () => {
      const before = sortNotes(await notesRepo.listAll(), 'order')
      const updatedBefore = new Map(before.map((note) => [note.id, note.updatedAt]))
      const from = 4
      const to = 0
      const moving = before[from]
      const expected = arrayMove(before.map((note) => note.id), from, to)

      // 让 store 认为自己正在看「全部笔记」，再走它唯一的写入口 move
      notesStore.setState({
        notes: before,
        activeView: 'all',
        activeFolderId: null,
        activeTagId: null,
        error: null,
      })
      await notesStore.getState().move(moving.id, to, undefined)

      const after = sortNotes(await notesRepo.listAll(), 'order')
      assertEqual(after.map((note) => note.id), expected, '全局顺序必须等于 arrayMove(前, from, to)')
      for (const note of after) {
        assertEqual(
          note.updatedAt,
          updatedBefore.get(note.id),
          `「${note.title}」的 updatedAt 不应因重排而变化（t11/t15 红线）`,
        )
      }
      await assertThreeLayers(s0.vaultRoot, '整体重排后', after.map((n) => n.title))
      await db.closeDb()
      await db.initDb()
      const reloaded = sortNotes(await notesRepo.listAll(), 'order')
      assertEqual(reloaded.map((n) => n.id), expected, '重载后顺序必须仍是期望顺序')
    })
  } else {
    console.log(
      '     ⏳ 跨文件夹整体重排尚未启用：`notesRepo.reorder` 还不存在（captain 已建 t42 给 data）。',
    )
    console.log(
      '        当前行为（已如实上报）：跨文件夹拖拽会被夹进笔记所属文件夹的子集 ⇒ 落不到目标位；',
    )
    console.log('        独自占一个文件夹的笔记 others.length===0 ⇒ 插入位置恒为 0 ⇒ 表现即用户报告的「回归原位」。')
  }

  void s0raw

  /* ==================== 场景 1：单文件夹内拖拽完全精确 ==================== */

  group('1 单文件夹（收件箱）拖拽：精确 + 重启/重建索引后不变')
  const s1 = await freshScenario('basic')
  const ids = new Map()
  for (const title of ['一', '二', '三', '四', '五']) {
    ids.set(title, (await notesRepo.create({ title, content: `正文 ${title}` })).id)
  }

  await check('新建后三层一致', async () => {
    const before = await displayTitles()
    await assertThreeLayers(s1.vaultRoot, '初始', before)
  })

  const initial = await displayTitles()
  const LAST_INDEX = initial.length - 1

  await check('把第一条拖到末尾（targetIndex = 末位）', async () => {
    const moving = initial[0]
    await notesRepo.move(ids.get(moving), { targetIndex: LAST_INDEX })
    const expected = [...initial.slice(1), moving]
    await assertThreeLayers(s1.vaultRoot, '拖到末尾', expected)
  })

  await check('把最后一条拖到首位（targetIndex = 0）', async () => {
    const before = await displayTitles()
    const moving = before[before.length - 1]
    await notesRepo.move(ids.get(moving), { targetIndex: 0 })
    await assertThreeLayers(s1.vaultRoot, '拖到首位', [moving, ...before.slice(0, -1)])
  })

  await check('把第 0 条拖到中间（targetIndex = 2）', async () => {
    const before = await displayTitles()
    const moving = before[0]
    const rest = before.slice(1)
    await notesRepo.move(ids.get(moving), { targetIndex: 2 })
    await assertThreeLayers(s1.vaultRoot, '拖到中间', [...rest.slice(0, 2), moving, ...rest.slice(2)])
  })

  await check('重载（closeDb + initDb，等价重启）后顺序不变', async () => {
    const before = await displayTitles()
    await db.closeDb()
    await db.initDb()
    await assertThreeLayers(s1.vaultRoot, '重载后', before)
  })

  await check('rebuildIndex() 后顺序仍不变（索引可丢弃但顺序来自 md）', async () => {
    const before = await displayTitles()
    await db.rebuildIndex()
    await assertThreeLayers(s1.vaultRoot, '重建索引后', before)
  })

  /* ==================== 场景 2：置顶混排 ==================== */

  group('2 置顶混排：pinned 分区与 targetIndex 语义')
  const s2 = await freshScenario('pinned')
  const pids = new Map()
  for (const title of ['A', 'B', 'C', 'D']) {
    pids.set(title, (await notesRepo.create({ title })).id)
  }
  await notesRepo.update(pids.get('C'), { pinned: true })

  await check('置顶后置顶项排在最前，且三层一致', async () => {
    const display = await displayTitles()
    assertEqual(display[0], 'C', `置顶项应排第一，实际 ${JSON.stringify(display)}`)
    await assertThreeLayers(s2.vaultRoot, '置顶后', display)
  })

  await check('把非置顶项拖到显示下标 0：置顶项仍在最前', async () => {
    const before = await displayTitles()
    const moving = before[1]
    await notesRepo.move(pids.get(moving), { targetIndex: 0 })
    const after = await displayTitles()
    assertEqual(after[0], 'C', `置顶项必须仍在最前，实际 ${JSON.stringify(after)}`)
    await assertThreeLayers(s2.vaultRoot, '置顶区内拖拽', after)
  })

  /* ==================== 场景 3：跨文件夹移动 + 文件夹内重排 ==================== */

  group('3 跨文件夹移动与文件夹内重排')
  const s3 = await freshScenario('folder')
  const folder = await foldersRepo.create({ name: '工作' })
  const fids = new Map()
  for (const title of ['收件-A', '收件-B', '收件-C']) {
    fids.set(title, (await notesRepo.create({ title })).id)
  }
  for (const title of ['夹内-1', '夹内-2']) {
    fids.set(title, (await notesRepo.create({ title, folderId: folder.id })).id)
  }

  await check('把收件箱第一条移到文件夹内第 1 位（跨文件夹 + 目标文件夹内精确）', async () => {
    const moving = '收件-A'
    const folderBefore = (
      await notesRepo.listAll({ folderId: folder.id })
    ).map((n) => n.title)
    await notesRepo.move(fids.get(moving), { targetIndex: 1, folderId: folder.id })
    const folderAfter = (await notesRepo.listAll({ folderId: folder.id })).map((n) => n.title)
    const expected = [folderBefore[0], moving, ...folderBefore.slice(1)]
    assertEqual(folderAfter, expected, '文件夹内顺序应符合 targetIndex=1')
    const inbox = (await notesRepo.listAll({ folderId: null })).map((n) => n.title)
    assert(!inbox.includes(moving), '被移出的笔记不应仍在收件箱列表里')
    await assertThreeLayers(s3.vaultRoot, '跨文件夹移动后（全局）', await displayTitles())
  })

  await check('文件夹内第 0 条移到末尾（同文件夹重排精确）', async () => {
    const before = (await notesRepo.listAll({ folderId: folder.id })).map((n) => n.title)
    const moving = before[0]
    await notesRepo.move(fids.get(moving), { targetIndex: before.length - 1, folderId: folder.id })
    const after = (await notesRepo.listAll({ folderId: folder.id })).map((n) => n.title)
    assertEqual(after, [...before.slice(1), moving], '文件夹内重排结果不符')
    await assertThreeLayers(s3.vaultRoot, '文件夹内重排后（全局）', await displayTitles())
  })
} finally {
  await db.closeDb().catch(() => {})
  const workspaceAfter = snapshotWorkspace(projectRoot)
  const dirty = diffWorkspace(workspaceBefore, workspaceAfter)
  const zeroByte = listZeroByteRootFiles(projectRoot)
  await cleanupRunRoot(runRoot).catch(() => {})

  if (dirty.length > 0) {
    results.push({ name: '工作区零污染', ok: false, error: `工作区被改动：${dirty.join(', ')}` })
    console.log(`\n  ❌ 工作区零污染：${dirty.join(', ')}`)
  } else if (zeroByte.length > 0) {
    results.push({ name: '工作区零污染', ok: false, error: `根目录残留 0 字节文件：${zeroByte.join(', ')}` })
    console.log(`\n  ❌ 根目录残留 0 字节文件：${zeroByte.join(', ')}`)
  } else {
    results.push({ name: '工作区零污染', ok: true })
    console.log('\n  ✅ 工作区零污染（临时根已清理）')
  }
}

const failed = results.filter((item) => !item.ok)
console.log('\n===== 汇总 =====')
console.log(`  通过 ${results.length - failed.length} / 共 ${results.length}`)
for (const item of failed) console.log(`  ❌ [${item.group}] ${item.name}\n     ↳ ${item.error}`)
if (failed.length > 0) {
  console.error(
    '\n❌ 拖动排序持久化自检失败：顺序在「前端显示 / 索引 / md 落盘」之间漂移，或重载后被覆盖。',
  )
  process.exit(1)
}
console.log('✅ 单文件夹内拖拽完全精确；三层（显示顺序 / 索引 order / md order）一致；')
console.log('   重启与 rebuildIndex 后顺序不变。')
console.log('ℹ️  已知缺口（需 db 侧入口，已发消息给 data）：跨文件夹的「全部笔记」视图里，')
console.log('   `notesRepo.move` 只能在笔记所属文件夹的子集内重排，无法表达"拖到全局第 k 位"；')
console.log('   各文件夹各自重排成 0..m-1 的重叠值，合并后整块可能移位、独自占一个文件夹的笔记恒不动。')
process.exit(0)
