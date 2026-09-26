#!/usr/bin/env node
/**
 * 纸笺 · 快速笔记运行时探针（t44）
 * ============================================================================
 * 运行：node scripts/probe-quick-note.mjs          （或 `pnpm probe:quick-note`）
 *      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）
 *
 * ## 为什么必须有（本项目已经为"只做静态验证"付过两次学费）
 *  1. t20 的磁贴：静态门全绿、窗口也能创建，但**窗口里缺 fs 权限** ⇒ 一打开就是一屏
 *     英文 ACL 报错（用户称之为「乱码」）。静态断言查不出"这个窗口到底渲染了什么"。
 *  2. 组件"能编译、能在加载期炸"（Hook 顺序、ESM TDZ）也都发生在静态门看不到的地方。
 * 因此本探针做的是**真机端到端**：
 *   · 真启动应用（tauri dev）→ 真创建窗口 → 真读窗口里渲染的 DOM；
 *   · 真敲键盘（CDP · Input domain）→ 真让 store 落库 → 真读 vault 里新出现的 md；
 *   · 并**真的测一遍输入法守卫**：制造 compositionstart 后按 Enter，必须**不落库**。
 *
 * ## 它怎么触发窗口（这是本探针唯一"取巧"的地方）
 * 快速笔记的正式触发路径是「全局快捷键 / 托盘菜单」，两者都无法从外部脚本可靠驱动
 * （全局键需要真实键盘事件，托盘菜单要 UIA 点托盘图标）。因此这里走**同一条 Rust 函数
 * 的另一个入口** —— `cmd_open_quick_note`：用 CDP 在**主窗口**里 `invoke` 它。
 * 这样验证的仍然是"Rust 创建窗口 → 前端路由 → 渲染 → 落库"整条真实链路，
 * 唯一绕过的是"按键盘/点托盘"这最后一跳（那一跳由 `check:quicknote` 静态守住）。
 *
 * ## 数据安全（照 t33 探针的口径）
 *  · vault 只读，除了探针自己创建的那一条（探针在清理阶段删掉它，并断言文件数复原）；
 *  · 清理同时删除索引行与 note_tags —— md 是真相源，两边一起删等于"从未存在过"；
 *  · 已有 zhijian 进程 / 端口 1420 被占用 ⇒ 直接退出，不干扰正在进行的会话。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * vault 路径必须问系统要，不能拼 `os.homedir()/Documents`：
 * 本机的「文档」是**重定向到 D 盘的**（`D:\Document`），拼出来的路径并不存在 ——
 * 第一版就这么写，探针直接以"找不到 vault"退出。与两个 ps1 探针同一口径：
 * 用 `[Environment]::GetFolderPath('MyDocuments')` 取真实路径。
 */
function resolveDocumentsDir() {
  const result = spawn('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  result.stdout.on('data', (chunk) => (out += chunk))
  return new Promise((resolve) => {
    result.on('close', () => resolve(out.trim() || path.join(os.homedir(), 'Documents')))
  })
}

const vaultRoot = path.join(await resolveDocumentsDir(), '纸笺')
const appDataDir = path.join(process.env.APPDATA ?? '', 'com.zhijian.app')
const dbPath = path.join(appDataDir, 'zhijian.db')
const logPath = path.join(os.tmpdir(), 'zj-probe-quick-note.log')
const CDP_PORT = 9222
const MARKER = `探针快速笔记-${Date.now()}`
const BODY = `${MARKER}\n第二行内容`

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

/** 列 CDP 目标（WebView2 的 remote debugging endpoint） */
async function listTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    return await response.json()
  } catch {
    return []
  }
}

/** 极简 CDP 客户端（Node 24 自带全局 WebSocket，不需要任何依赖） */
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
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
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

/** 在目标里求值一个表达式，返回 JS 值 */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? '页面内求值抛错')
  }
  return result.result?.value
}

/* ------------------------------ 环境前置 ------------------------------ */

console.log('纸笺 · 快速笔记运行时探针（t44 端到端）')
console.log(`  vault : ${vaultRoot}`)
console.log(`  db    : ${dbPath}`)
console.log('')

const mdFilesBefore = existsSync(vaultRoot)
  ? readdirSync(vaultRoot, { recursive: true }).filter((name) => String(name).endsWith('.md')).length
  : 0

if (process.platform !== 'win32') {
  console.log('  ⚠️ 本探针依赖 Windows WebView2 的 CDP 端口，仅支持 win32。')
  process.exit(2)
}
const running = spawn('powershell', ['-NoProfile', '-Command', 'Get-Process zhijian -ErrorAction SilentlyContinue | Select-Object -First 1'], {
  stdio: ['ignore', 'pipe', 'ignore'],
})
let runningOut = ''
running.stdout.on('data', (chunk) => (runningOut += chunk))
await new Promise((resolve) => running.on('close', resolve))
if (runningOut.trim()) {
  console.log('  ⚠️ 已有 zhijian 在跑 —— 不做任何操作（避免干扰你的会话）。')
  process.exit(2)
}
if (!existsSync(vaultRoot)) {
  console.log(`  ⚠️ 找不到 vault：${vaultRoot}`)
  process.exit(2)
}

/* ------------------------------ 启动应用 ------------------------------ */

let dev = null
let createdNoteFile = null
let createdNoteId = null

try {
  info('启动 pnpm tauri:dev（附带 --force-renderer-accessibility 与 CDP 调试端口）…')
  const inner =
    `cd '${repoRoot}'; ` +
    `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; ` +
    `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility --remote-debugging-port=${CDP_PORT}'; ` +
    `pnpm tauri:dev *>&1 | Tee-Object -FilePath '${logPath}'`
  dev = spawn('pwsh', ['-NoProfile', '-Command', inner], { stdio: 'ignore', detached: false })

  // 等 CDP 端点 + 主窗口目标出现（tauri dev 首次编译可能很久）
  const deadline = Date.now() + 240_000
  let mainTarget = null
  while (Date.now() < deadline) {
    await sleep(1500)
    const targets = await listTargets()
    mainTarget = targets.find((t) => t.type === 'page' && /localhost:1420|tauri:\/\/localhost/.test(t.url ?? ''))
    if (mainTarget) break
    if (dev.exitCode !== null) break
  }
  assert(Boolean(mainTarget), 'A. 应用已启动，主窗口出现在 CDP 目标列表里', 'A. 等不到主窗口（见日志 ' + logPath + '）')
  if (!mainTarget) throw new Error('no main target')

  const main = await connect(mainTarget.webSocketDebuggerUrl)
  await main.send('Runtime.enable')

  /**
   * ⚠️ 等页面真正就绪再 invoke：CDP 目标一出现时页面可能还没加载完
   * （第一版就栽在这：`window.__TAURI_INTERNALS__` 还是 undefined，
   *  报 `Cannot read properties of undefined (reading 'invoke')`）。
   */
  const readyDeadline = Date.now() + 30_000
  let bridgeReady = false
  while (Date.now() < readyDeadline) {
    bridgeReady = await evaluate(
      main,
      `!!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)`,
    ).catch(() => false)
    if (bridgeReady) break
    await sleep(500)
  }
  if (!bridgeReady) {
    const targets = await listTargets()
    info(`CDP 目标：${targets.map((t) => `${t.type}:${t.url}`).join(' | ')}`)
  }
  assert(
    bridgeReady,
    'A2. 主窗口里 Tauri IPC 桥可用（window.__TAURI_INTERNALS__.invoke 存在）',
    'A2. 主窗口里等不到 Tauri IPC 桥 —— 页面可能没加载完，或连到了错误的目标',
  )
  if (!bridgeReady) throw new Error('tauri bridge not ready')

  /* ---------------------- 1) 触发创建快速笔记窗口 ---------------------- */

  const invoked = await evaluate(
    main,
    `window.__TAURI_INTERNALS__.invoke('cmd_open_quick_note').then(() => true).catch((e) => String(e))`,
  ).catch((error) => `求值失败：${error.message}`)
  assert(invoked === true, 'B. cmd_open_quick_note 调用成功（Rust 侧窗口创建无异常）', `B. cmd_open_quick_note 失败：${invoked}`)

  let quickTarget = null
  const quickDeadline = Date.now() + 20_000
  while (Date.now() < quickDeadline) {
    await sleep(700)
    const targets = await listTargets()
    quickTarget = targets.find((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''))
    if (quickTarget) break
  }
  assert(Boolean(quickTarget), 'C. 出现加载 `?quick=1` 的新窗口（路由参数真的传到了前端）', 'C. 没等到快速笔记窗口（URL 未带 ?quick=1）')
  if (!quickTarget) throw new Error('no quick-note target')

  const quick = await connect(quickTarget.webSocketDebuggerUrl)
  await quick.send('Runtime.enable')
  await sleep(2500) // 等 React 挂载 + initDb 完成

  /* ---------------------- 2) 渲染断言（t33 那一类：窗口里到底显示了什么） ---------------------- */

  const snapshot = await evaluate(
    quick,
    `JSON.stringify({
       hasRoot: !!document.querySelector('[data-zj-quick-note]'),
       hasInput: !!document.querySelector('textarea[data-zj-quick-note-input]'),
       hasSave: !!document.querySelector('[data-zj-quick-note-save]'),
       text: (document.body.innerText || '').slice(0, 400),
       placeholder: document.querySelector('textarea')?.getAttribute('placeholder') || ''
     })`,
  )
  const dom = JSON.parse(snapshot)
  info(`窗口内文本：${JSON.stringify(dom.text.slice(0, 120))}`)

  assert(dom.hasRoot && dom.hasInput, 'D1. 窗口里渲染的是 QuickNoteApp（有根节点与输入框），不是主界面', `D1. 渲染不对：${snapshot}`)
  const aclMarkers = ['not allowed on window', 'Command not found', '数据库不可用', '数据库初始化失败', '保存失败']
  const hit = aclMarkers.filter((marker) => dom.text.includes(marker))
  assert(hit.length === 0, 'D2. **没有任何 ACL / 数据库错误文案**（t33 的「一打开就是乱码」不成立）', `D2. 窗口内出现错误文案：${hit.join('、')}`)
  assert(dom.placeholder.includes('随手记'), 'D3. 输入框占位文案正确（说明路由与组件加载都对）', `D3. 占位文案不对：${dom.placeholder}`)

  /* ---------------------- 3) 输入法守卫（运行时证据） ---------------------- */

  await evaluate(quick, `document.querySelector('textarea').focus(), true`)
  await quick.send('Input.insertText', { text: BODY })
  await sleep(300)

  // 制造"输入法组合中"：真的派发 compositionstart（React 的 onCompositionStart 会收到）
  await evaluate(
    quick,
    `document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })), true`,
  )
  await sleep(200)
  for (const type of ['keyDown', 'keyUp']) {
    await quick.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }
  await sleep(1800) // 留足时间：若守卫失效，保存 + 关窗都来得及发生

  const createdEarly = readdirSync(vaultRoot, { recursive: true })
    .filter((name) => String(name).endsWith('.md'))
    .some((name) => {
      try {
        return readFileSync(path.join(vaultRoot, String(name)), 'utf8').includes(MARKER)
      } catch {
        return false
      }
    })
  assert(
    !createdEarly,
    'E. **组合期按 Enter 没有落库**（中文输入法确认候选词不会误存笔记）',
    'E. ⚠️ 组合期按 Enter 竟然落库了 —— 输入法守卫生效失败（用户选词会误建笔记并关窗）',
  )

  /* ---------------------- 4) 正常保存：真敲 Enter ---------------------- */

  await evaluate(
    quick,
    `document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })), true`,
  )
  await sleep(200)
  for (const type of ['keyDown', 'keyUp']) {
    await quick.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }

  const saveDeadline = Date.now() + 15_000
  let createdName = null
  while (Date.now() < saveDeadline) {
    await sleep(600)
    createdName = readdirSync(vaultRoot, { recursive: true })
      .map(String)
      .find((name) => {
        if (!name.endsWith('.md')) return false
        try {
          return readFileSync(path.join(vaultRoot, name), 'utf8').includes(MARKER)
        } catch {
          return false
        }
      })
    if (createdName) break
  }
  assert(Boolean(createdName), `F1. Enter 真的创建了笔记（vault 里出现新 md：${createdName}）`, 'F1. 按 Enter 后 vault 里没有出现新笔记')
  if (!createdName) throw new Error('note not created')

  createdNoteFile = path.join(vaultRoot, createdName)
  const raw = readFileSync(createdNoteFile, 'utf8')
  const idMatch = raw.match(/^id:\s*(.+)$/m)
  createdNoteId = idMatch ? idMatch[1].trim() : null
  assert(Boolean(createdNoteId), 'F2. 新笔记的 front-matter 带 id（索引与 md 真相源对得上）', 'F2. 新 md 的 front-matter 里没有 id')
  assert(
    raw.includes(MARKER) && raw.includes('第二行内容'),
    'F3. md 正文与输入完全一致（含第二行）',
    'F3. md 正文与输入不一致',
  )
  assert(
    /^title:\s*"?探针快速笔记/m.test(raw),
    'F4. 标题按「首个非空行」推断（文件名/标题都不是「无标题」）',
    `F4. 标题推断不对：${raw.split('\n').slice(0, 8).join(' | ')}`,
  )

  /* ---------------------- 5) 保存后窗口自动关闭 ---------------------- */

  let closed = false
  const closeDeadline = Date.now() + 12_000
  while (Date.now() < closeDeadline) {
    await sleep(600)
    const targets = await listTargets()
    if (!targets.some((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''))) {
      closed = true
      break
    }
  }
  assert(closed, 'G. 保存后捕捉框自动关闭（用完即走，不留窗口）', 'G. 保存后快速笔记窗口仍然开着')

  quick.close()
  main.close()
} catch (error) {
  fail(`探针执行中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  /* ------------------------------ 清理 ------------------------------ */
  try {
    spawn('powershell', ['-NoProfile', '-Command', 'Get-Process zhijian -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' })
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
  try {
    const listener = spawn('powershell', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    listener.stdout.on('data', (chunk) => (out += chunk))
    await new Promise((resolve) => listener.on('close', resolve))
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      spawn('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`], { stdio: 'ignore' })
    }
  } catch {
    /* 忽略 */
  }

  // 删掉探针自己创建的那条笔记：md + 索引行一起删（md 是真相源，两边同删 = 从未存在）
  if (createdNoteFile && existsSync(createdNoteFile)) {
    try {
      unlinkSync(createdNoteFile)
      ok('H1. 已删除探针创建的 md 文件（vault 复原）')
    } catch (error) {
      fail(`H1. 删除探针 md 失败：${error.message}`)
    }
  }
  if (createdNoteId && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath)
      db.exec('PRAGMA foreign_keys = ON')
      const tags = db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(createdNoteId)
      const row = db.prepare('DELETE FROM notes WHERE id = ?').run(createdNoteId)
      db.close()
      ok(`H2. 已删除索引行（notes ${row.changes} 行 / note_tags ${tags.changes} 行）`)
    } catch (error) {
      fail(`H2. 清理索引失败（下次启动会按 md 真相源自愈）：${error.message}`)
    }
  }
  if (existsSync(repoRoot)) {
    try {
      rmSync(logPath, { force: true })
    } catch {
      /* 忽略 */
    }
  }

  const mdFilesAfter = readdirSync(vaultRoot, { recursive: true }).filter((name) => String(name).endsWith('.md')).length
  assert(
    mdFilesAfter === mdFilesBefore,
    `I. vault 的 md 数量复原（${mdFilesBefore} → ${mdFilesAfter}）`,
    `I. vault 的 md 数量没复原（${mdFilesBefore} → ${mdFilesAfter}），可能留下测试残留`,
  )
}

console.log('')
console.log('════════════════ 汇总 ════════════════')
for (const line of notes) console.log(`  ${line}`)
if (failures.length === 0) {
  console.log('\n✅ 快速笔记探针：全部断言通过')
  process.exit(0)
}
console.log(`\n❌ 快速笔记探针失败 ${failures.length} 项：`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
