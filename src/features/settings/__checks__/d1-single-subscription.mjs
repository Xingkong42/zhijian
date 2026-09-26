#!/usr/bin/env node
/**
 * 纸笺 · D1 防复发断言：同一事件的 `listen()` 全仓只允许 1 处
 * ============================================================================
 * 运行：node src/features/settings/__checks__/d1-single-subscription.mjs
 *      （exit 0 = 通过；非 0 = 命中重复订阅）
 *
 * ## 为什么必须有这个文件（t31 的核心产出）
 * 「一次 Alt+N 建出两条笔记」这个缺陷：
 *   · **t9 修过一次**（删除 App 侧对热键事件的重复订阅）；
 *   · **t17 之后又静默回归**（`shortcuts.ts` 对同样两个事件各订阅一次）；
 *   · 两次都是"修完就完"，**没有配套的防复发检查** ⇒ 所以修了第二次。
 * 本文件把规则做成**可执行断言**，从此这类回归会在自检阶段被拦住。
 *
 * ## 两层断言（缺一不可）
 *   A. **静态**：扫描全仓 `listen(EVENTS.<name>)`，同一事件名**只允许出现 1 处**
 *      （覆盖"代码里两处独立订阅"这类形态）；
 *   B. **运行时**：真实调用 `bindGlobalHotkeys()`（App.tsx 实际挂载的那个），
 *      然后**派发一次事件**，断言动作**恰好执行 1 次**。
 *      —— 这一层能抓到静态扫描抓不到的形态：**同一次挂载内部**注册了两遍、
 *      或某个模块自己又订阅了一遍而调用点写法不同。
 *
 * 历史证据（t31 修复前实测）：派发一次 `newNoteRequested` → 动作执行 **2** 次。
 * 修复后 → **1** 次。
 */

import { register } from 'node:module'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..', '..')
const srcRoot = path.join(projectRoot, 'src')

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, error: message })
    console.log(`  ❌ ${name}\n     ↳ ${message}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* ---------- 1) 注册解析钩子（复用设置套件的 loader，外加 event 替身） ---------- */

const dbChecks = path.join(srcRoot, 'db', '__checks__')
const stubDir = here
register(pathToFileURL(path.join(here, 'loader.mjs')).href, import.meta.url, {
  data: {
    dbStubDir: dbChecks,
    dialogStub: path.join(stubDir, 'stub-plugin-dialog.mjs'),
    fsStub: path.join(stubDir, 'stub-plugin-fs.mjs'),
    tauriStub: path.join(stubDir, 'stub-lib-tauri.mjs'),
    openerStub: path.join(stubDir, 'stub-plugin-opener.mjs'),
    eventStub: path.join(stubDir, 'stub-api-event.mjs'),
    srcRoot,
  },
})

/* ---------- 1b) 伪造浏览器/Tauri 运行时（**必须在 import 之前**） ----------
 * `src/lib/tauri.ts` 的 `isTauri` 是**模块求值时**计算的：
 *     typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
 * 它**不是**从 `@/lib/tauri` 替身读的（那份 `isTauri` 只供别的替身模块用）。
 * Node 里没有 `window` ⇒ 不设就会得到 `isTauri === false` ⇒ `bindGlobalHotkeys`
 * 走浏览器回退分支、一个事件都不订阅，运行时断言会"静默空跑"（我第一版就踩了）。
 * 所以这里必须补一个最小 `window`，否则 B 组断言毫无意义。
 */
const windowListeners = new Map()
globalThis.window = {
  __TAURI_INTERNALS__: {},
  addEventListener(type, handler) {
    const set = windowListeners.get(type) ?? new Set()
    set.add(handler)
    windowListeners.set(type, set)
  },
  removeEventListener(type, handler) {
    windowListeners.get(type)?.delete(handler)
  },
  dispatchEvent() {
    return true
  },
  location: { origin: 'http://localhost', pathname: '/' },
}
globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener() {},
  registerListener() {},
}

/* ============================ A. 静态扫描 ============================ */

console.log('\n── A. 静态：全仓 `listen(EVENTS.<name>)` 同一事件只允许 1 处')

/** 递归收集 src 下的 .ts / .tsx（跳过自检桩件与自检脚本本身） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 提取形如 `listen(EVENTS.xxx,` / `listen<Payload>(EVENTS.xxx,` 的调用。
 * 只认**带事件名的真实调用**；注释里的文字（如本文件的说明）不会匹配到 `listen(` 调用形态。
 */
function collectListenCalls() {
  const calls = []
  for (const file of walk(srcRoot)) {
    if (file.endsWith('__checks__')) continue
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/')
    if (rel.includes('__checks__')) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      // 跳过整行注释（避免把文档里写的示例当成真实调用）
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
      const match = line.match(/listen\s*(?:<[^>]*>)?\s*\(\s*EVENTS\.(\w+)/)
      if (match) calls.push({ event: match[1], file: rel, line: index + 1 })
    })
  }
  return calls
}

const listenCalls = collectListenCalls()

check('扫描到全仓 listen(EVENTS.*) 调用点（非空，防止断言空跑）', () => {
  assert(
    listenCalls.length > 0,
    '一个 listen 调用都没扫到 —— 断言可能是空跑（检查正则或路径）',
  )
  console.log(`     扫描到 ${listenCalls.length} 处：`)
  for (const call of listenCalls) console.log(`       · EVENTS.${call.event}  ${call.file}:${call.line}`)
})

check('同一事件名的 listen() 调用点恰好 1 处（D1 防复发）', () => {
  const byEvent = new Map()
  for (const call of listenCalls) {
    const list = byEvent.get(call.event) ?? []
    list.push(call)
    byEvent.set(call.event, list)
  }
  const duplicated = [...byEvent.entries()].filter(([, list]) => list.length > 1)
  assert(
    duplicated.length === 0,
    '以下事件被订阅了多次（这会让一次按键触发多次动作）：\n' +
      duplicated
        .map(
          ([event, list]) =>
            `       · EVENTS.${event} × ${list.length}\n` +
            list.map((c) => `           - ${c.file}:${c.line}`).join('\n'),
        )
        .join('\n') +
      '\n     ↳ 修法：同一事件只保留一处订阅。热键类事件（newNoteRequested / openSettingsRequested /\n' +
      '       toggleWindowRequested / appQuitRequested）的**唯一订阅方是 src/lib/hotkeys.ts 的\n' +
      '       bindGlobalHotkeys()**（由 App.tsx 挂载）；settings/shortcuts.ts 只做键位解析/校验/\n' +
      '       持久化/下发，**不得再 listen**（见该文件里的 ⛔ 注释，t31 教训）。',
  )
})

check('热键类事件仍在 hotkeys.ts 订阅（删除时不得把整条通道删空）', () => {
  const hotkeys = readFileSync(path.join(srcRoot, 'lib', 'hotkeys.ts'), 'utf8')
  for (const event of ['newNoteRequested', 'openSettingsRequested']) {
    assert(
      new RegExp(`listen\\(EVENTS\\.${event}`).test(hotkeys),
      `hotkeys.ts 必须保留 EVENTS.${event} 的订阅 —— 它由 App.tsx 挂载，是唯一订阅方；\n` +
        `     若这里没了，Alt+N 将完全失效（比双订阅更严重的功能缺失）。`,
    )
  }
  assert(
    /listen\(EVENTS\.appQuitRequested/.test(hotkeys),
    'hotkeys.ts 必须保留 EVENTS.appQuitRequested 订阅（没有其它地方订阅它）',
  )
})

check('浏览器开发态回退的 keydown 绑定未被连带删除', () => {
  const hotkeys = readFileSync(path.join(srcRoot, 'lib', 'hotkeys.ts'), 'utf8')
  assert(
    /if \(!isTauri\)/.test(hotkeys) && /addEventListener\('keydown'/.test(hotkeys),
    'hotkeys.ts 的浏览器回退（!isTauri 时的 window keydown）必须保留，否则 pnpm dev 下 Alt+N 失效',
  )
})

check('shortcuts.ts 明确标注"不得在此 listen"（把教训留在代码里）', () => {
  const source = readFileSync(path.join(srcRoot, 'features', 'settings', 'shortcuts.ts'), 'utf8')
  assert(
    /不要在本模块里\s*`listen\(\)`/.test(source),
    'shortcuts.ts 必须保留 ⛔ 注释，说明本模块不得订阅事件（否则后人会把订阅加回来）',
  )
  assert(
    !/^\s*const\s+\w+\s*=\s*listen\(/m.test(source) && !/listen\(EVENTS\./.test(source.replace(/^\s*\*.*$/gm, '')),
    'shortcuts.ts 里不应再出现真实的 listen(EVENTS.*) 调用',
  )
})

/* ============================ B. 运行时派发 ============================ */

console.log('\n── B. 运行时：派发一次事件 → 动作恰好执行 1 次')

const eventStub = await import(pathToFileURL(path.join(stubDir, 'stub-api-event.mjs')).href)
const { bindGlobalHotkeys } = await import('@/lib/hotkeys.ts')

async function runtimeDispatch() {
  eventStub.resetEventStub()
  const fired = { newNote: 0, openSettings: 0, quit: 0 }
  const unbind = bindGlobalHotkeys({
    newNote: () => {
      fired.newNote += 1
    },
    openSettings: () => {
      fired.openSettings += 1
    },
  })
  // 等异步订阅完成（bindGlobalHotkeys 内部是 void (async () => { await listen... })）
  for (let i = 0; i < 40 && eventStub.registrationsFor('zhijian://new-note-requested').length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await new Promise((r) => setTimeout(r, 50))

  const listenersForNewNote = eventStub.listenerCount('zhijian://new-note-requested')
  eventStub.emitEvent('zhijian://new-note-requested', null)
  eventStub.emitEvent('zhijian://open-settings-requested', null)
  await new Promise((r) => setTimeout(r, 50))
  unbind()
  return { fired, listenersForNewNote }
}

const runtime = await runtimeDispatch()

check('一次挂载后，`newNoteRequested` 只有 1 个监听器', () => {
  assert(
    runtime.listenersForNewNote === 1,
    `实际注册了 ${runtime.listenersForNewNote} 个监听器 —— 一次 Alt+N 会触发 ${runtime.listenersForNewNote} 次动作`,
  )
})

check('⭐ 派发一次 newNoteRequested → 动作恰好执行 1 次（D1 的直接复现式断言）', () => {
  assert(
    runtime.fired.newNote === 1,
    `动作执行了 ${runtime.fired.newNote} 次（期望 1）—— 这就是「一次 Alt+N 建两条笔记」的机器化判定。\n` +
      '     ↳ t31 修复前实测为 2（shortcuts.ts 与 hotkeys.ts 各订阅一次）。',
  )
})

check('⭐ 派发一次 openSettingsRequested → 动作恰好执行 1 次', () => {
  assert(
    runtime.fired.openSettings === 1,
    `动作执行了 ${runtime.fired.openSettings} 次（期望 1）`,
  )
})

check('退订后监听器归零（不泄漏、也不留下幽灵订阅）', () => {
  assert(
    eventStub.listenerCount('zhijian://new-note-requested') === 0,
    `退订后仍有 ${eventStub.listenerCount('zhijian://new-note-requested')} 个监听器残留`,
  )
})

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`,
)
if (failed.length > 0) {
  console.log('\nD1 回归命中（一次按键会触发多次动作）：')
  for (const item of failed) console.log(`   - ${item.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
