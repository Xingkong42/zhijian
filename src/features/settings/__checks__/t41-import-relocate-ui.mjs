#!/usr/bin/env node
/**
 * 纸笺 · 设置面板「导入笔记（md）」+「更换数据目录」接线自检（t41）
 * ============================================================================
 * 运行：node src/features/settings/__checks__/t41-import-relocate-ui.mjs   （0 = 全绿）
 *
 * 为什么单独一套：这两个入口最容易出现**静默失效**——
 *  - 目录对话框忘了 `recursive: true` ⇒ 只授权顶层，子目录里的 md 读不到，
 *    界面不报错，只表现为"这个文件夹里没有可导入的 md"；
 *  - 换目录没有二次确认 / 没有进行中状态 ⇒ 用户重复点击，做两次数据搬迁；
 *  - Toast 不写旧目录位置 ⇒ 用户不知道数据还在哪。
 * 因此断言分两层：
 *  A. **静态（源码形态）**：目录对话框选项必须带 `recursive: true`、
 *     入口按钮存在且带 disabled、二次确认块存在、进度文案存在；
 *  B. **运行时（依赖注入）**：真的调一遍两条流程（真实临时 vault + 真实 db 层），
 *     断言传给 `open()` 的选项、二次确认的调用与文案、以及 Toast 要用的 summary。
 */

import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const settingsDir = path.resolve(here, '..')
const repoRoot = path.resolve(here, '..', '..', '..', '..')

// 只需要 db 层的 loader：它提供 `@/…` 别名、`@tauri-apps/plugin-sql` 替身与
// `@/lib/tauri` 替身（isTauri=true）。`vaultData.ts` 对 tauri 插件全部是**动态** import，
// 而本自检对 `open/confirm` 一律**依赖注入**，所以不需要 dialog/fs 替身。
register(pathToFileURL(path.join(repoRoot, 'src/db/__checks__/loader.mjs')).href)

const vaultData = await import('../vaultData.ts')
const db = await import('@/db')
const { notesRepo } = await import('@/db/notes')
const { nodeFsPort, makeTempDir, removeDir } = await import(
  pathToFileURL(path.join(repoRoot, 'src/db/__checks__/node-fs-port.mjs')).href
)

const results = []
let currentGroup = '(未分组)'
const group = (title) => {
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

const panelSource = readFileSync(path.join(settingsDir, 'SettingsPanel.tsx'), 'utf8')
const vaultDataSource = readFileSync(path.join(settingsDir, 'vaultData.ts'), 'utf8')

console.log('设置面板接线自检（t41）：导入笔记 + 更换数据目录')
console.log(`项目根：${repoRoot}`)

/* ==================== A. 静态：对话框选项与入口形态 ==================== */

group('A 静态断言（源码形态）')

await check('目录对话框选项必须带 recursive: true（否则子目录 md 读不到）', () => {
  assertEqual(vaultData.IMPORT_FOLDER_DIALOG_OPTIONS, { directory: true, recursive: true }, '导入文件夹选项')
  assertEqual(vaultData.RELOCATE_DIALOG_OPTIONS, { directory: true, recursive: true }, '更换目录选项')
  assertEqual(vaultData.IMPORT_FILE_DIALOG_OPTIONS.multiple, true, '导入文件应多选')
  assertEqual(vaultData.IMPORT_FILE_DIALOG_OPTIONS.filters[0].extensions, ['md'], '应只过滤 md')
  // 源码层面再兜一层：两个目录调用点附近都出现 recursive: true
  const dirOpenCount = (vaultDataSource.match(/recursive: true/g) ?? []).length
  assert(dirOpenCount >= 2, `vaultData.ts 里应至少有两处 recursive: true（文件夹导入 + 更换目录），实际 ${dirOpenCount}`)
})

await check('t44：导入入口已搬到侧栏「全部笔记」下方，设置面板不再保留它', () => {
  // 需求（用户原话）：「把导入 md 文件的功能挪到全部笔记的下方」。
  // 因此断言**两侧都查**：既查新家接上了，也查旧家确实搬空了
  // —— 只查新家的话，"设置里还留着一份"这种半搬状态会被放过。
  const sidebar = readFileSync(path.join(repoRoot, 'src/features/sidebar/Sidebar.tsx'), 'utf8')
  const app = readFileSync(path.join(repoRoot, 'src/App.tsx'), 'utf8')
  assert(!panelSource.includes('handleImportNotes('), '设置面板里仍留有 handleImportNotes（旧入口没搬干净）')
  assert(!panelSource.includes('importNotesFromDialog('), '设置面板里仍在直接调用导入流程（旧入口没搬干净）')
  assert(!panelSource.includes("'导入 md 文件…'"), '设置面板里仍留有「导入 md 文件…」按钮文案')
  assert(!panelSource.includes("'导入文件夹…'"), '设置面板里仍留有「导入文件夹…」按钮文案')

  assert(sidebar.includes("onImportNotes('files')"), '缺少「导入 md 文件…」入口')
  assert(sidebar.includes("onImportNotes('folder')"), '缺少「导入文件夹…」入口')
  assert(sidebar.includes('disabled={importing !== null}'), '导入入口缺少 disabled（防重复点击）')
  assert(sidebar.includes("'正在导入…'"), '缺少「正在导入…」文案')
  // 入口必须紧跟在主导航行之后（"全部笔记的下方"），而不是被塞到侧栏别处
  const allRow = sidebar.indexOf('label="全部笔记"')
  const importRow = sidebar.indexOf("onImportNotes('files')")
  const folderGroup = sidebar.indexOf('label="文件夹"')
  assert(allRow >= 0 && importRow > allRow, '导入入口必须排在「全部笔记」行之后')
  assert(folderGroup > importRow, '导入入口应在「文件夹」分组之前（紧邻主导航，而不是埋进分组里）')

  assert(app.includes('importNotesFromDialog(source)'), '集成层没有调用真实导入流程（会成为假入口）')
  assert(
    app.includes('onImportNotes={handleImportNotes}') && app.includes('importing={importing}'),
    '集成层没有把导入入口的接线传给侧栏',
  )
  assert(app.includes("if (!isTauri)"), '集成层缺少浏览器预览下的明确提示（不得静默无反应）')
})

await check('更换数据目录入口仍在设置面板、带二次确认与进行中文案', () => {
  assert(panelSource.includes('data-zj="relocate-entry"'), '缺少「更换数据目录…」入口标记')
  assert(
    panelSource.includes('disabled={!relocateEnabled || dataBusy !== null || !isTauri}'),
    '更换目录按钮缺少 disabled（防重复搬迁）',
  )
  assert(panelSource.includes("'正在搬迁…'"), '缺少「正在搬迁…」文案')
  assert(panelSource.includes('data-zj="vault-op-progress"'), '缺少进行中状态提示块')
})

await check('更换数据目录必须有二次确认块（操作前告知旧目录）', () => {
  assert(panelSource.includes('data-zj="relocate-confirm"'), '缺少二次确认块')
  assert(panelSource.includes('role="alertdialog"'), '二次确认块应是 alertdialog 语义')
  assert(panelSource.includes('relocateConfirmMessage(vault?.vaultRoot'), '二次确认里必须展示当前（旧）数据目录')
  assert(panelSource.includes('setConfirmRelocate(true)'), '入口应先开确认，不能直接搬迁')
  const confirmIndex = panelSource.indexOf('data-zj="relocate-confirm"')
  const invokeIndex = panelSource.indexOf('void handleRelocateVault()')
  assert(confirmIndex > 0 && invokeIndex > confirmIndex, '搬迁调用必须出现在二次确认块内部（确认之后）')
})

/* ==================== B. 运行时：两条流程真实走一遍 ==================== */

group('B 运行时（真实临时 vault + 注入对话框）')

const runRoot = await makeTempDir('zhijian-settings-t41-')
const vaultRoot = path.join(runRoot, 'Documents', '纸笺')
const appDataDir = path.join(runRoot, 'AppData')
await nodeFsPort.mkdir(vaultRoot, { recursive: true })
await nodeFsPort.mkdir(appDataDir, { recursive: true })
db.configureStorage({
  fs: nodeFsPort,
  vaultRoot,
  appDataDir,
  legacyDbPath: path.join(appDataDir, 'zhijian.db'),
})
await db.initDb()

/** 记录 open() 的调用参数，用于断言"真的传了 recursive" */
function makeOpenSpy(value) {
  const calls = []
  return {
    calls,
    open: async (options) => {
      calls.push(options)
      return value
    },
  }
}

try {
  await check('导入（文件夹）：open 收到 recursive:true，summary 含成功数，笔记真的进 vault', async () => {
    const sourceDir = path.join(runRoot, '导入源')
    await nodeFsPort.mkdir(path.join(sourceDir, '子目录'), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path.join(sourceDir, '顶层.md'), '# 顶层导入\n\n正文\n', 'utf8')
    writeFileSync(path.join(sourceDir, '子目录', '深层.md'), '# 深层导入\n\n正文\n', 'utf8')

    const spy = makeOpenSpy(sourceDir)
    const outcome = await vaultData.importNotesFromDialog('folder', { open: spy.open })

    assertEqual(spy.calls.length, 1, '应只开一次对话框')
    assertEqual(spy.calls[0].recursive, true, '目录对话框必须带 recursive: true（否则子目录读不到）')
    assertEqual(spy.calls[0].directory, true, '应是目录对话框')
    assertEqual(outcome.status, 'imported', `应成功：${outcome.summary}`)
    assertEqual(outcome.imported, 2, `应导入 2 条（含子目录）：${outcome.summary}`)
    assert(outcome.summary.includes('成功 2 条'), `Toast 文案应含成功数：${outcome.summary}`)
    assert(outcome.summary.includes('新建文件夹'), `应报告保留子目录结构：${outcome.summary}`)
    assertEqual((await notesRepo.listAll()).length, 2, '笔记应真的落库')
  })

  await check('导入（文件多选）：open 收到 multiple+filters；取消时不报错、不写数据', async () => {
    const { writeFileSync } = await import('node:fs')
    const fileA = path.join(runRoot, 'a.md')
    const fileB = path.join(runRoot, 'b.md')
    writeFileSync(fileA, '# 文件 A\n\nA\n', 'utf8')
    writeFileSync(fileB, '# 文件 B\n\nB\n', 'utf8')

    const spy = makeOpenSpy([fileA, fileB])
    const outcome = await vaultData.importNotesFromDialog('files', { open: spy.open })
    assertEqual(spy.calls[0].multiple, true, '应多选')
    assertEqual(spy.calls[0].filters[0].extensions, ['md'], '应过滤 md')
    assertEqual(outcome.imported, 2, `应导入 2 条：${outcome.summary}`)
    assert(outcome.summary.includes('成功 2 条'), `Toast 应含成功数：${outcome.summary}`)

    const before = (await notesRepo.listAll()).length
    const cancelled = await vaultData.importNotesFromDialog('files', { open: makeOpenSpy(null).open })
    assertEqual(cancelled.status, 'cancelled', '用户取消应返回 cancelled')
    assertEqual((await notesRepo.listAll()).length, before, '取消不得写入任何数据')
  })

  await check('导入失败（非 UTF-8 等）→ status/summary 可读且不打断界面', async () => {
    const outcome = await vaultData.importNotesFromDialog('files', {
      open: makeOpenSpy([path.join(runRoot, '不存在.md')]).open,
    })
    assertEqual(outcome.failed >= 1, true, `应计入失败：${JSON.stringify(outcome)}`)
    assert(outcome.summary.includes('失败'), `summary 应含失败数：${outcome.summary}`)
    assertEqual(outcome.problems.length >= 1, true, '应给出可读问题清单')
  })

  await check('更换数据目录：二次确认文案含旧目录 + 失败保留原数据（不确认则完全不搬迁）', async () => {
    const target = path.join(runRoot, '新数据目录')
    const currentRoot = db.getStorage().vaultRoot

    // ① 用户点「取消」→ 不搬迁
    const declined = await vaultData.relocateVaultFromDialog({
      currentRoot,
      open: makeOpenSpy(target).open,
      confirm: async () => false,
    })
    assertEqual(declined.status, 'cancelled', '取消确认应返回 cancelled')
    assertEqual(db.getStorage().vaultRoot, currentRoot, '未确认时存储根不得变化')
    assert(!(await nodeFsPort.exists(target)), '未确认时不得创建目标目录')

    // ② 文案：操作前就告知旧目录位置
    const message = vaultData.relocateConfirmMessage(currentRoot, target)
    assert(message.includes(currentRoot), `确认文案必须含旧目录：${message.slice(0, 80)}…`)
    assert(message.includes(target), '确认文案应含新目录')
    assert(message.includes('旧目录会'), '确认文案应说明旧目录保留')

    // ③ 同意 → 真搬迁：summary 必须含旧数据位置
    let confirmedMessage = ''
    const moved = await vaultData.relocateVaultFromDialog({
      currentRoot,
      open: makeOpenSpy(target).open,
      confirm: async (text) => {
        confirmedMessage = text
        return true
      },
    })
    assertEqual(moved.status, 'relocated', `应搬迁成功：${moved.reason ?? moved.summary}`)
    assert(confirmedMessage.includes(currentRoot), '确认时展示的文案应含旧目录（操作前告知）')
    assertEqual(db.getStorage().vaultRoot, target, '存储根应切到新目录')
    assertEqual(moved.oldDataKeptAt, currentRoot, '结果须给出旧数据位置')
    assert(moved.summary.includes('旧数据仍保留'), `Toast 文案必须含旧数据位置提示：${moved.summary}`)
    assert(moved.summary.includes(currentRoot), 'Toast 文案应含旧目录路径')
    assertEqual((await notesRepo.listAll()).length, 4, '搬迁后笔记应完好（2 文件夹导入 + 2 文件导入）')
  })

  await check('搬迁失败（目标在当前目录内部）→ summary 可读且原目录完好', async () => {
    const currentRoot = db.getStorage().vaultRoot
    const bad = path.join(currentRoot, '子目录')
    const failed = await vaultData.relocateVaultFromDialog({
      currentRoot,
      open: makeOpenSpy(bad).open,
      confirm: async () => true,
    })
    assertEqual(failed.status, 'failed', `应判定失败：${failed.summary}`)
    assert(failed.summary.includes('失败'), `summary 应说明失败：${failed.summary}`)
    assert(failed.summary.includes(currentRoot), '失败文案应告知原数据仍在原目录')
    assertEqual(db.getStorage().vaultRoot, currentRoot, '失败后存储根不得变化')
  })
} finally {
  await db.closeDb().catch(() => undefined)
  await removeDir(runRoot).catch(() => undefined)
}

const failed = results.filter((item) => !item.ok)
console.log('\n' + '─'.repeat(72))
for (const item of failed) console.log(`❌ [${item.group}] ${item.name}\n   ↳ ${item.error}`)
console.log(`t41 接线自检：总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
console.log(failed.length === 0 ? '✅ 导入笔记 / 更换数据目录接线全部通过' : '❌ 存在失败项')
process.exitCode = failed.length === 0 ? 0 : 1
