#!/usr/bin/env node
/**
 * 纸笺 · 磁贴 ⇄ 主窗口 **双向实时同步** 运行时探针（t44）
 * ============================================================================
 * 运行：node scripts/probe-tile-sync.mjs        （或 `pnpm probe:tile-sync`）
 *      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）
 *
 * ## 这条探针回答用户的原话
 * 「在笔记中新输入的文字不能实时反馈到磁贴，需要将磁贴关闭后再次打开才能出现新输入的文字，
 *   同样的，在磁贴中输入文字也不能反馈到笔记当中，我觉得这是个问题，**你可以验证**」
 *
 * 静态门只能证明"广播/订阅的代码接上了"（`check:contract` 第 6 节 7 条断言 + 8 个变异测试），
 * 证明不了"两个真实 WebView 之间真的同步了" —— 而这正是用户要的验证。
 * 本探针用 CDP 同时驱动**两个窗口**：在一边真敲字，在另一边真读 DOM。
 *
 * ## 为什么必须真机
 * 同步的失败模式全是"看起来没事"：事件名漂移、桩件漏项、监听没建立、
 * 采纳判据把真外部改动挡掉（`locallyEdited` 那道单调闸门就是 t44 修的对象）。
 * 这些在编译、typecheck、静态断言下**全绿**（快的探针已经实证过一次：
 * `cmd_open_quick_note` 写成同步命令 ⇒ 死锁，而所有静态门都绿）。
 *
 * ## 数据安全：**探针自己造笔记、自己删干净**
 * 第一版想用 vault 里的 `无标题-*.md` 当靶子，结果那些都在 `.trash/`（不在应用列表里）。
 * 剩下的 `随机测试.md` / `造父变星.md` 可能是用户正文 ⇒ **一概不碰**。
 * 现在的做法：用**快速笔记**（另一条已证实的端到端路径）建一条 `SYNCPROBE-<时间戳>` 笔记，
 * 全程只动它；收尾时把它连同索引行一起删除，并断言 vault 的 md 数量复原。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const appDataDir = path.join(process.env.APPDATA ?? '', 'com.zhijian.app')
const dbPath = path.join(appDataDir, 'zhijian.db')
const CDP_PORT = 9223
const STAMP = Date.now()
const BASE = `SYNCPROBE-${STAMP}`
const MARK_NOTE_TO_TILE = `SYNC-FROM-NOTE-${STAMP}`
const MARK_TILE_TO_NOTE = `SYNC-FROM-TILE-${STAMP}`

const notes = []
const failures = []
const ok = (m) => {
  console.log(`  ✅ ${m}`)
  notes.push(`OK   ${m}`)
}
const fail = (m) => {
  console.log(`  ❌ ${m}`)
  notes.push(`FAIL ${m}`)
  failures.push(m)
}
const info = (m) => console.log(`  ℹ️  ${m}`)
const assert = (condition, okMessage, failMessage) => (condition ? ok(okMessage) : fail(failMessage))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function resolveDocumentsDir() {
  const result = spawn('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  result.stdout.on('data', (chunk) => (out += chunk))
  return new Promise((resolve) => result.on('close', () => resolve(out.trim() || path.join(os.homedir(), 'Documents'))))
}

const vaultRoot = path.join(await resolveDocumentsDir(), '纸笺')

async function run(command) {
  const child = spawn('powershell', ['-NoProfile', '-Command', command], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  await new Promise((resolve) => child.on('close', resolve))
  return out.trim()
}

async function listTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')))
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (pending.delete(id)) rejectSend(new Error(`CDP 超时：${method}`))
            }, 20000)
          })
        },
        close() {
          try {
            socket.close()
          } catch {
            /* 忽略 */
          }
        },
      }),
    )
  })
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '页面内求值抛错')
  return result.result?.value
}

const waitForTarget = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(700)
    const found = (await listTargets()).find(predicate)
    if (found) return found
  }
  return null
}

const readEditor = (client) => evaluate(client, `(document.querySelector('.cm-content')?.innerText || '')`)

/**
 * 把某个窗口**变成 OS 级前台窗口**，并核对该窗口的 `document.hasFocus()`。
 *
 * 为什么必须做：t44 的两条接收侧守卫都是按「本窗口有没有焦点」判断"用户是不是正在这里打字"
 * （焦点独占 ⇒ 有焦点就说明用户在这边）。探针若不做这一步，"我正在敲字的那个窗口"其实
 * 在 OS 层面并没有焦点 —— 守卫会按真实语义正确地拒绝同步，而探针会把**正确行为**判成缺陷。
 * 第一版就是这样误报的（磁贴创建时 `focused(true)`，OS 焦点一直在磁贴上）。
 */
async function focusWindow(client) {
  const label = await evaluate(client, `window.__TAURI_INTERNALS__.metadata.currentWindow.label`)
  await evaluate(
    client,
    `window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: ${JSON.stringify(label)} }).then(() => true).catch((e) => 'ERR:' + e)`,
  )
  await sleep(800)
  return { label, focused: await evaluate(client, `document.hasFocus()`) }
}

/**
 * 像真人一样往 CodeMirror 里敲字：逐字符 `char` 事件（不是整段 insertText）。
 *
 * 第一版用 `Input.insertText` 整段插入：DOM 上确实出现了文本，但**CodeMirror 的状态与
 * 自动保存都没有动**（`onChange` 不触发 ⇒ 不落库 ⇒ 当然什么都不可能同步）。
 * 那种"看起来敲进去了"的假象正是本探针要避免的：**必须用真实按键路径**。
 * 换行用真实的 Enter 键（CM 自己插入换行），而不是文本里的 `\n`。
 */
async function typeIntoCM(client, text) {
  await evaluate(client, `(() => { const el = document.querySelector('.cm-content'); el.focus(); return true })()`)
  for (const char of text) {
    if (char === '\n') {
      await pressKey(client, 'Enter', 'Enter', 13)
    } else {
      await client.send('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char })
    }
    await sleep(35)
  }
}

async function pressKey(client, key, code, virtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: virtualKeyCode })
  }
}

/* ------------------------------ 环境前置 ------------------------------ */

console.log('纸笺 · 磁贴 ⇄ 主窗口 双向同步探针（t44 端到端）')
console.log(`  vault : ${vaultRoot}`)
console.log('')

if (process.platform !== 'win32') {
  console.log('  ⚠️ 依赖 Windows WebView2 的 CDP 端口，仅支持 win32。')
  process.exit(2)
}
if (await run('Get-Process zhijian -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id')) {
  console.log('  ⚠️ 已有 zhijian 在跑 —— 不做任何操作。')
  process.exit(2)
}
if (!existsSync(vaultRoot)) {
  console.log(`  ⚠️ 找不到 vault：${vaultRoot}`)
  process.exit(2)
}

const mdCountBefore = readdirSync(vaultRoot, { recursive: true }).filter((name) => String(name).endsWith('.md')).length
let dev = null
let main = null
let quick = null
let tile = null
let createdFile = null
let createdId = null

try {
  info('启动 pnpm tauri:dev（CDP 端口 ' + CDP_PORT + '）…')
  const inner =
    `cd '${repoRoot}'; ` +
    `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; ` +
    `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility --remote-debugging-port=${CDP_PORT}'; ` +
    `pnpm tauri:dev *>&1 | Tee-Object -FilePath '${path.join(os.tmpdir(), 'zj-probe-tile-sync.log')}'`
  dev = spawn('pwsh', ['-NoProfile', '-Command', inner], { stdio: 'ignore' })

  const mainTarget = await waitForTarget(
    (t) => t.type === 'page' && !/[?&](tile|quick)=/.test(t.url ?? '') && /localhost:1420|tauri:\/\/localhost/.test(t.url ?? ''),
    240_000,
  )
  assert(Boolean(mainTarget), 'A. 应用已启动（主窗口出现在 CDP 目标里）', 'A. 等不到主窗口')
  if (!mainTarget) throw new Error('no main target')

  main = await connect(mainTarget.webSocketDebuggerUrl)
  await main.send('Runtime.enable')
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(main, `!!(window.__TAURI_INTERNALS__ && document.querySelector('[data-note-id]'))`).catch(() => false)) break
    await sleep(500)
  }

  /* -------- 1) 造一条只属于探针的笔记（走"快速笔记"这条真实路径） -------- */

  const opened = await evaluate(main, `window.__TAURI_INTERNALS__.invoke('cmd_open_quick_note').then(() => true).catch((e) => 'ERR:' + e)`)
  assert(opened === true, 'B1. 快速笔记窗口已打开（顺便二次验证 t44 的另一条链路）', `B1. 打开快速笔记失败：${opened}`)
  const quickTarget = await waitForTarget((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''), 20_000)
  assert(Boolean(quickTarget), 'B2. 捕捉框窗口出现', 'B2. 没等到捕捉框窗口')
  if (!quickTarget) throw new Error('no quick target')

  quick = await connect(quickTarget.webSocketDebuggerUrl)
  await quick.send('Runtime.enable')
  await sleep(2000)
  // 捕捉框是原生 textarea：`insertText` + Enter 已在 `probe:quick-note` 里验证过可靠
  await evaluate(quick, `(() => { const el = document.querySelector('textarea[data-zj-quick-note-input]'); el.focus(); return true })()`)
  await quick.send('Input.insertText', { text: BASE })
  await sleep(300)
  await pressKey(quick, 'Enter', 'Enter', 13)

  let createdName = null
  for (let i = 0; i < 25 && !createdName; i += 1) {
    await sleep(600)
    createdName = readdirSync(vaultRoot, { recursive: true })
      .map(String)
      .find((name) => name.endsWith('.md') && readFileSync(path.join(vaultRoot, name), 'utf8').includes(BASE))
  }
  assert(Boolean(createdName), `B3. 探针笔记已创建：${createdName}`, 'B3. 捕捉框没有创建出笔记')
  if (!createdName) throw new Error('probe note not created')
  createdFile = path.join(vaultRoot, createdName)
  const rawCreated = readFileSync(createdFile, 'utf8')
  createdId = rawCreated.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? null
  assert(Boolean(createdId), `B4. 拿到探针笔记 id：${createdId}`, 'B4. 探针笔记 front-matter 里没有 id')
  if (!createdId) throw new Error('probe note has no id')

  /* -------- 2) 主窗口：列表里出现这条笔记，且点开能编辑它 -------- */

  let cardFound = false
  for (let i = 0; i < 20 && !cardFound; i += 1) {
    cardFound = await evaluate(main, `!!document.querySelector('[data-note-id="${createdId}"]')`)
    if (!cardFound) await sleep(600)
  }
  assert(
    cardFound,
    'C. **主窗口列表自动出现新笔记**（跨窗口广播生效，无需重启）',
    'C. 主窗口列表里没有出现探针笔记 —— 说明 create 的广播/刷新没生效',
  )
  if (cardFound) {
    const point = JSON.parse(
      await evaluate(
        main,
        `(() => { const el = document.querySelector('[data-note-id="${createdId}"]'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`,
      ),
    )
    for (const type of ['mousePressed', 'mouseReleased']) {
      await main.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
    await sleep(2000)
  }
  const editorText = await readEditor(main)
  assert(
    editorText.includes(BASE),
    'D. 主窗口编辑器已切到探针笔记（内容匹配）',
    `D. 主窗口编辑器内容不含探针标记：${JSON.stringify(editorText.slice(0, 80))}`,
  )

  /* -------- 3) 钉成磁贴 -------- */

  const pinned = await evaluate(main, `window.__TAURI_INTERNALS__.invoke('cmd_toggle_tile', { noteId: '${createdId}' }).then((v) => v).catch((e) => 'ERR:' + e)`)
  assert(pinned === true, 'E1. 探针笔记已钉成磁贴', `E1. 钉磁贴失败：${pinned}`)
  const tileTarget = await waitForTarget((t) => t.type === 'page' && (t.url ?? '').includes(createdId), 20_000)
  assert(Boolean(tileTarget), 'E2. 磁贴窗口出现（`?tile=<探针笔记>`）', 'E2. 没等到磁贴窗口')
  if (!tileTarget) throw new Error('no tile target')

  tile = await connect(tileTarget.webSocketDebuggerUrl)
  await tile.send('Runtime.enable')
  await sleep(2500)
  assert(
    (await readEditor(tile)).includes(BASE),
    'E3. 磁贴初始内容与笔记一致（同步起点正确）',
    `E3. 磁贴初始内容不对：${JSON.stringify((await readEditor(tile)).slice(0, 80))}`,
  )

  /* -------- 4) 主窗口 → 磁贴（用户报的那一半） -------- */

  const mainFocus = await focusWindow(main)
  assert(mainFocus.focused, 'F0. 主窗口已是前台窗口（同步守卫的前提：焦点在"正在输入"的这一侧）', 'F0. 主窗口拿不到焦点，探针前提不成立（结果不可信）')
  await typeIntoCM(main, `\n${MARK_NOTE_TO_TILE}`)
  await sleep(4500) // 防抖 + 落库 + 广播 + 对面重读

  // 先确认这次输入**真的到了 md 真相源**：
  // 否则失败原因是"探针没敲进去"，而不是"同步坏了" —— 这两种必须能区分。
  const mdAfterNoteEdit = readFileSync(createdFile, 'utf8')
  assert(
    mdAfterNoteEdit.includes(MARK_NOTE_TO_TILE),
    'F1. 主窗口的输入已落库到 md（自动保存链路正常，因此后面的失败只可能是同步）',
    'F1. 主窗口的输入没进 md —— 说明探针的按键没有触发自动保存（本探针的输入方式有问题，不是应用缺陷）',
  )
  const tileAfterNoteEdit = await readEditor(tile)
  assert(
    tileAfterNoteEdit.includes(MARK_NOTE_TO_TILE),
    'F2. **主窗口输入实时出现在磁贴里**（无需关闭重开）—— 用户报的缺陷已修复',
    `F2. 主窗口输入没同步到磁贴（磁贴尾 100 字：${JSON.stringify(tileAfterNoteEdit.slice(-100))}）`,
  )

  /* -------- 5) 磁贴 → 主窗口（另一半） -------- */

  const tileFocus = await focusWindow(tile)
  assert(tileFocus.focused, 'G0. 磁贴已是前台窗口（反向同步的前提）', 'G0. 磁贴拿不到焦点，反向断言前提不成立')
  assert(
    !(await evaluate(main, `document.hasFocus()`)),
    'G1. 焦点确实独占（主窗口此刻报告未聚焦 —— 这正是守卫放行同步的条件）',
    'G1. 两个窗口同时报告有焦点，探针的焦点前提不成立（结论不可信）',
  )
  await typeIntoCM(tile, `\n${MARK_TILE_TO_NOTE}`)
  await sleep(4500)

  const mdAfterTileEdit = readFileSync(createdFile, 'utf8')
  assert(
    mdAfterTileEdit.includes(MARK_TILE_TO_NOTE),
    'G2. 磁贴的输入已落库到 md',
    'G2. 磁贴的输入没进 md（同上：先怀疑输入方式）',
  )
  const editorAfterTileEdit = await readEditor(main)
  assert(
    editorAfterTileEdit.includes(MARK_TILE_TO_NOTE),
    'G3. **磁贴输入实时出现在主窗口笔记里**（反向同样成立）',
    `G3. 磁贴输入没同步到主窗口（编辑器尾 100 字：${JSON.stringify(editorAfterTileEdit.slice(-100))}）`,
  )
  // 两边的最终内容必须一致（不是各自一份各说各话）
  const tileFinal = await readEditor(tile)
  assert(
    tileFinal.includes(MARK_NOTE_TO_TILE) && tileFinal.includes(MARK_TILE_TO_NOTE),
    'H. 两个窗口最终收敛到同一份内容（双向都不是单向覆盖）',
    `H. 两边内容没有收敛：磁贴尾 100 字 = ${JSON.stringify(tileFinal.slice(-100))}`,
  )

  /* -------- 6) 取消钉住 -------- */

  const unpinned = await evaluate(main, `window.__TAURI_INTERNALS__.invoke('cmd_toggle_tile', { noteId: '${createdId}' }).then((v) => v).catch((e) => 'ERR:' + e)`)
  await sleep(2500)
  const stillThere = (await listTargets()).some((t) => t.type === 'page' && (t.url ?? '').includes(createdId))
  assert(unpinned === false && !stillThere, 'I. 取消钉住后磁贴窗口关闭', `I. 取消钉住异常：返回值 ${unpinned}，窗口仍在=${stillThere}`)
} catch (error) {
  fail(`探针执行中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  main?.close()
  quick?.close()
  tile?.close()
  try {
    await run('Get-Process zhijian -ErrorAction SilentlyContinue | Stop-Process -Force')
  } catch {
    /* 忽略 */
  }
  if (dev && dev.exitCode === null) {
    try {
      dev.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
  await sleep(2500)
  const owners = await run('(Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue).OwningProcess')
  for (const pid of owners.split(/\s+/).filter(Boolean)) {
    await run(`Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`)
  }

  /* 删除探针自己创建的笔记：md + 索引行一起删（md 是真相源，两边同删 = 从未存在） */
  if (createdFile && existsSync(createdFile)) {
    try {
      unlinkSync(createdFile)
      ok('J1. 已删除探针创建的 md（vault 复原）')
    } catch (error) {
      fail(`J1. 删除探针 md 失败：${error.message}`)
    }
  }
  if (createdId && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath)
      const tags = db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(createdId)
      const row = db.prepare('DELETE FROM notes WHERE id = ?').run(createdId)
      db.close()
      ok(`J2. 已删除索引行（notes ${row.changes} / note_tags ${tags.changes}）`)
    } catch (error) {
      fail(`J2. 清理索引失败（下次启动会按 md 真相源自愈）：${error.message}`)
    }
  }
  if (!createdFile) {
    // 兜底：万一 md 建出来了但探针没记下路径
    try {
      const stray = readdirSync(vaultRoot, { recursive: true })
        .map(String)
        .filter((name) => name.endsWith('.md') && readFileSync(path.join(vaultRoot, name), 'utf8').includes(BASE))
      for (const name of stray) {
        unlinkSync(path.join(vaultRoot, name))
        writeFileSync(path.join(os.tmpdir(), 'zj-probe-tile-sync-stray.txt'), name)
        info(`兜底清理：删除了残留的 ${name}`)
      }
    } catch (error) {
      fail(`兜底清理失败：${error.message}`)
    }
  }

  const mdCountAfter = readdirSync(vaultRoot, { recursive: true }).filter((name) => String(name).endsWith('.md')).length
  assert(mdCountAfter === mdCountBefore, `K. vault 的 md 数量复原（${mdCountBefore} → ${mdCountAfter}）`, `K. md 数量没复原（${mdCountBefore} → ${mdCountAfter}）`)
}

console.log('')
console.log('════════════════ 汇总 ════════════════')
for (const line of notes) console.log(`  ${line}`)
if (failures.length === 0) {
  console.log('\n✅ 磁贴同步探针：全部断言通过')
  process.exit(0)
}
console.log(`\n❌ 磁贴同步探针失败 ${failures.length} 项：`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
