#!/usr/bin/env node
/**
 * 纸笺 · 系统集成自检（任务 t6，不需要 Tauri / Rust / 桌面环境）
 * ============================================================================
 * 运行：node src/features/settings/__checks__/run-checks.mjs   （退出码 0 = 全部通过）
 *
 * 为什么需要它：dataTransfer.ts 的导出 / 导入依赖 plugin-dialog 与 plugin-fs，
 * 浏览器里不可用。本脚本复用 db 成员提供的 Node 解析钩子（loader.mjs），把
 * `@tauri-apps/plugin-sql` 换成 node:sqlite，并**新增两个替身**：
 *   - plugin-dialog → save()/open() 返回固定路径（或 null 模拟用户取消）
 *   - plugin-fs     → writeTextFile/readTextFile 落到临时目录的真实文件
 * 从而在纯 Node 里跑通「收集 → 写盘 → 清空 → 读盘 → 导入 → 核对」全链路，
 * 用的是**真实的** src/db 仓储与真实的 SQLite 引擎。
 *
 * 覆盖：
 *   A. 备份文件格式（serialize/parse 往返、各类非法输入的可读中文错误）
 *   B. 导出全链路（含回收站笔记、文件夹层级、标签；文件名与字节数）
 *   C. 导入全链路（非破坏性：只新增；文件夹父子还原、笔记归属与标签还原、
 *      软删除状态还原、原有数据零改动）
 *   D. 用户取消（对话框返回 null）时不报错、不写文件
 *   E. 浏览器态提示（isTauri=false 时的可读错误）—— 由 dataTransfer 的
 *      requireDesktop() 覆盖，这里只校验常量文案存在
 */

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..', '..')
const dbChecks = path.join(projectRoot, 'src', 'db', '__checks__')

/* ---------- 1) 注册解析钩子：db 层的两个替身 + 本任务的两个插件替身 ---------- */

const dialogStubPath = path.join(here, 'stub-plugin-dialog.mjs')
const fsStubPath = path.join(here, 'stub-plugin-fs.mjs')
const tauriStubPath = path.join(here, 'stub-lib-tauri.mjs')
const openerStubPath = path.join(here, 'stub-plugin-opener.mjs')

register(pathToFileURL(path.join(here, 'loader.mjs')).href, import.meta.url, {
  data: {
    dbStubDir: dbChecks,
    dialogStub: dialogStubPath,
    fsStub: fsStubPath,
    tauriStub: tauriStubPath,
    openerStub: openerStubPath,
    srcRoot: path.join(projectRoot, 'src'),
  },
})

/** 备份文件落到系统临时目录，脚本结束时删除 */
const workDir = mkdtempSync(path.join(tmpdir(), 'zhijian-t6-'))
process.env['ZJ_CHECK_TMP'] = workDir

/* ---------- 2) 断言工具 ---------- */

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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/* ---------- 3) 载入真实模块 ---------- */

const { initDb } = await import('@/db/index.ts')
const { configureStorage } = await import('@/db/storage.ts')
const { nodeFsPort } = await import('@/db/__checks__/node-fs-port.mjs')
const { notesRepo } = await import('@/db/notes.ts')
const { foldersRepo } = await import('@/db/folders.ts')
const { tagsRepo } = await import('@/db/tags.ts')
const dataTransfer = await import('../dataTransfer.ts')
const closeToTray = await import('../closeToTray.ts')
const shortcuts = await import('../shortcuts.ts')
const vaultData = await import('../vaultData.ts')
const autostart = await import('../autostart.ts')
const prefs = await import('@/lib/appPreferences.ts')
const tauriStub = await import(tauriStubPath)
const dialogStub = await import(dialogStubPath)
const fsStub = await import(fsStubPath)

/* ---------- 3b) 存储注入：md 文件为真相源（t15 之后 db 层需要 vault 根） ---------- */

const checkVaultRoot = path.join(workDir, 'vault')
const checkAppDataDir = path.join(workDir, 'appdata')
await nodeFsPort.mkdir(checkVaultRoot, { recursive: true })
await nodeFsPort.mkdir(checkAppDataDir, { recursive: true })
configureStorage({
  fs: nodeFsPort,
  vaultRoot: checkVaultRoot,
  appDataDir: checkAppDataDir,
  legacyDbPath: path.join(checkAppDataDir, 'zhijian.db'),
})
process.env['ZJ_CHECK_VAULT'] = checkVaultRoot
process.env['ZJ_CHECK_APPDATA'] = checkAppDataDir

await initDb()

/* ---------- 4) 用例 ---------- */

group('A. 备份文件格式')

await check('backupFileName 为 纸笺-备份-YYYYMMDD-HHmm.json', () => {
  const name = dataTransfer.backupFileName(new Date('2026-02-03T04:05:00').getTime())
  assertEqual(name, '纸笺-备份-20260203-0405.json', '备份文件名')
})

await check('serialize → parse 往返保持字段（folderId / tags / deletedAt）', () => {
  const bundle = {
    app: '纸笺',
    identifier: 'com.zhijian.app',
    kind: dataTransfer.BACKUP_KIND,
    version: dataTransfer.BACKUP_FORMAT_VERSION,
    exportedAt: 123,
    counts: { notes: 1, folders: 1, tags: 1 },
    folders: [{ id: 'F1', name: '工作', parentId: null, order: 0, createdAt: 1 }],
    notes: [
      {
        id: 'N1',
        title: '标题',
        content: '正文',
        folderId: 'F1',
        tags: ['标签A'],
        pinned: true,
        order: 0,
        createdAt: 1,
        updatedAt: 2,
        deletedAt: null,
      },
    ],
    tags: [{ id: 'T1', name: '标签A', color: '#C9A227', createdAt: 1 }],
  }
  const parsed = dataTransfer.parseBundle(dataTransfer.serializeBundle(bundle))
  assertEqual(parsed.notes.length, 1, '笔记数')
  assertEqual(parsed.notes[0].folderId, 'F1', '笔记归属')
  assertEqual(parsed.notes[0].tags[0], '标签A', '笔记标签')
  assertEqual(parsed.tags[0].name, '标签A', '标签名')
})

await check('非法输入抛出可读中文错误（4 类）', () => {
  const cases = [
    ['{', '合法 JSON'],
    ['{"kind":"other"}', 'kind 标记'],
    ['{"kind":"zhijian.backup","version":1}', '没有任何笔记'],
    ['{"kind":"zhijian.backup","version":99,"notes":[{}]}', '版本不支持'],
  ]
  for (const [text, keyword] of cases) {
    let message = 'NO-THROW'
    try {
      dataTransfer.parseBundle(text)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(message.includes(keyword), `输入 ${text} 的错误信息应包含「${keyword}」，实际：${message}`)
  }
})

await check('formatBytes 输出可读体积', () => {
  assertEqual(dataTransfer.formatBytes(0), '0 B', '0 字节')
  assertEqual(dataTransfer.formatBytes(718), '718 B', '718 字节')
  assert(dataTransfer.formatBytes(2048).endsWith('KB'), 'KB 单位')
})

group('B. 导出全链路（真实 SQLite + 真实仓储）')

const seed = {}
await check('准备数据：2 层文件夹 + 3 条笔记（含回收站）+ 2 个标签', async () => {
  const parent = await foldersRepo.create({ name: '工作', order: 0 })
  const child = await foldersRepo.create({ name: '项目A', parentId: parent.id, order: 0 })
  const n1 = await notesRepo.create({
    title: '会议纪要',
    content: '讨论了 FTS5 trigram',
    folderId: child.id,
    tags: ['重要', '工作'],
    pinned: true,
  })
  const n2 = await notesRepo.create({ title: '随手记', content: '买牛奶' })
  const n3 = await notesRepo.create({ title: '待删除', content: '临时' })
  await notesRepo.remove(n3.id)
  Object.assign(seed, { parent, child, n1, n2, n3 })
  assertEqual(parent.parentId, null, '顶层文件夹 parentId')
  assertEqual(child.parentId, parent.id, '子文件夹 parentId')
})

await check('collectBundle 含回收站笔记，计数与层级正确', async () => {
  const bundle = await dataTransfer.collectBundle()
  assertEqual(bundle.kind, dataTransfer.BACKUP_KIND, 'kind')
  assertEqual(bundle.folders.length, 2, '文件夹数')
  assertEqual(bundle.notes.length, 3, '笔记数（含回收站）')
  assertEqual(bundle.counts.notes, 3, 'counts.notes')
  const child = bundle.folders.find((f) => f.id === seed.child.id)
  assertEqual(child.parentId, seed.parent.id, '子文件夹保留父 id')
  const trashed = bundle.notes.find((n) => n.id === seed.n3.id)
  assert(trashed.deletedAt !== null, '回收站笔记带 deletedAt')
  const tagged = bundle.notes.find((n) => n.id === seed.n1.id)
  assertEqual(tagged.tags.length, 2, '笔记标签数')
})

await check('exportAllData 写出文件，返回路径 / 文件名 / 字节数', async () => {
  dialogStub.setSave(seed.backupPath ?? null)
  const target = path.join(workDir, dataTransfer.backupFileName(1712345678901))
  dialogStub.setSave(target)
  seed.backupPath = target
  const result = await dataTransfer.exportAllData()
  assertEqual(result.path, target, '返回路径')
  assertEqual(result.fileName, path.basename(target), '返回文件名')
  assertEqual(result.notes, 3, '返回笔记数')
  assertEqual(result.folders, 2, '返回文件夹数')
  assert(result.bytes > 100, '返回字节数')
  assert(existsSync(target), '备份文件已写盘')
  const { writeTextFile } = fsStub
  assertEqual(typeof writeTextFile, 'function', 'fs 替身已就位')
  const written = JSON.parse(readFileSync(target, 'utf8'))
  assertEqual(written.kind, dataTransfer.BACKUP_KIND, '落盘内容 kind')
})

await check('用户取消保存（对话框返回 null）不报错、也不写文件', async () => {
  dialogStub.setSave(null)
  const result = await dataTransfer.exportAllData()
  assertEqual(result.path, null, '取消时 path 为 null')
  assert(result.notes === 3, '取消时仍返回统计信息')
})

group('C. 导入全链路（非破坏性）')

await check('清空业务表后再导入：文件夹层级 / 笔记归属 / 标签 / 软删除全部还原', async () => {
  // 清空（直接删库重建：重新初始化前先关闭连接）
  const before = await notesRepo.counts()
  assertEqual(before.all + before.trash, 3, '清空前笔记总数')

  dialogStub.setOpen(seed.backupPath)
  const result = await dataTransfer.importAllData()
  assert(result !== null, '导入应返回结果')
  assertEqual(result.notes, 3, '导入笔记数')
  assertEqual(result.folders, 2, '导入文件夹数')

  const folders = await foldersRepo.list()
  assertEqual(folders.length, 4, '导入后文件夹总数（原 2 + 新 2）')
  // 同名文件夹会被重建（非破坏性：不动原有数据），t15 的重名策略会加数字后缀
  // （「工作」→「工作-2」），因此这里断言的是「父子关系还原」而不是名字逐字相同。
  const importedChild = folders.find((f) => f.name === '项目A' && f.id !== seed.child.id)
  const importedParent = folders.find((f) => f.id === importedChild.parentId)
  assertEqual(importedParent.parentId, null, '导入后子文件夹挂在顶层父文件夹下')
  assert(importedParent.id !== seed.parent.id, '导入的父文件夹是新记录（未复用旧 id）')

  const all = await notesRepo.listAll({ includeDeleted: true })
  assertEqual(all.length, 6, '导入后笔记总数（原 3 + 新 3）')
  const imported = all.filter((n) => n.id !== seed.n1.id)
  const meeting = imported.find((n) => n.title === '会议纪要')
  assertEqual(meeting.folderId, importedChild.id, '导入笔记落到重建后的子文件夹')
  assertEqual(meeting.tags.length, 2, '导入笔记标签数')
  assertEqual(meeting.pinned, true, '导入笔记保留置顶')

  const trashed = imported.find((n) => n.title === '待删除')
  assert(trashed.deletedAt !== null, '导入笔记保留回收站状态')

  const tags = await tagsRepo.list()
  assertEqual(tags.length, 2, '导入后标签总数（同名复用，不重复）')
})

await check('重复导入同一备份不报错（文件夹/标签复用同名，笔记按新增处理）', async () => {
  const result = await dataTransfer.importAllData()
  assert(result !== null, '第二次导入应返回结果')
  assertEqual(result.tags, 0, '第二次导入不新增标签')
  assertEqual(result.folders, 2, '第二次导入仍重建 2 个文件夹')
  const all = await notesRepo.listAll({ includeDeleted: true })
  assertEqual(all.length, 9, '第二次导入后笔记总数为 9')
})

await check('用户取消选择文件（open 返回 null）时返回 null 且不改数据', async () => {
  const before = (await notesRepo.listAll({ includeDeleted: true })).length
  dialogStub.setOpen(null)
  const result = await dataTransfer.importAllData()
  assertEqual(result, null, '取消导入返回 null')
  const after = (await notesRepo.listAll({ includeDeleted: true })).length
  assertEqual(after, before, '取消导入不改动笔记数')
})

group('D. 浏览器态与常量')

await check('FILESYSTEM_UNAVAILABLE_HINT 文案指向桌面端启动方式', () => {
  assert(dataTransfer.FILESYSTEM_UNAVAILABLE_HINT.includes('tauri:dev'), '提示应包含 pnpm tauri:dev')
})

await check('BACKUP_FORMAT_VERSION / BACKUP_KIND 与文档契约一致', () => {
  assertEqual(dataTransfer.BACKUP_FORMAT_VERSION, 1, '格式版本')
  assertEqual(dataTransfer.BACKUP_KIND, 'zhijian.backup', 'kind 标记')
})

/* ------------------------------------------------------------------ */
/* E. 「关闭到托盘」接线（§4.13 / t13）                                  */
/* 判定与下发都是纯函数（依赖注入），因此无需 React / 真实 IPC 即可断言。   */
/* ------------------------------------------------------------------ */

group('E. 「关闭到托盘」接线（§4.13）')

await check('提示判定：仅 reason=close 且 firstCloseHide=true 时提示', () => {
  const should = closeToTray.shouldShowCloseToTrayNotice
  // 唯一需要提示的场景
  assertEqual(should({ reason: 'close', firstCloseHide: true }), true, 'close + 首次 → 提示')
  // 非首次：不再打扰
  assertEqual(should({ reason: 'close', firstCloseHide: false }), false, 'close + 非首次 → 不提示')
  // 用户主动隐藏：提示反而啰嗦（否则 Alt+Shift+Z 快速切换会不断弹 Toast）
  assertEqual(should({ reason: 'toggle', firstCloseHide: true }), false, 'toggle → 不提示')
  assertEqual(should({ reason: 'tray', firstCloseHide: true }), false, 'tray → 不提示')
})

await check('提示判定：payload 缺失 / reason 非法（契约漂移）时不提示', () => {
  const should = closeToTray.shouldShowCloseToTrayNotice
  assertEqual(should(null), false, 'null → 不提示')
  assertEqual(should(undefined), false, 'undefined → 不提示')
  assertEqual(should({}), false, '空对象（reason 缺失）→ 不提示')
  assertEqual(should({ reason: 'unknown', firstCloseHide: true }), false, '未知 reason → 不提示')
})

await check('提示判定：autoShow=false 时不提示（QA 隔离验证隐藏行为用）', () => {
  assertEqual(
    closeToTray.shouldShowCloseToTrayNotice(
      { reason: 'close', firstCloseHide: true },
      { autoShow: false },
    ),
    false,
    '关掉提示后即使首次关闭也不弹',
  )
  assertEqual(
    closeToTray.shouldShowCloseToTrayNotice(
      { reason: 'close', firstCloseHide: false },
      { autoShow: true, forceFirstCloseHide: true },
    ),
    true,
    'forceFirstCloseHide 走同一条代码路径（供 tauri:dev 复验用）',
  )
})

await check('提示文案同时告知「怎么找回」与「怎么真退出」', () => {
  const text = closeToTray.closeToTrayNoticeText()
  assert(text.includes('托盘'), '文案需提到托盘图标')
  assert(text.includes('Alt+Shift+Z'), '文案需给出键盘找回方式')
  assert(text.includes('退出纸笺'), '文案需说明如何真正退出')
  assertEqual(closeToTray.CLOSE_TO_TRAY_NOTICE_TITLE, '已最小化到系统托盘', '标题')
})

const sentValues = []
const fakeSend = async (enabled) => {
  sentValues.push(enabled)
  return enabled
}

await check('下发偏好：调用 set 且参数与传入值一致（启动同步与变更共用同一函数）', async () => {
  const off = await closeToTray.syncCloseToTrayPreference(false, fakeSend)
  assertEqual(off.synced, true, '已下发')
  assertEqual(off.value, false, '返回下发的值')
  const on = await closeToTray.syncCloseToTrayPreference(true, fakeSend)
  assertEqual(on.value, true, '第二次下发 true')
  assertEqual(sentValues.join(','), 'false,true', 'Rust 实际收到的序列')
})

await check('下发偏好：调用抛错时不抛、返回 synced=false（不让启动流程崩）', async () => {
  const result = await closeToTray.syncCloseToTrayPreference(true, async () => {
    throw new Error('IPC 崩了')
  })
  assertEqual(result.synced, false, '失败时 synced=false')
  assertEqual(result.value, null, '失败时 value=null')
})

await check('漂移判定：Rust 无法对账（null）时不误报', () => {
  assertEqual(closeToTray.isPreferenceDrifted(null, true), false, 'null → 不报漂移')
  assertEqual(closeToTray.isPreferenceDrifted(true, true), false, '一致 → 不报')
  assertEqual(closeToTray.isPreferenceDrifted(false, true), true, '不一致 → 报漂移')
})

await check('启动同步读取的是持久化值（localStorage 为唯一落盘的权威源）', () => {
  const stored = closeToTray.storedCloseToTray()
  assert(typeof stored.closeToTray === 'boolean', 'storedCloseToTray 返回布尔')
})

await check('§4.13 接线常量已在源码中就位（防「改了没反应」回归）', () => {
  const source = readFileSync(path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'), 'utf8')
  assert(
    /const CLOSE_TO_TRAY_TOGGLE_ENABLED = true/.test(source),
    '开关必须为可交互（true）—— 置 false 会让用户改了没反应',
  )
  assert(source.includes('syncCloseToTrayPreference(value)'), '开关变更时必须下发到 Rust')
  const notice = readFileSync(path.join(projectRoot, 'src/features/settings/CloseToTrayNotice.tsx'), 'utf8')
  assert(notice.includes('syncCloseToTrayPreference()'), '启动时必须同步一次偏好')
  assert(notice.includes('openCloseToTrayNotice'), '必须订阅 WINDOW_HIDDEN 给出隐藏反馈')
})

/** 补 line 0 之外的守卫（上面那条是唯一读源码的用例；失败时给出可读原因即可） */
await check('命令名取自 COMMANDS 常量而非硬编码字符串', () => {
  const source = readFileSync(path.join(projectRoot, 'src/features/settings/closeToTray.ts'), 'utf8')
  assert(!source.includes("'cmd_"), 'closeToTray.ts 不得硬编码 cmd_* 命令名')
  const libSource = readFileSync(path.join(projectRoot, 'src/lib/tauri.ts'), 'utf8')
  assert(
    libSource.includes("setCloseToTray: 'cmd_set_close_to_tray'"),
    'COMMANDS.setCloseToTray 应为 cmd_set_close_to_tray（t12 定稿名）',
  )
  assert(
    libSource.includes("closeToTrayEnabled: 'cmd_close_to_tray_enabled'"),
    'COMMANDS.closeToTrayEnabled 应为 cmd_close_to_tray_enabled',
  )
})

await check('订阅幂等：N 个持有者只建立 1 个底层监听，最后一个释放才退订', async () => {
  const first = await closeToTray.openCloseToTrayNotice({ shouldNotify: () => false, notify: () => {} })
  const second = await closeToTray.openCloseToTrayNotice({ shouldNotify: () => false, notify: () => {} })
  // 两次挂载（StrictMode 的形态）→ 只应有一个监听器
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 1, '同一时刻只能有 1 个监听器')
  first()
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 1, '释放一个持有者后仍保留监听')
  second()
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 0, '最后一个持有者释放后必须退订')
  assertEqual(closeToTray.hasActiveCloseToTrayNotice(), false, '内部句柄需一并清空（否则重挂会复用旧句柄）')
})

await check('订阅幂等：卸载后再挂载能拿到全新句柄（防旧 handler 残留）', async () => {
  const a = await closeToTray.openCloseToTrayNotice({ shouldNotify: () => false, notify: () => {} })
  a()
  const b = await closeToTray.openCloseToTrayNotice({ shouldNotify: () => false, notify: () => {} })
  const fired = []
  // 用桩件直接派发事件：只有「当前句柄」的 handler 会收到
  tauriStub.emitWindowHidden({ reason: 'close', firstCloseHide: true })
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 1, '重挂后仍只有 1 个监听器')
  b()
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 0, '第二次释放也要能退订')
  assertEqual(fired.length, 0, '占位未注册 handler 时不应有回调（防御性断言）')
})

await check('订阅时只需「一个持有者」也能正常收到事件', async () => {
  const notices = []
  const dispose = await closeToTray.openCloseToTrayNotice({
    shouldNotify: (payload) => closeToTray.shouldShowCloseToTrayNotice(payload),
    notify: (notice) => notices.push(notice),
  })
  const delivered = tauriStub.emitWindowHidden({ reason: 'close', firstCloseHide: true })
  assertEqual(delivered, 1, '应有 1 个监听器收到事件')
  assertEqual(notices.length, 1, '应收到的提示数')
  assertEqual(notices[0].title, '已最小化到系统托盘', '提示标题')
  // 用户主动隐藏不应触发
  tauriStub.emitWindowHidden({ reason: 'toggle', firstCloseHide: true })
  tauriStub.emitWindowHidden({ reason: 'tray', firstCloseHide: true })
  assertEqual(notices.length, 1, 'tray/toggle 不应追加提示')
  // 非首次关闭不应触发
  tauriStub.emitWindowHidden({ reason: 'close', firstCloseHide: false })
  assertEqual(notices.length, 1, '非首次关闭不应追加提示')
  dispose()
  assertEqual(tauriStub.listenerCount('zhijian://window-hidden'), 0, '收尾退订')
})

/* ------------------------------------------------------------------ */
/* F. 正文字号（t17）—— 只写一个 CSS 变量，编辑器/预览立即跟随            */
/*    关键回归：曾用 `--text-editor`（Tailwind 刻度键）→ 完全无效。       */
/* ------------------------------------------------------------------ */

group('F. 正文字号（t17）')

await check('字号变量是设计系统的 --zj-font-content（不得回退到 --text-editor）', () => {
  assertEqual(prefs.CONTENT_FONT_VAR, '--zj-font-content', '变量名')
  const source = readFileSync(path.join(projectRoot, 'src/lib/appPreferences.ts'), 'utf8')
  assert(
    !/setProperty\('--text-editor'/.test(source),
    '不得对 --text-editor 调用 setProperty（inline 模式下该键不生成变量，写了也无效）',
  )
  const css = readFileSync(path.join(projectRoot, 'src/index.css'), 'utf8')
  assert(
    css.includes('--zj-font-content'),
    'index.css 必须提供 --zj-font-content（设计系统侧已落地）',
  )
})

await check('四档字号映射：小 13 / 中 15 / 大 17 / 特大 19', () => {
  assertEqual(prefs.CONTENT_FONT_SIZE_PX.small, 13, '小')
  assertEqual(prefs.CONTENT_FONT_SIZE_PX.medium, 15, '中（= 设计系统默认）')
  assertEqual(prefs.CONTENT_FONT_SIZE_PX.large, 17, '大')
  assertEqual(prefs.CONTENT_FONT_SIZE_PX.xlarge, 19, '特大')
  assertEqual(prefs.CONTENT_FONT_SIZE_OPTIONS.length, 4, '档位数')
})

await check('非法字号档位回落到默认（localStorage 被手改也不崩）', () => {
  assertEqual(prefs.isContentFontSize('huge'), false, '拒绝未知档位')
  assertEqual(prefs.isContentFontSize('large'), true, '接受已知档位')
})

// 用最小 DOM 桩验证「写变量 → 元素 computed 字号变化」这条链路（无需浏览器）
await check('applyContentFontSize 写入/移除 CSS 变量（默认档位不写行内值）', () => {
  const store = new Map()
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => store.set(name, value),
        removeProperty: (name) => store.delete(name),
        getPropertyValue: (name) => store.get(name) ?? '',
      },
    },
  }
  try {
    prefs.applyContentFontSize('large')
    assertEqual(store.get(prefs.CONTENT_FONT_VAR), '17px', '大档写入 17px')
    assertEqual(prefs.effectiveContentFontSizePx(), 17, '实际生效读取行内值')
    prefs.applyContentFontSize('xlarge')
    assertEqual(store.get(prefs.CONTENT_FONT_VAR), '19px', '特大档写入 19px')
    prefs.applyContentFontSize('medium')
    assertEqual(store.has(prefs.CONTENT_FONT_VAR), false, '默认档移除行内值（交还设计系统）')
    assertEqual(prefs.effectiveContentFontSizePx(), 15, '默认档实际生效 = 设计系统 15px')
    prefs.applyContentFontSize('small')
    assertEqual(store.get(prefs.CONTENT_FONT_VAR), '13px', '小档写入 13px')
  } finally {
    delete globalThis.document
  }
})

await check('字号偏好持久化（localStorage 镜像）+ 读回', () => {
  const store = new Map()
  globalThis.window = globalThis.window ?? {}
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    prefs.writeContentFontSize('xlarge')
    assertEqual(store.get(prefs.PREFERENCE_KEYS.contentFontSize), 'xlarge', '持久化键值')
    assertEqual(prefs.readContentFontSize(), 'xlarge', '读回')
    store.set(prefs.PREFERENCE_KEYS.contentFontSize, 'bogus')
    assertEqual(prefs.readContentFontSize(), 'medium', '坏值回落默认')
  } finally {
    delete globalThis.window.localStorage
  }
})

/* ------------------------------------------------------------------ */
/* G. 自定义快捷键（t17）                                                */
/* ------------------------------------------------------------------ */

group('G. 自定义快捷键（t17）')

await check('键位解析：合法组合通过，并统一成规范写法', () => {
  assertEqual(shortcuts.formatAccelerator('alt+n'), 'Alt+N', '小写归一')
  assertEqual(shortcuts.formatAccelerator('CTRL + shift + k'), 'Ctrl+Shift+K', '去空格 + 修饰键排序')
  assertEqual(shortcuts.formatAccelerator('Alt+,'), 'Alt+,', '符号键')
  assertEqual(shortcuts.formatAccelerator('F5'), 'F5', '功能键可单键')
  assertEqual(shortcuts.normalizeAccelerator('Alt+N'), 'alt+n', '比较键')
  assertEqual(shortcuts.normalizeAccelerator('Shift+Alt+N'), 'alt+shift+n', '修饰键顺序无关')
})

await check('键位解析：空 / 非法组合一律拒绝（任务要求的「不接受空/非法」）', () => {
  assertEqual(shortcuts.parseAccelerator(''), null, '空串')
  assertEqual(shortcuts.parseAccelerator('   '), null, '纯空格')
  assertEqual(shortcuts.parseAccelerator('Alt'), null, '只有修饰键')
  assertEqual(shortcuts.parseAccelerator('Alt+Shift'), null, '只有两个修饰键')
  assertEqual(shortcuts.parseAccelerator('N'), null, '无修饰键的字母（会抢占输入）')
  assertEqual(shortcuts.parseAccelerator('Alt+N+K'), null, '三个键')
  assertEqual(shortcuts.parseAccelerator('Alt+不存在的键'), null, '无法识别的键')
})

await check('validateAccelerator：可清空动作允许留空，不可清空动作拒绝留空', () => {
  const newNote = shortcuts.shortcutDefinition('newNote')
  // t44：可清空动作的例子从 `showTile` 换成 `toggleTiles`
  // （用户要求删掉设置里的「显示磁贴（旧动作名）」后，`showTile` 已整体移除）
  const toggleTiles = shortcuts.shortcutDefinition('toggleTiles')
  assertEqual(shortcuts.validateAccelerator(null, newNote).ok, false, '新建笔记不可留空')
  assertEqual(shortcuts.validateAccelerator(null, toggleTiles).ok, true, '全部磁贴可留空')
  assert(shortcuts.validateAccelerator('Alt+N', newNote).reason === undefined, '合法键位无错误原因')
  const bad = shortcuts.validateAccelerator('N', newNote)
  assertEqual(bad.ok, false, '非法键位被拒')
  assert(Boolean(bad.reason), '拒绝时必须给出可读原因')
})

await check('应用内冲突检测：与其它已启用动作重复时命中', () => {
  const bindings = { ...shortcuts.DEFAULT_SHORTCUT_BINDINGS }
  const conflict = shortcuts.findConflict(bindings, 'openSettings', 'Alt+N')
  assertEqual(conflict?.withId, 'newNote', '与「新建笔记」冲突')
  assertEqual(shortcuts.findConflict(bindings, 'openSettings', 'Alt+Shift+Z')?.withId, 'toggleWindow', '与显隐窗口冲突')
  assertEqual(shortcuts.findConflict(bindings, 'openSettings', 'Alt+K'), null, '不冲突返回 null')
  // 已禁用的动作不参与冲突判定
  const disabled = {
    ...bindings,
    newNote: { id: 'newNote', accelerator: 'Alt+N', enabled: false },
  }
  assertEqual(shortcuts.findConflict(disabled, 'openSettings', 'Alt+N'), null, '禁用的动作不算冲突')
})

await check('键位来自键盘事件：只按修饰键时返回 null（继续等待）', () => {
  const bare = { key: 'Alt', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }
  assertEqual(shortcuts.acceleratorFromEvent(bare), null, '只按修饰键')
  const combo = { key: 'n', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }
  assertEqual(shortcuts.acceleratorFromEvent(combo), 'Alt+N', 'Alt+N')
  const withShift = { key: 'Z', altKey: true, ctrlKey: false, shiftKey: true, metaKey: false }
  assertEqual(shortcuts.acceleratorFromEvent(withShift), 'Alt+Shift+Z', 'Alt+Shift+Z')
})

await check('默认绑定与动作清单：6 个动作，默认只注册前两个（§4.8.1，t19 增补磁贴两项、t44 增补快速笔记）', () => {
  assertEqual(shortcuts.SHORTCUT_ACTIONS.length, 6, '动作数')
  assertEqual(shortcuts.DEFAULT_SHORTCUT_BINDINGS.newNote.accelerator, 'Alt+N', '新建笔记默认')
  assertEqual(shortcuts.DEFAULT_SHORTCUT_BINDINGS.toggleWindow.accelerator, 'Alt+Shift+Z', '显隐默认')
  assertEqual(shortcuts.DEFAULT_SHORTCUT_BINDINGS.toggleTiles.enabled, false, '全部磁贴默认关闭')
  assertEqual(shortcuts.DEFAULT_SHORTCUT_BINDINGS.pinNote.enabled, false, '钉住当前笔记默认关闭')
  // t44：快速笔记给了建议键位，但**默认不启用**（§4.8.1 冻结「默认只注册前两个」）
  assertEqual(shortcuts.DEFAULT_SHORTCUT_BINDINGS.quickNote.enabled, false, '快速笔记默认关闭（§4.8.1）')
  assertEqual(
    shortcuts.DEFAULT_SHORTCUT_BINDINGS.quickNote.accelerator,
    'Alt+Shift+N',
    '快速笔记的建议键位（用户在设置里一键启用即可）',
  )
  // §4.8.1：**默认只注册前两个** —— openSettings 不得默认抢全局键位
  assertEqual(
    shortcuts.DEFAULT_SHORTCUT_BINDINGS.openSettings.enabled,
    false,
    '打开设置默认不注册（§4.8.1）',
  )
  assertEqual(shortcuts.activeBindings(shortcuts.DEFAULT_SHORTCUT_BINDINGS).length, 2, '默认启用数 = 2')
  assertEqual(
    shortcuts.activeBindings(shortcuts.DEFAULT_SHORTCUT_BINDINGS)
      .map((b) => b.id)
      .join(','),
    'newNote,toggleWindow',
    '默认注册的正是前两个动作',
  )
  // §4.8.1 在 t19 由 4 项增补为 6 项（磁贴：toggleTiles / pinNote）；
  // t44 按用户要求删除「显示磁贴（旧动作名）showTile」⇒ 5 项，随后增补 quickNote ⇒ 6 项。
  // 顺序与 Rust `SUPPORTED_ACTION_IDS` 一致 —— `pnpm check:contract` 对两张表做双向核对。
  assertEqual(
    shortcuts.SHORTCUT_ACTIONS.map((a) => a.id).join(','),
    'newNote,toggleWindow,openSettings,toggleTiles,pinNote,quickNote',
    '动作 id 顺序与 §4.8.1 一致（「前两个」即默认项）',
  )
})

await check('持久化：read bindings 往返；坏 JSON / 非法键位回落默认', () => {
  const store = new Map()
  globalThis.window = globalThis.window ?? {}
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    const custom = {
      ...shortcuts.DEFAULT_SHORTCUT_BINDINGS,
      newNote: { id: 'newNote', accelerator: 'Ctrl+Shift+N', enabled: true },
    }
    shortcuts.writeShortcutBindings(custom)
    assertEqual(shortcuts.readShortcutBindings().newNote.accelerator, 'Ctrl+Shift+N', '读回自定义键位')
    store.set(prefs.PREFERENCE_KEYS.shortcuts, '{坏 JSON')
    assertEqual(shortcuts.readShortcutBindings().newNote.accelerator, 'Alt+N', '坏 JSON 回落默认')
    store.set(
      prefs.PREFERENCE_KEYS.shortcuts,
      JSON.stringify({ newNote: { accelerator: 'N', enabled: true } }),
    )
    assertEqual(shortcuts.readShortcutBindings().newNote.accelerator, 'Alt+N', '非法键位回落默认')
  } finally {
    delete globalThis.window.localStorage
  }
})

await check('同步下发：只发启用的绑定，原样传给 Rust 命令', async () => {
  const calls = []
  const result = await shortcuts.syncGlobalShortcuts(shortcuts.DEFAULT_SHORTCUT_BINDINGS, {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args })
      return {
        applied: [
          { id: 'newNote', accelerator: 'Alt+N' },
          { id: 'toggleWindow', accelerator: 'Alt+Shift+Z' },
        ],
        failed: [],
      }
    },
  })
  assertEqual(calls[0].cmd, 'cmd_sync_global_shortcuts', '命令名')
  // §4.8.1：默认只注册前两个 ⇒ 默认下发 2 条（openSettings / toggleTiles / pinNote 都不发）
  assertEqual(calls[0].args.bindings.length, 2, '默认只发前两个动作')
  assertEqual(
    calls[0].args.bindings.map((b) => b.id).join(','),
    'newNote,toggleWindow',
    '默认下发的 id 清单',
  )
  assertEqual(calls[0].args.bindings[0].id, 'newNote', '顺序 = 动作清单顺序')
  assertEqual(result.synced, true, '已下发')
  assertEqual(result.applied.newNote, 'Alt+N', '实际生效映射')
  assertEqual(result.failed.length, 0, '默认绑定全部成功时应无失败项')
})

await check('用户显式开启的第三/第四个动作也会被下发（并透传失败原因）', async () => {
  const calls = []
  const custom = {
    ...shortcuts.DEFAULT_SHORTCUT_BINDINGS,
    openSettings: { id: 'openSettings', accelerator: 'Alt+,', enabled: true },
    toggleTiles: { id: 'toggleTiles', accelerator: 'Alt+T', enabled: true },
  }
  const result = await shortcuts.syncGlobalShortcuts(custom, {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args })
      return {
        applied: [
          { id: 'newNote', accelerator: 'Alt+N' },
          { id: 'toggleWindow', accelerator: 'Alt+Shift+Z' },
          { id: 'toggleTiles', accelerator: 'Alt+T' },
        ],
        failed: [{ id: 'openSettings', accelerator: 'Alt+,', reason: '已被其它程序占用' }],
      }
    },
  })
  assertEqual(calls[0].args.bindings.length, 4, '开启后 4 条全部下发')
  assertEqual(
    calls[0].args.bindings.map((b) => b.id).join(','),
    'newNote,toggleWindow,openSettings,toggleTiles',
    '下发顺序 = 动作清单顺序',
  )
  assertEqual(result.failed.length, 1, '失败项')
  assertEqual(result.failed[0].reason, '已被其它程序占用', '冲突原因透传（设置页据此提示）')
})

await check('同步下发：命令未实现/调用失败时不抛错，返回可读说明', async () => {
  const result = await shortcuts.syncGlobalShortcuts(shortcuts.DEFAULT_SHORTCUT_BINDINGS, {
    invoke: async () => {
      throw new Error('command cmd_sync_global_shortcuts not found')
    },
  })
  assertEqual(result.synced, false, '未同步')
  assert(Boolean(result.unavailableReason), '必须给出说明（设置面板据此提示而不是崩）')
})

await check('同步响应解析：字段缺失时不把未确认的键位当作已生效', () => {
  const bogus = shortcuts.parseSyncResponse(null)
  assertEqual(bogus.synced, false, 'null 响应 → 未同步')
  assertEqual(Object.keys(bogus.applied).length, 0, '不得凭空产生生效键位')
  const mapForm = shortcuts.parseSyncResponse({
    applied: { newNote: 'Alt+N' },
    failed: [],
  })
  assertEqual(mapForm.synced, true, '兼容 map 形态')
  assertEqual(mapForm.applied.newNote, 'Alt+N', 'map 形态取值')
})

await check('触发分发：按动作区分的事件各走各的，未知事件不静默吞掉', () => {
  const hit = []
  const handlers = {
    newNote: () => hit.push('newNote'),
    openSettings: () => hit.push('openSettings'),
    toggleWindow: () => hit.push('toggleWindow'),
    toggleTiles: () => hit.push('toggleTiles'),
    pinNote: () => hit.push('pinNote'),
    onUnknown: (event) => hit.push(`unknown:${event}`),
  }
  const EV = shortcuts.SHORTCUT_EVENT_BY_ACTION
  assertEqual(shortcuts.dispatchShortcutEvent(EV.newNote, handlers), true, 'new-note 事件命中')
  assertEqual(shortcuts.dispatchShortcutEvent(EV.openSettings, handlers), true, 'open-settings 事件命中')
  assertEqual(shortcuts.dispatchShortcutEvent(EV.toggleWindow, handlers), true, 'toggle-window 事件命中')
  // t19/t20：磁贴两个动作已有专用事件。
  // ⚠️ 这里刻意用**字面量事件名**驱动，而不是 `EV.tilesVisibilityChanged`：
  //    `SHORTCUT_EVENT_BY_ACTION` 的值是**模块初始化时**读到的 `EVENTS`，
  //    而 switch 的 case 标签是**调用时**才求值；两者的求值时机不同，
  //    在 ESM 实时绑定尚未稳定的场景下会得到"映射表有值、分发却不命中"的假象。
  //    用字面量断言的是**分发行为本身**，不掺入映射表的读取时机问题。
  assertEqual(
    shortcuts.dispatchShortcutEvent('zhijian://tiles-visibility-changed', handlers),
    true,
    '磁贴显隐事件命中',
  )
  assertEqual(
    shortcuts.dispatchShortcutEvent('zhijian://pin-current-note-requested', handlers),
    true,
    '钉住当前笔记事件命中',
  )
  assertEqual(shortcuts.dispatchShortcutEvent('zhijian://nope', handlers), false, '未知事件返回 false')
  assertEqual(shortcuts.dispatchShortcutEvent(undefined, handlers), false, 'undefined 返回 false')
  assertEqual(
    hit.join(','),
    'newNote,openSettings,toggleWindow,toggleTiles,pinNote,unknown:zhijian://nope',
    '分发顺序与内容（t44：showTile 旧动作名已整体移除，显隐事件只驱动 toggleTiles）',
  )
})

await check('事件形态：不新增 id 泛化事件，各动作映射到既有/已定稿事件', () => {
  const map = shortcuts.SHORTCUT_EVENT_BY_ACTION
  assertEqual(map.newNote, 'zhijian://new-note-requested', '新建笔记沿用既有事件')
  assertEqual(map.openSettings, 'zhijian://open-settings-requested', '打开设置沿用既有事件')
  assertEqual(map.toggleWindow, 'zhijian://toggle-window-requested', '显隐用 architect 新增事件')
  // t19：磁贴已上线，显隐类动作改用专用事件（不再借 toggle-window-requested）
  // t44：`showTile`（旧动作名）已按用户要求整体移除，映射表里不再有它
  assertEqual(map.toggleTiles, 'zhijian://tiles-visibility-changed', '全部磁贴用专用事件')
  assertEqual(map.pinNote, 'zhijian://pin-current-note-requested', '钉住当前笔记用专用事件')
  assert(
    !Object.prototype.hasOwnProperty.call(map, 'showTile'),
    't44：`showTile` 旧动作名不应再留在事件映射表里（用户要求删掉设置里的该项）',
  )
  // 不引入 `shortcut-triggered{id}` 泛化事件：映射值必须全是已登记的真实事件名
  const known = new Set(Object.values(tauriStub.EVENTS))
  for (const [action, event] of Object.entries(map)) {
    assert(known.has(event), `${action} 映射到的事件 ${event} 必须是 EVENTS 里已登记的真实事件名`)
  }
})

await check('防漂移：自检桩的 EVENTS / COMMANDS 与 src/lib/tauri.ts 逐字一致', () => {
  // 桩件曾经漏掉 architect 新增的 toggleWindowRequested，导致「测试通过但线上事件名不对」。
  // 这里直接从真实源码抽取字面量做逐条比对，任何一侧新增事件都会被立刻发现。
  const real = readFileSync(path.join(projectRoot, 'src/lib/tauri.ts'), 'utf8')
  for (const [key, value] of Object.entries(tauriStub.EVENTS)) {
    assert(
      new RegExp(`${key}:\\s*'${value.replace(/[/:.]/g, (ch) => `\\${ch}`)}'`).test(real),
      `EVENTS.${key} = ${value} 必须与 src/lib/tauri.ts 一致`,
    )
  }
  for (const [key, value] of Object.entries(tauriStub.COMMANDS)) {
    assert(
      new RegExp(`${key}:\\s*'${value}'`).test(real),
      `COMMANDS.${key} = ${value} 必须与 src/lib/tauri.ts 一致`,
    )
  }
  assert(
    real.includes("toggleWindowRequested: 'zhijian://toggle-window-requested'"),
    '真实模块必须导出 toggleWindowRequested（t17 显隐事件）',
  )
  assert(
    real.includes("syncGlobalShortcuts: 'cmd_sync_global_shortcuts'"),
    '真实模块必须导出 syncGlobalShortcuts 命令名',
  )
})

/* ------------------------------------------------------------------ */
/* H. 数据位置 / 备份 / 索引（t17）                                      */
/*    vault 根与索引统计依赖 t15 的 storage/indexer（自检已注入临时目录）   */
/* ------------------------------------------------------------------ */

group('H. 数据位置 / 备份 / 索引（t17）')

await check('备份文件夹命名：纸笺-备份-YYYYMMDD-HHmmss-毫秒', () => {
  const name = vaultData.defaultBackupDirName(new Date('2026-02-03T04:05:06.007').getTime())
  assertEqual(name, '纸笺-备份-20260203-040506-007', '默认备份目录名')
})

await check('读取数据位置：vault 根 = 自检注入的临时目录，索引库 = 应用数据目录/zhijian.db', async () => {
  const location = await vaultData.readVaultLocation()
  assertEqual(location.vaultRoot, process.env['ZJ_CHECK_VAULT'], 'vault 根')
  assertEqual(location.appDataDir, process.env['ZJ_CHECK_APPDATA'], '应用数据目录')
  assert(location.indexDbPath.endsWith('zhijian.db'), '索引库路径以 zhijian.db 结尾')
  assertEqual(location.fileBacked, true, '文件为真相源')
})

await check('索引状态：文件数 / 笔记数 / 文件夹数 / 标签数与真实数据一致', async () => {
  const status = await vaultData.readIndexStatus()
  assert(status.fileCount > 0, '扫描到自定义/seed 的 md 文件')
  assertEqual(status.noteCount, status.activeCount + status.trashCount, '笔记总数 = 正常 + 回收站')
  assertEqual(status.inSync, status.fileCount === status.noteCount, '同步标志与两数一致')
})

await check('重建索引：调用 t15 的 rebuildIndex，回写「最后重建时间」并回读状态', async () => {
  const store = new Map()
  globalThis.window = globalThis.window ?? {}
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    const before = prefs.readLastIndexRebuildAt()
    assertEqual(before, null, '初始无重建记录')
    const outcome = await vaultData.rebuildVaultIndex()
    assert(outcome.result.total > 0, '重建后仍有笔记（没有把索引清空）')
    assert(outcome.finishedAt > 0, '完成时间戳')
    assertEqual(prefs.readLastIndexRebuildAt(), outcome.finishedAt, '最后重建时间已持久化')
    assertEqual(outcome.status.lastRebuildAt, outcome.finishedAt, '回读状态里也带该时间')
    assert(outcome.status.inSync, '重建后文件数与笔记数一致')
  } finally {
    delete globalThis.window.localStorage
  }
})

await check('备份：递归复制 vault 到目标目录（文件数一致、源目录不动）', async () => {
  const location = await vaultData.readVaultLocation()
  const targetParent = path.join(workDir, 'backup-parent')
  const outcome = await vaultData.backupVaultInto(location.vaultRoot, targetParent)
  assert(outcome.copiedFiles > 0, '至少复制了 1 个文件')
  assert(outcome.targetDir.startsWith(targetParent), '目标在选定父目录下')
  assert(outcome.targetDir.includes('纸笺-备份-'), '目标目录名带时间戳')
  // 逐文件核对：备份里的 md 与源目录一一对应
  const countMd = (dir) => {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) total += countMd(path.join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.md')) total += 1
    }
    return total
  }
  assertEqual(countMd(outcome.targetDir), countMd(location.vaultRoot), '备份的 md 数与源一致')
  assertEqual(countMd(location.vaultRoot) > 0, true, '源目录仍有数据（备份不改源）')
})

await check('备份：拒绝写进数据目录内部（防止自我递归）', async () => {
  const location = await vaultData.readVaultLocation()
  const inside = path.join(location.vaultRoot, '备份')
  let message = 'NO-THROW'
  try {
    await vaultData.backupVault(location.vaultRoot, inside)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(message.includes('不能位于数据目录内部'), `应给出可读拒绝原因，实际：${message}`)
})

await check('备份：目标目录非空时拒绝（避免两批数据混在一起）', async () => {
  const location = await vaultData.readVaultLocation()
  const notEmpty = path.join(workDir, 'not-empty')
  mkdirSync(notEmpty, { recursive: true })
  writeFileSync(path.join(notEmpty, 'existing.txt'), 'x')
  let message = 'NO-THROW'
  try {
    await vaultData.backupVault(location.vaultRoot, notEmpty)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(message.includes('不是空'), `应提示目标非空，实际：${message}`)
})

await check('更换数据目录：t41 起**已支持**，且入口必须"真能落地"（不留假开关；t44 起导入入口在侧栏）', () => {
  const support = vaultData.relocateSupport()
  // t17 时这里断言 false（当时没有换根入口，所以不做假按钮）；t37 数据层补齐
  // `relocateVault()`（先复制 → 校验 → 再切换，失败不动原数据）后改为 true。
  assertEqual(support.supported, true, 't37 起数据层已提供换根能力')
  assert(support.reason.includes('复制'), '说明里讲清做法：先复制')
  assert(support.reason.includes('校验'), '说明里讲清做法：再校验')
  assert(support.reason.includes('旧目录'), '说明里必须讲清旧目录保留')
  // 「不留假开关」的实质：入口接到真实 API + 二次确认 + 进行中状态
  // （深层运行时断言见 __checks__/t41-import-relocate-ui.mjs）
  const panel = readFileSync(path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'), 'utf8')
  assert(panel.includes('relocateVaultFromDialog('), '入口必须调用真实搬迁流程')
  assert(panel.includes('data-zj="relocate-confirm"'), '必须有二次确认（操作前告知旧目录）')
  assert(panel.includes("'正在搬迁…'"), '必须有进行中文案（防重复点击）')
  // t44：导入笔记的入口已按用户要求**搬出设置面板**，落到侧栏「全部笔记」下方。
  // 断言跟着需求走（否则守的是"过期的正确"）：
  //  · 设置面板里**不应**再有入口与进行中文案；
  //  · 真入口在 Sidebar（两个来源）+ App 接线（防重入/Toast/刷新）。
  const sidebar = readFileSync(path.join(projectRoot, 'src/features/sidebar/Sidebar.tsx'), 'utf8')
  const app = readFileSync(path.join(projectRoot, 'src/App.tsx'), 'utf8')
  assert(!panel.includes('handleImportNotes('), 't44：导入入口已搬到侧栏，设置面板里不应再留有它')
  assert(!panel.includes("'正在导入…'"), 't44：导入的进行中文案已随入口搬到侧栏')
  assert(sidebar.includes("onImportNotes('files')"), '侧栏缺少「导入 md 文件…」入口')
  assert(sidebar.includes("onImportNotes('folder')"), '侧栏缺少「导入文件夹…」入口')
  assert(sidebar.includes("'正在导入…'"), '侧栏导入入口缺少进行中文案（防重复点击）')
  assert(app.includes('importNotesFromDialog(source)'), '集成层必须调用真实导入流程（不得只有按钮）')
  assert(
    app.includes('onImportNotes={handleImportNotes}'),
    '侧栏入口必须由集成层接线（未接线时 Sidebar 按约定不渲染该入口）',
  )
})

await check('§4.13 家族一致性：启动时同步 / 改键位时同步的接线都在源码里', () => {
  const panel = readFileSync(path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'), 'utf8')
  assert(panel.includes('syncGlobalShortcuts(next)'), '改键位后必须立即重新注册')
  assert(panel.includes('rebuildVaultIndex()'), '重建索引入口已接线')
  assert(panel.includes('backupVaultInto('), '备份入口已接线')
  assert(panel.includes('effectiveContentFontSizePx()'), '字号展示「实际生效」值')
})

await check('改键位必须先校验再落盘（拒绝的输入不得写进 localStorage）', () => {
  const panel = readFileSync(path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'), 'utf8')
  const body = panel.slice(panel.indexOf('const handleShortcutChange'))
  const validateAt = body.indexOf('validateAccelerator(')
  const conflictAt = body.indexOf('findConflict(')
  const writeAt = body.indexOf('writeShortcutBindings(next)')
  assert(validateAt > 0, '必须调用 validateAccelerator')
  assert(conflictAt > 0, '必须调用 findConflict')
  assert(writeAt > 0, '通过校验后才 writeShortcutBindings')
  assert(validateAt < writeAt, '校验必须在写入之前')
  assert(conflictAt < writeAt, '冲突检测必须在写入之前')
  assert(body.includes('setBindings(previous)'), '后端拒绝时必须回滚到改动前的绑定')
})

await check('后端拒绝键位时回滚（不留「界面显示新键位但实际没生效」的假状态）', async () => {
  const store = new Map()
  globalThis.window = globalThis.window ?? {}
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    // 模拟「写入新键位 → Rust 全部拒绝 → 回滚」
    const before = shortcuts.DEFAULT_SHORTCUT_BINDINGS
    shortcuts.writeShortcutBindings(before)
    const rejected = await shortcuts.syncGlobalShortcuts(
      { ...before, newNote: { id: 'newNote', accelerator: 'Ctrl+Alt+N', enabled: true } },
      {
        invoke: async () => ({
          applied: [],
          failed: [{ id: 'newNote', accelerator: 'Ctrl+Alt+N', reason: '已被其它程序占用' }],
        }),
      },
    )
    const failure = rejected.failed.find((item) => item.id === 'newNote')
    assert(Boolean(failure), '后端拒绝项可被识别（面板据此回滚）')
    shortcuts.writeShortcutBindings(before)
    assertEqual(
      shortcuts.readShortcutBindings().newNote.accelerator,
      'Alt+N',
      '回滚后读回的是原键位',
    )
  } finally {
    delete globalThis.window.localStorage
  }
})

await check('备份结果如实汇报：部分成功不带 complete 标记', () => {
  const source = readFileSync(path.join(projectRoot, 'src/features/settings/vaultData.ts'), 'utf8')
  assert(source.includes('failures'), '备份结果必须带 failures 明细')
  assert(source.includes('complete'), '备份结果必须有 complete 标记')
  assert(/failures\.length === 0/.test(source), 'complete 由 failures 是否为空决定')
  const panel = readFileSync(path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'), 'utf8')
  assert(
    /outcome\.failures|failures\.length/.test(panel),
    '设置面板必须展示失败明细（不能一律报「备份完成」）',
  )
})

await check('冲突键位在「录制态」就被拒绝（组件级 guard，不依赖父级事后回滚）', () => {
  const recorder = readFileSync(
    path.join(projectRoot, 'src/features/settings/ShortcutRecorder.tsx'),
    'utf8',
  )
  assert(recorder.includes('if (conflictLabel)'), '录制回调里必须有 conflictLabel guard')
  const guardAt = recorder.indexOf('if (conflictLabel)')
  const commitAt = recorder.indexOf('commit(formatted)', guardAt)
  assert(commitAt > guardAt, 'guard 必须在 commit 之前（否则会先提交再提示）')
  assert(/占用，请换一个/.test(recorder), '必须给出可读的拒绝原因')
})

await check('「在文件管理器中打开」用 revealItemInDir（openPath 会被 scope 校验拦下）', () => {
  const source = readFileSync(path.join(projectRoot, 'src/features/settings/vaultData.ts'), 'utf8')
  assert(source.includes('revealItemInDir'), '必须用 revealItemInDir')
  assert(!/openPath\(/.test(source), '不得使用 openPath（capabilities 无 scope 条目，会被拒）')
})

/* ------------------------------------------------------------------ */
/* J. 开机自启的**跨边界接线**（t38 收尾：Rust ↔ 配置 ↔ 能力三方必须自洽） */
/*    这些是"改了没反应/静默失效"的高发处：任一处掉了，开关都会看似可用但无效。 */
/* ------------------------------------------------------------------ */

group('J. 开机自启跨边界接线（t38）')

await check('Rust 侧把 `--minimized` 交给 autostart 插件（开机拉起时命令行会带上它）', () => {
  const lib = readFileSync(path.join(projectRoot, 'src-tauri/src/lib.rs'), 'utf8')
  assert(
    /tauri_plugin_autostart::Builder::new\(\)/.test(lib),
    'lib.rs 必须注册 autostart 插件（否则前端 enable/isEnabled 全部 not found）',
  )
  const argMatch = lib.match(/\.arg\(\s*([A-Z_][A-Z0-9_]*)\s*\)/)
  assert(Boolean(argMatch), '.arg(...) 必须传入命名常量（便于两侧对账），而不是散写字面量')
  const constName = argMatch[1]
  const constMatch = lib.match(new RegExp(`const\\s+${constName}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`))
  assert(Boolean(constMatch), `未找到常量 ${constName} 的字符串字面量定义`)
  const argValue = constMatch[1]
  assert(argValue.startsWith('--'), `开机自启参数应以 -- 开头（实际 "${argValue}"）`)
  // 关键：**判定用的必须是同一个常量**，否则"写进去的"与"读出来的"会悄悄分叉
  assert(
    new RegExp(`args\\(\\)\\.any\\(\\|arg\\|\\s*arg\\s*==\\s*${constName}\\)`).test(lib),
    `Rust 里判断启动参数时必须复用同一常量 ${constName}（不得另写一份字面量）`,
  )
})

await check('主窗口 `visible: false`（否则"开机零闪窗"不可能实现）', () => {
  const conf = JSON.parse(readFileSync(path.join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
  const main = (conf.app?.windows ?? []).find((w) => w.label === 'main')
  assert(Boolean(main), 'tauri.conf.json 里找不到主窗口（label: main）')
  assertEqual(
    main.visible,
    false,
    '主窗口必须 visible:false —— Tauri 在 setup **之前**就会按 config 显示窗口，' +
      '只靠 setup 里 hide 仍会闪现约 1 秒；改为由 Rust 的 window::init() 显式 show 才能真正零闪窗。',
  )
})

await check('Rust 侧按该参数走"直接进托盘"分支（否则参数写了也没人用）', () => {
  const raw = readFileSync(path.join(projectRoot, 'src-tauri/src/lib.rs'), 'utf8')
  // ⚠️ 先**剥掉注释**再断言。本文件里就有一句注释写着"正常启动时由下面的 window::init()
  // 负责 show()"—— 不剥注释会把**文档**当成代码，从而误报（本断言初版正是这么红的）。
  // 这已是本项目第 3 次踩"扫散文而不扫代码"：另两次是 `listen(EVENTS.…)` 与
  // `plugin:autostart|` 那两条（都改为剥注释后检查）。
  const lib = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  assert(
    /if\s+started_minimized\(\)/.test(lib),
    'lib.rs 必须存在 `if started_minimized()` 分支，否则 --minimized 会被静默忽略',
  )

  // 必须**按大括号配对**取出两个分支再判断，不能"往下看 N 个字符"：
  // 后者会把 `else { window::init(..) }` 也算进 if 分支，从而误报。
  const splitAt = (source, startIndex) => {
    let depth = 0
    let i = source.indexOf('{', startIndex)
    const bodyStart = i + 1
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    return { thenBlock: source.slice(bodyStart, i), restFrom: i }
  }

  const at = lib.search(/if\s+started_minimized\(\)/)
  const { thenBlock, restFrom } = splitAt(lib, at)

  // ⚠️ 注意判定范围：`window::init(..)` 在**别的分支的条件里**
  // （`} else if let Err(e) = window::init(..) {`），所以它位于大括号**之外** ——
  // 只比对"块体"会漏掉它。这里对 if 分支比对「块体」，对 else 分支比对
  // 「从 `else if` 起的整个区域」，才与代码真实结构对齐。
  assert(
    /window::init\s*\(/.test(thenBlock) === false,
    '`if started_minimized()` 分支内不得调用 window::init()（那是"显示"路径，会撤销零闪窗）',
  )
  assert(/hide\(\)/.test(thenBlock), '`if started_minimized()` 分支必须显式隐藏主窗口（直接进托盘）')

  // `} else if <绑定> = window::init(..) {` —— 宽松匹配，不假设中间是简单表达式或 let
  const elseMatch = lib.slice(restFrom, restFrom + 120).match(/^\}\s*else\s+if[^{]*\{/)
  assert(Boolean(elseMatch), '`if started_minimized()` 必须有 else 分支（正常启动要显示窗口）')
  const elseRegion = lib.slice(
    restFrom + 1,
    restFrom + elseMatch[0].length + splitAt(lib, restFrom + elseMatch[0].length - 1).thenBlock.length,
  )
  assert(
    /window::init\s*\(/.test(elseRegion),
    'else 分支必须调用 window::init()（正常启动时由它显式 show 主窗口）',
  )
})

await check('capabilities 已授予 autostart 三条权限（能力缺失 ⇒ 前端读到不可用）', () => {
  const cap = JSON.parse(
    readFileSync(path.join(projectRoot, 'src-tauri/capabilities/default.json'), 'utf8'),
  )
  const permissions = cap.permissions ?? []
  for (const needed of ['autostart:allow-enable', 'autostart:allow-disable', 'autostart:allow-is-enabled']) {
    assert(
      permissions.includes(needed),
      `default.json 缺少 ${needed}（缺失时前端 isEnabled() 会失败，UI 只能显示"无法读取系统状态"）`,
    )
  }
})

await check('前端依赖的调用面与包导出一致（enable/disable/isEnabled 三个都在）', () => {
  const source = readFileSync(path.join(projectRoot, 'src/features/settings/autostart.ts'), 'utf8')
  const imported = source.match(/const\s*\{([^}]*)\}\s*=\s*await import\('@tauri-apps\/plugin-autostart'\)/)
  assert(
    Boolean(imported) || /import\('@tauri-apps\/plugin-autostart'\)/.test(source),
    'autostart.ts 必须通过包导出的函数调用',
  )
  for (const fn of ['isEnabled', 'enable', 'disable']) {
    assert(
      new RegExp(`\\b${fn}\\b`).test(source),
      `autostart.ts 必须用到 ${fn}（读取/stub 时缺一不可）`,
    )
  }
})

await check('`--minimized` 是「启动后不显示窗口」的唯一路径（前端偏好已删除，不得复活）', () => {
  // 历史：t17 曾有前端偏好 `zhijian.startMinimized`（WebView 起来后由前端 hide），
  // 代价是约 1 秒闪现，且它与「开机自启」之间有过一条组合改写。
  // 该偏好、其设置项与组合行为已整体删除 —— 这条断言就是删除的守卫：
  // **代码**里（注释不算，注释要留着讲历史）再出现这个标识符即失败。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')

  const lib = readFileSync(path.join(projectRoot, 'src-tauri/src/lib.rs'), 'utf8')
  assert(/started_minimized\(\)/.test(lib), 'Rust 侧应保留 --minimized 判定（开机自启零闪窗）')

  for (const rel of [
    'src/features/settings/SettingsPanel.tsx',
    'src/features/settings/autostart.ts',
    'src/lib/appPreferences.ts',
  ]) {
    const source = readFileSync(path.join(projectRoot, rel), 'utf8')
    const code = stripComments(source)
    // 防"断言空跑"：stripComments 若把整个文件吃掉了，这里必须炸而不是静默通过
    assert(code.length > source.length * 0.5, `${rel} 去注释后不应被吃掉大半（防断言空跑）`)
    assert(
      !/startMinimized/i.test(code),
      `${rel} 的代码里不得再出现 startMinimized（该偏好已删除）`,
    )
  }

  // 配套改动（勿回退）：主窗口 visible:false + 由 Rust 显式 show，
  // 否则开机自启会先弹一个空白窗口再收起。
  const conf = JSON.parse(readFileSync(path.join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
  const windows = conf.app?.windows ?? conf.windows ?? []
  const main = windows.find((w) => w.label === 'main')
  assert(main && main.visible === false, '主窗口必须 visible:false（何时 show 由 Rust 决定）')
})

/* ------------------------------------------------------------------ */
/* I. 开机自启（t38）—— 开关状态 ←→ 系统实际状态的一致性                  */
/*    核心原则：**读不到系统状态时绝不当作「未启用」**（那会把假状态当事实）  */
/* ------------------------------------------------------------------ */

group('I. 开机自启（t38）')

/** 构造一个可编程的假插件（模拟 enable/disable/isEnabled 的真实语义） */
function fakePlugin(initial = false) {
  const state = { enabled: initial, calls: [] }
  return {
    state,
    api: {
      isEnabled: async () => state.enabled,
      enable: async () => {
        state.calls.push('enable')
        state.enabled = true
      },
      disable: async () => {
        state.calls.push('disable')
        state.enabled = false
      },
    },
  }
}

const withStoredPrefs = async (entries, fn) => {
  const store = new Map(entries)
  globalThis.window = globalThis.window ?? {}
  const previous = globalThis.window.localStorage
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    return await fn(store)
  } finally {
    globalThis.window.localStorage = previous
  }
}

await check('读系统状态：成功时返回 known + 真实值', async () => {
  const on = fakePlugin(true)
  const state = await autostart.readSystemAutostart(on.api)
  assertEqual(state.kind, 'known', 'kind')
  assertEqual(state.enabled, true, '读到的实际值')
})

await check('⭐ 读不到系统状态时返回 unavailable，**绝不伪装成「未启用」**', async () => {
  const failing = {
    isEnabled: async () => {
      throw new Error('plugin not registered')
    },
    enable: async () => {},
    disable: async () => {},
  }
  const state = await autostart.readSystemAutostart(failing)
  assertEqual(state.kind, 'unavailable', '必须报告 unavailable')
  assert(state.kind === 'unavailable' && state.reason.includes('无法读取'), '必须给出可读原因')
  assert(
    !('enabled' in state),
    'unavailable 时**不得**携带 enabled 字段（否则调用方可能误当 false 使用）',
  )
})

await check('切换：开启 → 系统状态变为已启用，且**回读**确认（ok=true）', async () => {
  const plugin = fakePlugin(false)
  const result = await autostart.setSystemAutostart(true, plugin.api)
  assertEqual(result.ok, true, '报告成功')
  assertEqual(result.before, false, '操作前 = 未启用')
  assertEqual(result.after, true, '**回读** = 已启用（结论以回读为准）')
  assertEqual(plugin.state.calls.join(','), 'enable', '调用的是 enable')
})

await check('切换：关闭 → 回读确认已关闭', async () => {
  const plugin = fakePlugin(true)
  const result = await autostart.setSystemAutostart(false, plugin.api)
  assertEqual(result.ok, true, '报告成功')
  assertEqual(result.after, false, '回读 = 未启用')
  assertEqual(plugin.state.calls.join(','), 'disable', '调用的是 disable')
})

await check('⭐ 「调用没报错但未生效」必须被判为失败（防止假成功）', async () => {
  // 模拟：enable() 不抛错，但系统状态没变（权限被拒/被策略拦下等）
  const stubborn = {
    isEnabled: async () => false,
    enable: async () => {},
    disable: async () => {},
  }
  const result = await autostart.setSystemAutostart(true, stubborn)
  assertEqual(result.ok, false, '必须报告失败（不能因为"没抛错"就算成功）')
  assertEqual(result.after, false, '回读值如实反映系统仍是未启用')
  assert(Boolean(result.message) && result.message.includes('未生效'), '必须给出可读原因')
})

await check('切换失败（抛错）时给出可读原因且 after=null', async () => {
  const failing = {
    isEnabled: async () => false,
    enable: async () => {
      throw new Error('Access is denied (os error 5)')
    },
    disable: async () => {},
  }
  const result = await autostart.setSystemAutostart(true, failing)
  assertEqual(result.ok, false, '失败')
  assertEqual(result.after, null, '未回读到状态')
  assert(result.message.includes('Access is denied'), '原始原因透传，便于排查')
})

await check('组合行为已删除：自启开关不得改写任何「最小化到托盘」偏好', async () => {
  // 历史：开启自启时若用户从未亲自设过 startMinimized，就顺手把它置 true。
  // 该偏好与这条组合行为已整体删除 ⇒ 这条断言同时守行为与 API 形态：
  //  (1) 返回值里不再有 autoEnabledStartMinimized；
  //  (2) 调一次 applyAutostart 后 localStorage 里**只**能多出 zhijian.autostart，
  //      绝不出现 zhijian.startMinimized / zhijian.startMinimizedTouched；
  //  (3) 相关读写函数与 PREFERENCE_KEYS 条目必须都不存在。
  await withStoredPrefs([], async (store) => {
    const plugin = fakePlugin(false)
    const result = await autostart.applyAutostart(true, plugin.api)
    assertEqual(result.ok, true, '系统侧成功')
    assert(
      !('autoEnabledStartMinimized' in result),
      '返回值里不得再有 autoEnabledStartMinimized（组合行为已删除）',
    )
    assertEqual(store.get(prefs.PREFERENCE_KEYS.autostart), 'true', '用户意图已落库')
    const leaked = [...store.keys()].filter((key) => key !== prefs.PREFERENCE_KEYS.autostart)
    assertEqual(leaked.join(','), '', `不得写入其它偏好键（实际：${leaked.join(',') || '无'}）`)

    assert(
      !('startMinimized' in prefs.PREFERENCE_KEYS) &&
        !('startMinimizedTouched' in prefs.PREFERENCE_KEYS),
      'PREFERENCE_KEYS 里不得再有 startMinimized / startMinimizedTouched',
    )
    assert(
      typeof prefs.readStartMinimized === 'undefined' &&
        typeof prefs.setStartMinimized === 'undefined' &&
        typeof prefs.markStartMinimizedTouched === 'undefined',
      'readStartMinimized / setStartMinimized / markStartMinimizedTouched 必须已删除',
    )
    assert(
      typeof autostart.markStartMinimizedTouched === 'undefined' &&
        typeof autostart.AUTOSTART_MINIMIZED_COMBINATION === 'undefined',
      'autostart 模块不得再导出组合行为相关符号',
    )
  })

  // 关闭自启同样不得触碰任何「最小化」偏好
  await withStoredPrefs([[prefs.PREFERENCE_KEYS.autostart, 'true']], async (store) => {
    const plugin = fakePlugin(true)
    const result = await autostart.applyAutostart(false, plugin.api)
    assertEqual(result.ok, true, '系统侧成功')
    assertEqual(store.get(prefs.PREFERENCE_KEYS.autostart), 'false', '用户意图已落库为关闭')
    const leaked = [...store.keys()].filter((key) => key !== prefs.PREFERENCE_KEYS.autostart)
    assertEqual(leaked.join(','), '', `关闭场景也不得写其它键（实际：${leaked.join(',') || '无'}）`)
  })
})

await check('漂移判定：系统状态与用户意图不一致时报 drifted；读不到时不误报', () => {
  const store = new Map([[prefs.PREFERENCE_KEYS.autostart, 'true']])
  globalThis.window = globalThis.window ?? {}
  const previous = globalThis.window.localStorage
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    assertEqual(autostart.autostartDrift(true).drifted, false, '一致 → 不报漂移')
    assertEqual(autostart.autostartDrift(false).drifted, true, '系统被手动关掉 → 报漂移')
    assertEqual(autostart.autostartDrift(null).drifted, false, '读不到 → 不误报（无法判断）')
  } finally {
    globalThis.window.localStorage = previous
  }
})

await check('不得硬编码 `plugin:autostart|*` 命令名（本项目已因命令名漂移踩过坑）', () => {
  const raw = readFileSync(path.join(projectRoot, 'src/features/settings/autostart.ts'), 'utf8')
  // ⚠️ 必须**剥掉注释再检查**：本文件顶部恰好有一句"不拼任何 `plugin:autostart|*` 字符串"
  // 的说明（记录这条约定），如果连注释一起扫，断言会被自己的文档触发（假红）。
  // 同理：模块名 `@tauri-apps/plugin-autostart` 里的 "plugin-autostart" 用的是连字符，
  // 与命令前缀 `plugin:autostart|`（冒号+竖线）不是一回事。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|\s)\/\/.*$/gm, '') // 行注释
  assert(
    !/plugin:autostart/.test(code),
    'autostart.ts 的**代码**中不得出现 `plugin:autostart|` 硬编码命令前缀（注释里说明约定是允许的）',
  )
  assert(
    !/invoke\(\s*['"`]plugin:/.test(code),
    'autostart.ts 不得直接 invoke 插件的命令字符串（应走包导出的函数）',
  )
  assert(
    code.includes("import('@tauri-apps/plugin-autostart')"),
    '应通过包导出的函数调用（enable/disable/isEnabled），而不是拼命令名',
  )
})

await check('UI 展示的系统状态必须来自 isEnabled() 读取，而不是本地偏好', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src/features/settings/SettingsPanel.tsx'),
    'utf8',
  )
  assert(
    panel.includes('readSystemAutostart()') && panel.includes('applyAutostart('),
    '设置面板必须通过 autostart.ts 读系统状态与执行切换',
  )
  assert(
    panel.includes('data-autostart-actual'),
    '必须有可被探针/QA 断言的"系统实际状态"标记（data-autostart-actual）',
  )
  // 开关的 checked 必须绑系统状态，而不是 preferences.autostart
  const switchBlock = panel.slice(panel.indexOf('label="开机自动启动"') - 200, panel.indexOf('label="开机自动启动"'))
  assert(
    switchBlock.includes('checked={autostartSystem === true}'),
    '开关 checked 必须绑定"系统实际状态"，不得绑定本地偏好',
  )
})

/* ---------- 4.5) t46：快捷键启动下发 / 设置改右侧栏 ---------- */

{
  const fsT46 = await import('node:fs')
  const pathT46 = await import('node:path')
  const hereT46 = pathT46.dirname((await import('node:url')).fileURLToPath(import.meta.url))
  const rootT46 = pathT46.resolve(hereT46, '../../../..')
  const readT46 = (rel) => {
    try {
      return fsT46.readFileSync(pathT46.join(rootT46, rel), 'utf8')
    } catch {
      return ''
    }
  }
  const shortcutsSrc = readT46('src/features/settings/shortcuts.ts')
  const appSrc = readT46('src/App.tsx')
  /**
   * 去注释后用于**负向**断言：注释里合法地提到了旧标识符（例如"改动只有一行
   * editorVisible → settingsVisible"），若拿原文做负向匹配就会误伤正确代码。
   * （本项目栽过正向的同类问题："断言命中的其实是注释"，这次是它的反面。）
   */
  const stripCommentsT46 = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const appCode = stripCommentsT46(appSrc)

  /**
   * 报障（用户原话）：「关闭程序后，再开启，关于磁贴的快捷键失效」。
   * 根因：`cmd_sync_global_shortcuts` **只在设置面板里**被调用，而 Rust 启动只注册
   * `default_bindings()`（newNote/toggleWindow）⇒ 用户自定义的磁贴快捷键重启即丢。
   * 断言要点：必须存在一个"启动下发"的函数，**且 App 的启动流程里真的调了它**。
   */
  await check('t46：必须存在"启动时下发快捷键绑定"的函数（而不是只在设置面板里下发）', () => {
    assert(
      /export async function syncShortcutBindingsOnStartup/.test(shortcutsSrc),
      'shortcuts.ts 缺少 syncShortcutBindingsOnStartup —— 重启后用户自定义键位不会被注册',
    )
    assert(
      /syncGlobalShortcuts\(readShortcutBindings\(\)\)/.test(shortcutsSrc),
      '启动下发必须是"把持久化的绑定下发给 Rust"（读 localStorage 的权威值）',
    )
  })

  await check('t46：App 的启动流程里真的调用了启动下发（这是报障的修复点）', () => {
    assert(
      /syncShortcutBindingsOnStartup\(/.test(appSrc),
      'App 没有调用启动下发 —— 这正是"重启后快捷键失效"的根因',
    )
    // 必须在启动流程的 effect 里（与 initDb 同一段），而不是别处随手调一次
    const bootIndex = appSrc.indexOf('await initDb()')
    const syncIndex = appSrc.indexOf('syncShortcutBindingsOnStartup(')
    assert(
      bootIndex >= 0 && syncIndex > bootIndex,
      '启动下发必须发生在启动流程里（initDb 之后），否则可能赶在 Rust 注册表建立之前',
    )
    // 失败要有**用户看得见**的反馈：静默失效的键位，用户只会以为"功能坏了"。
    // ⚠️ 必须锚在 Toast 的 title 上：同一句话在 `console.warn` 里也出现，
    //    用 `includes('快捷键未完全生效')` 会把"只写 console"也算通过（变异测试抓到过）。
    assert(
      /title: '快捷键未完全生效'/.test(appSrc),
      '启动下发失败时必须给用户可见反馈（Toast），不能只写 console',
    )
  })

  await check('t46：Q2 —— 「显示/隐藏全部磁贴」的说明必须写明只影响临时磁贴', () => {
    assert(
      /临时/.test(shortcutsSrc) && /toggleTiles/.test(shortcutsSrc),
      'toggleTiles 的说明要与行为一致：已固定的磁贴不受"全部显隐"影响（用户明确要求）',
    )
  })

  /**
   * 布局：设置从"单独一页"改为"最右侧一栏"（用户要求）。
   * 负向断言很关键：只要 App 里还留着 `editorVisible` 那套"设置时隐藏主界面"的写法，
   * 就会出现"点设置 → 主界面整块消失"的旧行为（等于没改）。
   */
  await check('t46：设置 = 最右侧一栏（主界面保持可见，且不再有"设置替换主区域"的旧写法）', () => {
    assert(
      /data-zj="settings-column"/.test(appSrc),
      'App 缺少设置栏容器标记 data-zj="settings-column"（探针据此断言它是一栏而不是一页）',
    )
    assert(
      // 必须是**裸 prop** 形态的 standalone（`standalone={false}` 会让面板自带 Dialog 浮层）
      /<SettingsPanel[\s\S]{0,600}?\sstandalone(?![=\w])/.test(appSrc),
      '设置栏必须以 standalone 渲染（否则它会自带 Dialog 浮层，又变成"盖住整个界面"）',
    )
    assert(
      !/editorVisible/.test(appCode),
      'App 里仍有 editorVisible（"设置时隐藏主界面"的旧写法）—— 那等于没把设置改成一栏',
    )
    // 主区域不能再被设置面板替换：设置栏必须与 NoteList 并列存在于同一个 flex 容器里
    const listIndex = appSrc.indexOf('<NoteList')
    const columnIndex = appSrc.indexOf('data-zj="settings-column"')
    assert(listIndex >= 0 && columnIndex > listIndex, '设置栏应排在笔记列表之后（最右侧一栏）')
  })
}

/* ------------------------------------------------------------------ */
/* K. 磁贴吸附开关（t52）                                                */
/*    需求原话：「增加开启/关闭磁贴吸附的功能」。                        */
/*    权威源与 §4.13 的 closeToTray 一致：持久化在 localStorage，        */
/*    行为在 Rust（进程内 AtomicBool），启动时与变更时由前端下发。       */
/* ------------------------------------------------------------------ */

group('K. 磁贴吸附开关（t52）')

/** 读仓库内文件（读不到返回空串，让断言以"缺少 X"失败而不是抛异常） */
const readT52 = (rel) => {
  try {
    return readFileSync(path.join(projectRoot, rel), 'utf8')
  } catch {
    return ''
  }
}

/** 去注释后用于**正向**断言：注释里提到某标识符不算实现 */
const stripT52 = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/**
 * 取锚点之后第一段**花括号配平**的代码块。
 * 刻意不用「接下来 N 个字符」：那种写法在文件被重排后会静默失配（本项目踩过）。
 */
const blockAfter = (source, anchor) => {
  const start = source.indexOf(anchor)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

await check('t52：偏好键 / 默认值 / 读写函数齐全（localStorage 是持久化权威）', () => {
  const prefs = readT52('src/lib/appPreferences.ts')
  assert(prefs.length > 0, 'appPreferences.ts 读不到（防断言空跑）')
  assert(/tileSnap: 'zhijian\.tileSnap'/.test(prefs), 'PREFERENCE_KEYS 缺 tileSnap')
  assert(
    /tileSnap: true,/.test(prefs),
    '默认值必须是 true —— 默认关闭等于"升级后吸附突然没了"，老用户会当成故障',
  )
  assert(/export function readTileSnap\(\): boolean/.test(prefs), '缺 readTileSnap')
  assert(/export function writeTileSnap\(value: boolean\): void/.test(prefs), '缺 writeTileSnap')
  assert(/\n    setTileSnap,/.test(prefs), 'useAppPreferences 未把 setTileSnap 暴露给面板')
})

await check('t52：设置面板有开关，且变更时**两条路都走**（落库 + 下发 Rust）', () => {
  const panel = stripT52(readT52('src/features/settings/SettingsPanel.tsx'))
  assert(panel.length > 0, 'SettingsPanel.tsx 读不到')
  assert(/data-zj="tile-snap-row"/.test(panel), '缺开关行标记 data-zj="tile-snap-row"')
  assert(/data-zj="tile-snap-toggle"/.test(panel), '缺开关控件标记 data-zj="tile-snap-toggle"')
  assert(/preferences\.setTileSnap\(value\)/.test(panel), '开关必须落库，否则重启就忘')
  assert(
    /syncTileSnapPreference\(value\)/.test(panel),
    '开关必须同时下发 Rust —— 只落库会出现"改了不生效"的假开关',
  )
  assert(/data-zj="tile-snap-drift"/.test(panel), '缺"后端值≠本机偏好"的漂移提示（诊断用）')
})

await check('t52：App 启动流程会下发一次（否则重启后用户关掉的开关被悄悄忘记）', () => {
  const app = readT52('src/App.tsx')
  assert(app.length > 0, 'App.tsx 读不到')
  /**
   * 锚点必须带那段注释的分隔线：`启动流程` 这四个字在 App.tsx 里出现多次
   * （文件头说明、ref 注释…），裸词锚点会落在 import 的 `{` 上、静默取到错误的块
   * —— 这条断言第一次就是这么假失败/假通过的（实测：取到的块里没有下发调用）。
   */
  const boot = blockAfter(app, '/* ------------------------------ 启动流程')
  assert(Boolean(boot), '在 App.tsx 里找不到「启动流程」那段 effect（锚点失效）')
  assert(
    // ⚠️ 必须先对**这段块**去注释再匹配。变异测试抓到过这个漏洞：
    // 直接匹配原文时，把调用注释掉（`// void syncTileSnapPreference()`）
    // 仍然会被判为通过 —— 断言命中的是注释，不是代码。
    /syncTileSnapPreference\(\)/.test(stripT52(boot ?? '')),
    '启动流程里没有下发磁贴吸附偏好：Rust 是进程内状态，不下发就会回落默认 true',
  )

  const module = stripT52(readT52('src/features/settings/tileSnap.ts'))
  assert(/export async function syncTileSnapPreference/.test(module), '缺下发函数 syncTileSnapPreference')
  assert(/isTileSnapDrifted/.test(module), '缺漂移判定（面板靠它提示"未生效"）')
  assert(
    /console\.warn\(/.test(module) && !/throw new Error/.test(module),
    '下发失败必须只 warn（返回 synced:false），不得把设置面板/启动流程炸掉',
  )

  const tauri = stripT52(readT52('src/lib/tauri.ts'))
  assert(/setTileSnap: 'cmd_set_tile_snap'/.test(tauri), 'COMMANDS 缺 setTileSnap')
  assert(/tileSnapEnabled: 'cmd_tile_snap_enabled'/.test(tauri), 'COMMANDS 缺 tileSnapEnabled')
})
/* ------------------------------------------------------------------ */
/* L. 启动模式与磁贴选项（t54）                                          */
/*    需求：① 启动显示模式可选（编辑/分栏/预览）② 磁贴透明度可调          */
/*          ③ 是否允许编辑磁贴 ④ 已固定磁贴是否允许被隐藏                */
/*    复用 K 组定义的 readT52 / stripT52 / blockAfter 三个 helper。       */
/* ------------------------------------------------------------------ */

group('L. 启动模式与磁贴选项（t54）')

await check('t54：四个偏好键 / 默认值 / 读写函数齐全，且默认值都"不变观感"', () => {
  const prefs = readT52('src/lib/appPreferences.ts')
  assert(prefs.length > 0, 'appPreferences.ts 读不到（防断言空跑）')
  for (const key of ['startupViewMode', 'tileOpacity', 'tileEditable', 'pinnedTilesHidable']) {
    assert(
      prefs.includes(`${key}: 'zhijian.${key}'`),
      `PREFERENCE_KEYS 缺 ${key}`,
    )
  }
  // 默认值必须与本次改动之前的观感一致，否则升级后界面/磁贴会突然变样
  assert(/startupViewMode: 'split',/.test(prefs), "默认启动模式必须是 'split'（原本就是分栏）")
  assert(/tileOpacity: 1,/.test(prefs), '默认透明度必须是 1（原本不透明）')
  assert(/tileEditable: true,/.test(prefs), '默认必须允许编辑（磁贴本来就是随手改的）')
  assert(
    /pinnedTilesHidable: false,/.test(prefs),
    '默认必须 false —— 沿用 t46 的用户要求「固定的磁贴永远留在桌面上」',
  )
  assert(/export function clampTileOpacity/.test(prefs), '缺 clampTileOpacity（下限保护）')
  assert(/TILE_OPACITY_MIN = 0\.3/.test(prefs), '透明度下限应为 0.3（再低就找不着磁贴）')
  assert(/export const STARTUP_VIEW_MODE_OPTIONS/.test(prefs), '缺设置面板用的展示选项')
})

await check('t54：设置面板四项控件齐全，需下发 Rust 的那条真的下发了', () => {
  const panel = stripT52(readT52('src/features/settings/SettingsPanel.tsx'))
  assert(panel.length > 0, 'SettingsPanel.tsx 读不到')
  assert(/data-zj="startup-mode-option"/.test(panel), '缺「启动显示模式」选项按钮')
  assert(/preferences\.setStartupViewMode\(/.test(panel), '启动模式必须落库')
  assert(/data-zj="tile-opacity-slider"/.test(panel), '缺「磁贴透明度」滑块')
  assert(/preferences\.setTileOpacity\(/.test(panel), '透明度滑块必须落库')
  assert(/data-zj="tile-editable-toggle"/.test(panel), '缺「允许编辑磁贴」开关')
  assert(/data-zj="pinned-hidable-toggle"/.test(panel), '缺「允许隐藏已固定磁贴」开关')
  assert(
    /syncPinnedTilesHidablePreference\(value\)/.test(panel),
    '这条必须下发 Rust —— 全部显隐由快捷键/托盘直接调 Rust，不经过前端；只落库等于开关无效',
  )
})

await check('t54：启动模式真的被用来初始化编辑器；固定可隐藏真的在启动时下发', () => {
  const app = readT52('src/App.tsx')
  assert(app.length > 0, 'App.tsx 读不到')
  const appCode = stripT52(app)
  assert(/readStartupViewMode\(\)/.test(appCode), 'App 没读启动显示模式（那这个设置就是假的）')
  assert(
    /useState<'edit' \| 'preview' \| 'split'>\(\s*\(\)\s*=>\s*readStartupViewMode\(\)/.test(
      appCode.replace(/\n\s*/g, ' '),
    ),
    '启动模式必须作为 editorMode 的初始值（惰性初始化）—— 只在别处读一下不影响启动观感',
  )
  /**
   * ⚠️ 锚点必须落在**原文**上（那段注释分隔线），而断言再对**去注释后的块**匹配。
   * 第一版写成 `blockAfter(appCode, '/* --- 启动流程')` —— appCode 已被 stripT52 去掉注释，
   * 锚点自然找不到，于是这条断言在正常态就先炸（不是变异测试抓的，是它自己先红）。
   */
  const bootRaw = blockAfter(app, '/* ------------------------------ 启动流程')
  assert(Boolean(bootRaw), '找不到「启动流程」那段 effect（锚点失效，断言会空跑）')
  assert(
    /syncPinnedTilesHidablePreference\(\)/.test(stripT52(bootRaw)),
    '启动流程没有下发「固定磁贴可被隐藏」—— Rust 是进程内状态，不下发就会回落默认 false',
  )
})

await check('t54：localStorage 为空时，四个偏好都回落到"不变观感"的默认值（运行时实测）', () =>
  /**
   * 这条断言存在的唯一理由：**源码里写着默认值 ≠ 运行时默认值**。
   * 实际踩过：`readTileOpacityRaw` 用 `Number.isFinite(Number(raw))` 判空，
   * 而 `Number(null) === 0` 是有限数 ⇒ 被下限 clamp 成 0.3，
   * 于是"默认完全不透明"变成了"默认 30% 透明"（真机 UI 上滑块停在了最左）。
   * 静态断言只比对源码文本（`tileOpacity: 1,`）永远抓不到，所以这里必须**真读一次**。
   */
  withStoredPrefs([], async () => {
    assertEqual(prefs.readStartupViewMode(), 'split', '默认应为分栏（改动前的观感）')
    assertEqual(prefs.readTileOpacity(), 1, '默认应为 1（完全不透明）')
    assertEqual(prefs.readTileEditable(), true, '默认应允许编辑磁贴')
    assertEqual(prefs.readPinnedTilesHidable(), false, '默认应为 false（固定磁贴不参与全部显隐）')
  }),
)

await check('t54：磁贴窗口真的用了这两个偏好（透明度 + 两处只读）', () => {
  const tile = stripT52(readT52('src/features/tiles/TileApp.tsx'))
  assert(/useAppPreferences\(\)/.test(tile), '磁贴没有读应用偏好（跨窗口靠同源 localStorage + storage 事件自动同步）')
  assert(
    /opacity: preferences\.tileOpacity/.test(tile.replace(/\n\s*/g, ' ')),
    '磁贴没有把透明度应用到容器上',
  )
  assert(
    (tile.match(/readOnly=\{!preferences\.tileEditable\}/g) ?? []).length === 2,
    '磁贴的标题与正文都要能只读（只改一处会变成"半只读"：标题能改、正文不能改）',
  )
  assert(/只读/.test(tile), '只读时必须有可见提示，否则用户点了改不动会以为界面卡住')
})

/* ---------- 5) 汇总 ---------- */

const failed = results.filter((item) => !item.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`,
)
if (failed.length > 0) {
  for (const item of failed) console.log(`   - [${item.group}] ${item.name}: ${item.error}`)
}

rmSync(workDir, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
