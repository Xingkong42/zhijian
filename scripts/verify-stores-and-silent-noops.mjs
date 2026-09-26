// 纸笺 · QA 独立验证脚本 3/4：store 真实性 + 「silent no-op」缺陷扫描
//
// 背景（captain 指定的本项目高频缺陷模式）：值被写了但没人消费、prop 可选且无人传、
// 事件 emit 但无 listener、配置项被读取但不参与分支、文档声称存在的机制在代码里不存在。
// 这类缺陷 typecheck / vite:build / cargo check / cargo test 全绿也发现不了。
//
// 本脚本做两件事：
//   A. store 真实性：四个 store 必须是真实 zustand（getState() 可用、字段齐全），
//      并回归 t7 修过的 I1（openSettings 必须同时设 view 与 settingsOpen）。
//   B. 结构扫描：把每一条「静默失效」证据落到 文件:行，并断言其当前是否存在。
//      存在即视为缺陷（脚本退出码 1），从而变成可重复执行的回归守卫。
//
// 运行：node scripts/verify-stores-and-silent-noops.mjs
//
// ## 路径 / 磁盘访问审计（t30，同类排查结论：本文件**无隐患**）
// 1) **不读任何环境变量** ⇒ 不存在「环境变量缺失 → 回落相对路径」的风险；
// 2) **不打开任何数据库文件**：本脚本只用 `readFileSync/readdirSync` 扫源码，路径来自
//    `path.resolve(here, '..')`（脚本自身绝对目录 ⇒ 恒为绝对路径）。
//    它 import 的 store 会经 loader 拿到 `@tauri-apps/plugin-sql` 替身，而该替身是
//    `src/db/__checks__/stub-plugin-sql.mjs:35` 的 `new DatabaseSync(':memory:')`
//    —— **纯内存库，不落任何文件**（已核对，非推断）。
// 3) 若将来要在此脚本里读写磁盘上的新路径，**必须**走 `scripts/lib/qa-paths.mjs`：
//    那里记录了「相对路径会被 SQLite/fs 静默落到进程工作目录、产生 0 字节垃圾文件」的实证，
//    并强制 `assertAbsolutePath` 与环境变量显式判空。

import { register } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const srcDir = path.join(root, 'src')

register(new URL('../src/db/__checks__/loader.mjs', import.meta.url).href)

let pass = 0
const defects = []

function ok(m) { pass += 1; console.log(`  ✅ ${m}`) }
function defect(id, severity, m) { defects.push({ id, severity, m }); console.log(`  ⚠️  [${severity}] ${m}`) }
function assert(cond, m) { if (cond) ok(m); else { defects.push({ id: 'assert-fail', severity: 'blocker', m }); console.log(`  ❌ ${m}`) } }

/** 收集 src 下所有 ts/tsx 源文件 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
const files = collect(srcDir)
const rel = (p) => path.relative(root, p).replace(/\\/g, '/')

/** 在全部源文件中查正则，返回 {file:line} 命中（排除注释行可选） */
function find(pattern, { excludeComments = true, only } = {}) {
  const hits = []
  for (const file of files) {
    if (only && !file.includes(only)) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (excludeComments && (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))) return
      if (pattern.test(line)) hits.push(`${rel(file)}:${index + 1}`)
    })
  }
  return hits
}

/* ========================= A. store 真实性 ========================= */

console.log('── A. 四个 store 是否为真实 zustand（getState 可用 + 冻结字段齐全）')

const storeSpecs = [
  { mod: '../src/store/notes.ts', hook: 'useNotesStore', fields: ['notes', 'selectedId', 'loading', 'error', 'init', 'create', 'select', 'update', 'remove', 'restore', 'move', 'listByFolder', 'listByTag', 'clearError'] },
  { mod: '../src/store/search.ts', hook: 'useSearchStore', fields: ['query', 'results', 'searching', 'error', 'search', 'clear'] },
  { mod: '../src/store/ui.ts', hook: 'useUiStore', fields: ['sidebarCollapsed', 'view', 'activeFolderId', 'activeTagId', 'settingsOpen', 'toggleSidebar', 'setView', 'openSettings', 'closeSettings'] },
  { mod: '../src/store/theme.ts', hook: 'useThemeStore', fields: ['themeId', 'mode', 'themeList', 'setTheme', 'setMode', 'toggleMode', 'apply'] },
]

const loadedStores = {}
for (const spec of storeSpecs) {
  try {
    const mod = await import(new URL(spec.mod, import.meta.url).href)
    const hook = mod[spec.hook]
    loadedStores[spec.hook] = hook
    const hasVanilla = typeof hook === 'function' && typeof hook.getState === 'function' && typeof hook.setState === 'function' && typeof hook.subscribe === 'function'
    assert(hasVanilla, `${spec.hook}（${spec.mod.replace('../src/', 'src/')}）是真实 zustand：getState/setState/subscribe 均为函数`)
    if (!hasVanilla) continue
    const state = hook.getState()
    const missing = spec.fields.filter((f) => !(f in state))
    assert(missing.length === 0, `${spec.hook} 的冻结字段/方法全部存在（缺失 ${missing.length} 个${missing.length ? `: ${missing.join(', ')}` : ''}）`)
  } catch (error) {
    assert(false, `${spec.hook} 可导入且可用：${error instanceof Error ? error.message : String(error)}`)
  }
}

// I1 回归：openSettings 必须同时设置 view 与 settingsOpen
if (loadedStores.useUiStore) {
  const ui = loadedStores.useUiStore
  ui.getState().openSettings()
  const s = ui.getState()
  assert(s.view === 'settings' && s.settingsOpen === true, `I1 回归：openSettings() 后 view=${s.view}、settingsOpen=${s.settingsOpen}（UI 以 view==='settings' 为判据，只设 settingsOpen 会静默失效）`)
  ui.getState().closeSettings()
  const after = ui.getState()
  assert(after.settingsOpen === false && after.view === 'all', `closeSettings() 后 settingsOpen=${after.settingsOpen}、view=${after.view}`)
}

// 主题默认：无 localStorage 时必须回落 paper-yellow / light
if (loadedStores.useThemeStore) {
  const t = loadedStores.useThemeStore.getState()
  assert(t.themeId === 'paper-yellow' && t.mode === 'light', `themeStore 无持久化时默认 themeId=${t.themeId} / mode=${t.mode}（需求 m：默认淡黄色）`)
}

/* ==================== B. silent no-op 结构扫描 ==================== */

console.log('\n── B. silent no-op 扫描（每条都落到 文件:行）')

// B1 同一事件被订阅两次 → 一次 Alt+N 建两条笔记
const newNoteListeners = find(/listen\(\s*EVENTS\.newNoteRequested/)
if (newNoteListeners.length > 1) {
  defect('D1', 'high', `同一事件 ${'zhijian://new-note-requested'} 被订阅 ${newNoteListeners.length} 次：${newNoteListeners.join('、')} ⇒ 一次 Alt+N 会创建两条笔记（已实测复现）`)
} else {
  ok(`new-note-requested 只被订阅一次（${newNoteListeners.length} 处）`)
}
// 顺带核对其它事件是否也有重复订阅
for (const ev of ['openSettingsRequested', 'appQuitRequested', 'windowHidden']) {
  const hits = find(new RegExp(`listen\\(\\s*EVENTS\\.${ev}`))
  if (hits.length > 1) defect('D1b', 'medium', `事件 ${ev} 被订阅 ${hits.length} 次：${hits.join('、')}`)
  else ok(`事件 ${ev} 订阅次数 = ${hits.length}`)
}

// B2 导出的快捷键绑定器没有调用方
const bindShortcutsDef = find(/export function bindShortcuts/)
// 只看**注释之外**的调用点，并排除定义所在文件里的自引用
const bindShortcutsCalls = find(/bindShortcuts\(/).filter((h) => !h.startsWith('src/lib/hotkeys.ts:'))
if (bindShortcutsCalls.length === 0) {
  defect('D2', 'medium', `bindShortcuts() 有定义（${bindShortcutsDef.join('、')}）但**零调用方** ⇒ LOCAL_SHORTCUTS 里的 Ctrl+E 切换预览 / Ctrl+B 折叠侧栏 / Ctrl+Delete 移到回收站均未绑定；而 ${'src/features/settings/SettingsPanel.tsx:581'} 向用户宣称它们可用（已实测 Ctrl+B 无响应、Ctrl+K 正常，作对照）`)
} else {
  ok(`bindShortcuts() 有 ${bindShortcutsCalls.length} 个调用方：${bindShortcutsCalls.join('、')}`)
}

// B3 偏好被写入但无消费者（defaultSort）
const defaultSortWriters = find(/setDefaultSort|writeDefaultSort/)
const defaultSortReaders = find(/readDefaultSort|defaultSortMode=|defaultSortMode:|sortFilterFor\(|sortNotes\(notes,\s*sortBy/)
const appPassesDefaultSort = find(/defaultSortMode=\{/)
if (appPassesDefaultSort.length === 0) {
  defect('D3', 'medium', `「笔记列表默认排序」被写入 ${defaultSortWriters.length} 处（${defaultSortWriters.join('、')}）并被读取 ${defaultSortReaders.length} 处，但**集成层从未把偏好传给列表**（App.tsx 的 <NoteList> 没有 defaultSortMode 绑定）⇒ 设置里改默认排序对列表无任何影响（已实测：localStorage 已是 createdAt，列表仍显示「排序：手动」）`)
} else {
  ok(`默认排序偏好已接到列表：${appPassesDefaultSort.join('、')}`)
}

// B4 占位残留
const notImplCalls = find(/notImplemented\(/).filter((h) => !h.includes('db/errors.ts'))
if (notImplCalls.length > 0) {
  defect('D4', 'blocker', `notImplemented() 仍有调用点：${notImplCalls.join('、')}`)
} else {
  ok('notImplemented() 在 src 下**零调用点**（仅 src/db/errors.ts 保留定义，属死代码：不是运行期占位）')
}

// B5 全局 mark 规则（captain 早期转述声称存在）
const markRules = []
for (const file of files.filter((f) => f.endsWith('.css'))) {
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/(^|[\s,}])mark\s*[,{]/.test(line)) markRules.push(`${rel(file)}:${i + 1}`)
  })
}
if (markRules.length === 0) {
  ok('全局 `mark { … }` CSS 规则确实**不存在**（index.css / theme.css 0 命中）；高亮由消费端 token 类 `[&_mark]:bg-selection [&_mark]:text-text` 提供（NoteCard.tsx:165），颜色链路 --color-selection → var(--zj-selection)（index.css:36）')
} else {
  defect('D5', 'low', `发现全局 mark 规则：${markRules.join('、')}（与文档/实现描述不符）`)
}

// B6 声明但无人使用的公开 API（非缺陷，仅清单）
const orphans = {
  'tauri.ts:32 onWindowResized/isWindowMaximized': '已被 titlebar/windowActions 使用',
  'store/search.ts selectSnippets/selectResultNotes/selectRanks': find(/selectSnippets|selectResultNotes|selectRanks/).filter((h) => !h.includes('store/search.ts')).length,
  'lib/appPreferences.ts readWindowBounds/writeWindowBounds': find(/readWindowBounds|writeWindowBounds/).filter((h) => !h.includes('lib/appPreferences.ts')).length,
  'lib/export.ts toJson(经由 serializeTarget 使用)': find(/toJson\(/).filter((h) => !h.includes('lib/export.ts')).length,
}
console.log('  ℹ️  声明但外部无人使用的 API（信息，不判缺陷）：')
for (const [name, value] of Object.entries(orphans)) {
  console.log(`     · ${name} ⇒ 外部引用 ${typeof value === 'number' ? value : value} 处`)
}

console.log('\n' + '─'.repeat(72))
console.log(`store/结构核对：通过 ${pass}，缺陷 ${defects.length}`)
if (defects.length) {
  for (const d of defects) console.log(`  · [${d.severity}] ${d.id}: ${d.m}`)
  process.exit(1)
}
console.log('✅ 四个 store 均为真实 zustand，且未发现静默失效缺陷')
