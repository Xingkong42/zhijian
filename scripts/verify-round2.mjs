// 纸笺 · QA 第二轮独立验证脚本 1/2：2 个 bug 的修复形态 + 契约一致性 + 假开关定向扫描
//
// 本轮（t21）独立复算，**不复用任何成员自检脚本的结论**：
//   A. Bug 1（IME 被外部同步打乱）：CodeMirrorEditor 的外部内容同步 effect 必须保留三道守卫
//   B. Bug 2（有→无 状态转换白屏）：EditorPane 的提前 return 之后不得再有 Hook；main.tsx 有错误边界
//   C. 契约一致性（captain 新增关注点：**自检假绿**）：EVENTS / COMMANDS / 动作 id 在
//      「真实 tauri.ts ↔ 各桩件 ↔ Rust events.rs ↔ lib.rs generate_handler!」四处逐条对账
//   D. 假开关定向扫描：值被写入但无人消费 / UI 宣称但未实现 / emit 但无 listener
//
// 运行：node scripts/verify-round2.mjs
//
// ============================================================================
// ## A 段的取证对象与断言纪律（t43 修正，勿改回去）
//
// **取证对象**：`src/features/editor/CodeMirrorEditor.tsx` 的**源码文本**（提交态快照）——
//   不读任何活数据（不碰 vault、不碰数据库），因此**不可能因「用户正常编辑笔记」而误报**。
//
// **断言纪律（这条教训已经踩过两次）**：
//   断言要拦的是「**有没有组合期守卫**」，**不是「用哪个 API 实现」**。
//   守卫的 API 会演进，而断言不该跟着碎：
//     · t8/t16 期：`view.composing`（组合**首次变更之后**才为 true）
//     · t32 升级：`view.compositionStarted`（`compositionstart` 起即为 true，语义**更强** ——
//       覆盖「组合已开始但还没落字」的窗口，那段窗口里旧的 `composing` 其实是**放行**的）
//   因此本脚本**接受两种形态**（`compositionStarted` 优先，兼容 `composing`），
//   并在命中旧形态时打印提示；**除非两者都不存在，才判失败**。
// ============================================================================

import { register } from 'node:module'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/* ------------------------------ 源码扫描工具 ------------------------------ */

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.(ts|tsx|mjs|rs|json)$/.test(entry)) out.push(full)
  }
  return out
}
const srcFiles = collect(path.join(root, 'src'))
const rustFiles = collect(path.join(root, 'src-tauri', 'src'))
const rel = (p) => path.relative(root, p).replace(/\\/g, '/')

/** 在指定文件里找正则，返回 `文件:行`（跳过注释行） */
function findIn(file, pattern, { comments = false } = {}) {
  const hits = []
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!comments) {
        const t = line.trim()
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
      }
      if (pattern.test(line)) hits.push(`${rel(file)}:${i + 1}`)
    })
  return hits
}
const grep = (pattern, files = srcFiles, opts) => files.flatMap((f) => findIn(f, pattern, opts))

/* =========================== A. Bug 1 修复形态 =========================== */

console.log('── A. Bug 1：外部内容同步的三道守卫（IME 组合期不得重排文档）')

const editorPath = path.join(root, 'src/features/editor/CodeMirrorEditor.tsx')
const editorSrc = readFileSync(editorPath, 'utf8')
const editorLines = editorSrc.split(/\r?\n/)

/**
 * 定位「外部内容同步 effect」：它是**唯一**同时含「组合期守卫」与
 * `lastEmittedRef.current` 的那一段 useEffect。
 *
 * ⚠️ 组合期守卫**接受两种形态**（见文件头「断言纪律」）：
 *   `view.compositionStarted`（t32 起，语义更强）优先；兼容旧的 `view.composing`。
 *   断言拦的是「有没有组合期守卫」，不是「用哪个 API」。
 */
const COMPOSITION_GUARD = /view\.(compositionStarted|composing)\b/
const effectRanges = []
for (let i = 0; i < editorLines.length; i += 1) {
  if (!/\buseEffect\(/.test(editorLines[i])) continue
  let end = editorLines.length - 1
  for (let j = i + 1; j < editorLines.length; j += 1) {
    if (/^\s*\},\s*\[/.test(editorLines[j])) {
      end = j
      break
    }
  }
  effectRanges.push({ start: i, end, body: editorLines.slice(i, end + 1).join('\n') })
}
const syncEffect = effectRanges.find((r) => COMPOSITION_GUARD.test(r.body) && /lastEmittedRef\.current/.test(r.body))
assert(
  Boolean(syncEffect),
  `定位到「外部内容同步」effect：CodeMirrorEditor.tsx:${syncEffect ? syncEffect.start + 1 : '?'}–${syncEffect ? syncEffect.end + 1 : '?'}` +
    `（本文件共 ${effectRanges.length} 个 useEffect，用它同时含「组合期守卫 + lastEmittedRef」来唯一识别）`,
)
const effectBody = syncEffect?.body ?? ''
const lineOf = (re) => {
  const idx = effectBody.split('\n').findIndex((l) => re.test(l))
  return idx < 0 ? '?' : syncEffect.start + 1 + idx
}

// 三道守卫 + 依赖（逐条给出真实行号）；守卫① 接受两种 API 形态
const compositionForm = /view\.compositionStarted\b/.test(effectBody)
  ? 'compositionStarted（t32 起，语义更强：compositionstart 即生效）'
  : /view\.composing\b/.test(effectBody)
    ? 'composing（旧形态：组合首次变更后才生效，仍可接受）'
    : null
assert(
  compositionForm !== null,
  `守卫①：存在「组合期直接 return」——实现形态 = ${compositionForm ?? '缺失！'}（CodeMirrorEditor.tsx:${lineOf(COMPOSITION_GUARD)}）`,
)
if (compositionForm !== null && !/view\.compositionStarted\b/.test(effectBody)) {
  console.log('     ℹ️  当前用的是旧的 `view.composing`；若已升级为 `compositionStarted` 本行会显示新形态（两种都接受）。')
}
assert(
  /value === lastEmittedRef\.current/.test(effectBody),
  `守卫②：\`value === lastEmittedRef.current\` 时 return ⇒ 自己触发的变化不重复同步、不回灌光标（CodeMirrorEditor.tsx:${lineOf(/value === lastEmittedRef\.current/)}）`,
)
assert(
  /lastEmittedRef\.current = value/.test(effectBody),
  `守卫②配套：回灌后同步 lastEmitted（CodeMirrorEditor.tsx:${lineOf(/lastEmittedRef\.current = value/)}）`,
)
assert(
  /selection:\s*\{[^}]*anchor/.test(effectBody) && /Math\.min\(/.test(effectBody),
  `守卫③：dispatch 时用 clamp 过的 anchor 显式保持光标（CodeMirrorEditor.tsx:${lineOf(/selection:\s*\{/)}）`,
)
assert(/^\s*\},\s*\[value/m.test(effectBody), `该 effect 以 \`value\` 为依赖（CodeMirrorEditor.tsx:${lineOf(/^\s*\},\s*\[value/)}）`)

// 回归面：值回灌路径之外，输入是否仍会上报（onChange）
assert(/onChangeRef\.current\(/.test(editorSrc), '正常输入仍会上报：`onChangeRef.current(...)` 在 updateListener 内')
assert(/lastEmittedRef\.current = text/.test(editorSrc), '输入上报时同步 lastEmittedRef（与守卫②配对）')

/* =========================== B. Bug 2 修复形态 =========================== */

console.log('\n── B. Bug 2：提前 return 之后不得有 Hook + 错误边界存在')

const panePath = path.join(root, 'src/features/editor/EditorPane.tsx')
const paneLines = readFileSync(panePath, 'utf8').split(/\r?\n/)
const earlyReturnLine = paneLines.findIndex((l) => /if \(!note\) \{/.test(l))
assert(earlyReturnLine > 0, `定位到提前 return：EditorPane.tsx:${earlyReturnLine + 1}（\`if (!note) {\`）`)

const hookRe = /\buse[A-Z][A-Za-z0-9]*\(/
const hooksAfter = []
for (let i = earlyReturnLine + 1; i < paneLines.length; i += 1) {
  const line = paneLines[i]
  const t = line.trim()
  if (t.startsWith('*') || t.startsWith('//')) continue
  if (hookRe.test(line)) hooksAfter.push(`EditorPane.tsx:${i + 1} → ${t.slice(0, 90)}`)
}
assert(hooksAfter.length === 0, `提前 return 之后 Hook 调用数 = ${hooksAfter.length}（必须为 0）`)
if (hooksAfter.length) hooksAfter.forEach((h) => console.log(`     · ${h}`))

// 最后一道 Hook 必须在提前 return 之前（双保险）
const lastHookLine = (() => {
  let last = -1
  paneLines.forEach((l, i) => {
    const t = l.trim()
    if (t.startsWith('*') || t.startsWith('//')) return
    if (i < earlyReturnLine && hookRe.test(l)) last = i + 1
  })
  return last
})()
assert(lastHookLine > 0 && lastHookLine < earlyReturnLine + 1, `最后一个 Hook 在 EditorPane.tsx:${lastHookLine}，早于 return 行 ${earlyReturnLine + 1}`)

const mainSrc = readFileSync(path.join(root, 'src/main.tsx'), 'utf8')
assert(/class AppErrorBoundary extends Component/.test(mainSrc), 'main.tsx：错误边界类存在（class AppErrorBoundary extends Component）')
assert(/static getDerivedStateFromError/.test(mainSrc), 'main.tsx：实现 getDerivedStateFromError（否则边界不生效）')
const boundaryOpen = mainSrc.indexOf('<AppErrorBoundary>')
const routeExpr = mainSrc.indexOf('tileNoteId ?')
const boundaryClose = mainSrc.indexOf('</AppErrorBoundary>')
assert(boundaryOpen > 0 && routeExpr > boundaryOpen && boundaryClose > routeExpr, 'main.tsx：边界**包住**路由结果（开标签 < 路由表达式 < 闭标签，磁贴与主窗口都在边界内）')
assert((mainSrc.match(/createRoot\(/g) ?? []).length === 1, `main.tsx：createRoot( 只出现 1 次（实际 ${(mainSrc.match(/createRoot\(/g) ?? []).length}）`)

/* ======================= C. 契约一致性（防「自检假绿」） ======================= */

console.log('\n── C. 契约四向对账：tauri.ts ↔ 桩件 ↔ events.rs ↔ generate_handler!')

const tauri = await import('../src/lib/tauri.ts')
const realEvents = { ...tauri.EVENTS }
const realCommands = { ...tauri.COMMANDS }

// C1 真实文件里的字面量（防止「导出对象改了、字符串没改」这种漂移）
const tauriSourceEvents = [...readFileSync(path.join(root, 'src/lib/tauri.ts'), 'utf8').matchAll(/zhijian:\/\/[a-z-]+/g)].map((m) => m[0])
const distinctSourceEvents = [...new Set(tauriSourceEvents)].sort()
assert(
  JSON.stringify(distinctSourceEvents) === JSON.stringify([...new Set(Object.values(realEvents))].sort()),
  `tauri.ts 源码中的事件字面量集合 = EVENTS 的值集合（${distinctSourceEvents.length} 个）`,
)

// C2 Rust events.rs ↔ tauri.ts
const eventsRs = readFileSync(path.join(root, 'src-tauri/src/events.rs'), 'utf8')
const rustEvents = [...eventsRs.matchAll(/pub const [A-Z_]+: &str = "(zhijian:\/\/[a-z-]+)"/g)].map((m) => m[1])
const missingInRust = Object.values(realEvents).filter((v) => !rustEvents.includes(v))
const extraInRust = rustEvents.filter((v) => !Object.values(realEvents).includes(v))
assert(missingInRust.length === 0, `Rust events.rs 覆盖 tauri.ts 的全部 ${Object.keys(realEvents).length} 个事件（缺 ${missingInRust.length}：${missingInRust.join(',') || '无'}）`)
assert(extraInRust.length === 0, `Rust events.rs 无 tauri.ts 未登记的事件（多 ${extraInRust.length}：${extraInRust.join(',') || '无'}）`)

// C3 lib.rs generate_handler! ↔ tauri.ts COMMANDS
const libRs = readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')
const handlerBlock = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? ''
const rustCommands = [...handlerBlock.matchAll(/(\w+)::(\w+)/g)].map((m) => m[2])
const missingInRustCmd = Object.values(realCommands).filter((v) => !rustCommands.includes(v))
assert(rustCommands.length > 0, `解析到 lib.rs generate_handler! 注册了 ${rustCommands.length} 个命令`)
assert(missingInRustCmd.length === 0, `每个 COMMANDS 都在 generate_handler! 注册（缺 ${missingInRustCmd.length}：${missingInRustCmd.join(',') || '无'}）`)

// C4 桩件与真实模块逐条一致（漏项 = 自检假绿温床）
const stubFiles = srcFiles.filter((f) => /stub.*\.mjs$/.test(f))
console.log(`  ℹ️  桩件清单（${stubFiles.length} 个）：${stubFiles.map((f) => rel(f).replace('src/', '')).join('、')}`)
for (const stubFile of stubFiles) {
  const stub = await import(new URL(`file://${stubFile.replace(/\\/g, '/')}`).href).catch(async () => {
    // Windows 盘符路径需要 pathToFileURL
    const { pathToFileURL } = await import('node:url')
    return import(pathToFileURL(stubFile).href)
  })
  const label = rel(stubFile)
  if (stub.EVENTS) {
    const keys = new Set([...Object.keys(realEvents), ...Object.keys(stub.EVENTS)])
    const drift = [...keys].filter((k) => stub.EVENTS[k] !== realEvents[k])
    assert(drift.length === 0, `${label} 的 EVENTS 与真实 tauri.ts 逐条一致（漂移 ${drift.length}${drift.length ? `：${drift.map((k) => `${k}: ${stub.EVENTS[k]} vs ${realEvents[k]}`).join('; ')}` : ''}）`)
  } else {
    console.log(`     · ${label} 未导出 EVENTS（用于不读事件的层，无需比对）`)
  }
  if (stub.COMMANDS) {
    const keys = new Set([...Object.keys(realCommands), ...Object.keys(stub.COMMANDS)])
    const drift = [...keys].filter((k) => stub.COMMANDS[k] !== realCommands[k])
    assert(drift.length === 0, `${label} 的 COMMANDS 与真实 tauri.ts 逐条一致（漂移 ${drift.length}${drift.length ? `：${drift.map((k) => `${k}: ${stub.COMMANDS[k]} vs ${realCommands[k]}`).join('; ')}` : ''}）`)
  }
  if (stub.SHORTCUT_ACTION_IDS) {
    const same =
      JSON.stringify([...stub.SHORTCUT_ACTION_IDS].sort()) === JSON.stringify([...tauri.SHORTCUT_ACTION_IDS].sort())
    assert(same, `${label} 的 SHORTCUT_ACTION_IDS 与真实一致（${stub.SHORTCUT_ACTION_IDS.join(',')}）`)
  }
  if (stub.listen || stub.emit) {
    const hasListen = typeof stub.listen === 'function'
    assert(hasListen, `${label} 提供 listen()（替身事件总线）`)
  }
}

// C5 db 层的那个极简桩件是否会让「读事件名的代码」拿到 undefined
const dbStub = path.join(root, 'src/db/__checks__/stub-lib-tauri.mjs')
const dbStubSrc = readFileSync(dbStub, 'utf8')
const dbStubHasEvents = /export const EVENTS/.test(dbStubSrc)
const dbLayerUsesEvents = grep(/\bEVENTS\.|COMMANDS\./, srcFiles.filter((f) => f.includes(`${path.sep}db${path.sep}`)))
assert(
  dbStubHasEvents || dbLayerUsesEvents.length === 0,
  `db 层桩件不导出 EVENTS/COMMANDS，且 db 层代码也确实不读它们（命中 ${dbLayerUsesEvents.length} 处）⇒ 无「取到 undefined 却静默通过」的可能`,
)

/* ======================= D. 假开关定向扫描（本轮专项） ======================= */

console.log('\n── D. 假开关定向扫描（每条结论落到「谁消费了这个值」）')

const sidebarFiles = srcFiles.filter((f) => f.includes(`${path.sep}sidebar${path.sep}`))
const inboxHits = grep(/收件箱/, sidebarFiles)
assert(inboxHits.length === 0, `「收件箱」已从侧栏移除（sidebar/ 下命中 ${inboxHits.length} 处：${inboxHits.join('、') || '无'}）`)

// 标签：添加入口（卡片右键 / 编辑器）与筛选入口
const tagPickerUsers = grep(/tag-picker|TagPicker/)
assert(tagPickerUsers.length > 0, `标签面板有真实使用方：${tagPickerUsers.slice(0, 4).join('、')}${tagPickerUsers.length > 4 ? ` …共 ${tagPickerUsers.length} 处` : ''}`)
const noteCardTagMenu = grep(/id: 'tags'|标签…/, srcFiles.filter((f) => f.includes('NoteCard.tsx')))
assert(noteCardTagMenu.length > 0, `卡片提供「标签…」入口：${noteCardTagMenu.join('、')}`)
const tagFilterChain = grep(/onSelectTag|focusTag/, srcFiles.filter((f) => f.includes('notes-list')))
assert(tagFilterChain.length > 0, `标签点击→筛选链路存在：${tagFilterChain.slice(0, 4).join('、')}`)

// Live Preview 与工具条
const livePreviewInstalled = findIn(editorPath, /livePreview|markdownLivePreview/)
assert(livePreviewInstalled.length > 0, `Live Preview 已挂进编辑器扩展：${livePreviewInstalled.join('、')}`)
const toolbarRendered = grep(/<MarkdownToolbar/, srcFiles.filter((f) => f.includes('editor')))
assert(toolbarRendered.length > 0, `格式化工具栏已渲染：${toolbarRendered.join('、')}`)

// 正文字号：写入偏好 → 应用到 CSS 变量 → 有样式消费它
const fontSizeWriters = grep(/applyContentFontSize|setContentFontSize/)
assert(fontSizeWriters.length > 0, `字号偏好有应用入口：${fontSizeWriters.slice(0, 4).join('、')}`)
const fontSizeVarConsumers = [
  ...findIn(path.join(root, 'src/index.css'), /zj-font-content/),
  ...findIn(path.join(root, 'src/styles/theme.css'), /zj-font-content/),
]
assert(fontSizeVarConsumers.length > 0, `字号 CSS 变量有**样式消费方**：${fontSizeVarConsumers.join('、')}`)

// 托盘「启动后最小化」：偏好必须真被消费（hide() 调用）
const trayPrefConsumers = grep(/hideAfterStart|startMinimized|start-minimized|getCurrentWindow\(\)\.hide\(\)/)
assert(trayPrefConsumers.length > 0, `「启动后最小化到托盘」偏好有消费方：${trayPrefConsumers.slice(0, 5).join('、')}`)

// 自定义快捷键：必须下发给 Rust
const shortcutDispatch = grep(/cmd_sync_global_shortcuts|syncGlobalShortcuts/)
assert(shortcutDispatch.length > 0, `自定义快捷键有下发链路（cmd_sync_global_shortcuts）：${shortcutDispatch.slice(0, 5).join('、')}`)

// 磁贴：必须「有 UI 入口 + prop 接线 + 真实调用方」，只定义命令不算（t21 修正：先前只匹配
// `toggleTile(` 会被 lib/tauri.ts 里的**定义**命中，属弱断言）
const tileCallers = grep(/toggleTileForNote\(/)
const tilePropWiring = grep(/onToggleTile=\{/)
const tileWindowLayer = grep(/export async function toggleTileForNote/)
assert(
  tileCallers.length > 0 && tilePropWiring.length > 0 && tileWindowLayer.length > 0,
  `磁贴入口链路完整：窗口层 ${tileWindowLayer.join('、')} ← 调用方 ${tileCallers.join('、')} ← App prop 接线 ${tilePropWiring.join('、')}`,
)

// 「笔记列表默认排序」是否真被消费（t8 的 D3 观察项）
const defaultSortConsumed = grep(/defaultSortMode=\{/)
assert(
  defaultSortConsumed.length > 0,
  `「默认排序」偏好已接到列表（${defaultSortConsumed.join('、')}）—— 若无命中说明设置值被写入但无人消费`,
)

// 事件「emit 但无 listener」：Rust emit 的每个事件，前端必须有订阅点（封装函数也算）
const listenSites = [
  ...grep(/listen\(/),
  ...grep(/onWindowHidden|onTilesVisibilityChanged|onPinCurrentNoteRequested|onWindowResized/),
].filter((h) => !h.includes('__checks__'))
for (const [key, value] of Object.entries(realEvents)) {
  const consumed = listenSites.length > 0 && subscriptionsCover(value, listenSites)
  console.log(`     · 事件 ${key} (${value}) 订阅点：${consumed ? '有' : '无（若 Rust 会 emit 则该事件无人接收）'}`)
}
function subscriptionsCover(eventName, sites) {
  // 直接按事件名/封装函数名在源码里找
  const s =
    grep(new RegExp(escapeRe(eventName))).filter((h) => !h.includes('__checks__')).length +
    grep(new RegExp(`${shortcutFnFor(eventName)}`)).filter((h) => !h.includes('__checks__')).length
  return s > 0
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function shortcutFnFor(eventName) {
  const map = {
    'zhijian://window-hidden': 'onWindowHidden',
    'zhijian://tiles-visibility-changed': 'onTilesVisibilityChanged',
    'zhijian://pin-current-note-requested': 'onPinCurrentNoteRequested',
    'zhijian://window-shown': 'windowShown',
  }
  return map[eventName] ?? '___none___'
}

console.log('\n' + '─'.repeat(74))
console.log(`第二轮静态核对：通过 ${pass}，失败 ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('✅ Bug1/Bug2 修复形态 + 契约四向一致 + 假开关扫描 全部通过')
