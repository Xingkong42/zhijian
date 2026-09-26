#!/usr/bin/env node
/**
 * 纸笺 · t46 运行时探针（快捷键启动下发 / 设置右侧栏 / 快速笔记标题）
 * ============================================================================
 * 运行：node scripts/probe-t46.mjs        （或 `pnpm probe:t46`）
 *      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）
 *
 * ## 覆盖用户本轮的报障与要求
 *  ① 报障：「关闭程序后，再开启，关于磁贴的快捷键失效」——
 *     **前后对照**：第一次启动里写入自定义绑定后断言"Rust 侧还没注册"（false），
 *     重启后断言"已注册"（true）。这条对照是整条报障的闭环证据。
 *  ④ 「快速笔记应该能输入标题和正文」—— 真填标题 + 正文，断言 md 里的 title 是**标题**。
 *  ⑤ 「设置不要单独一页，作为整个界面的一栏」—— 点侧栏「设置」后断言：
 *     设置栏出现 **且** 笔记列表仍在（主界面没被替换掉）。
 *
 * ## 数据安全
 *  · `localStorage` 的快捷键绑定**读出来备份、结束写回**（那是用户的真实键位设置）；
 *  · 快捷笔记自己造、自己删（md + 索引行）；结束核对 vault 的 md 数量复原。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const appDataDir = path.join(process.env.APPDATA ?? '', 'com.zhijian.app')
const dbPath = path.join(appDataDir, 'zhijian.db')
const CDP_PORT = 9225
const STAMP = Date.now()
const TITLE = `T46标题-${STAMP}`
const BODY = `T46正文-${STAMP}`
const TEST_ACCELERATOR = 'Alt+Shift+T'
const SHORTCUTS_KEY = 'zhijian.shortcuts'

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
const assert = (c, okM, failM) => (c ? ok(okM) : fail(failM))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resolveDocumentsDir() {
  const child = spawn('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  return new Promise((resolve) => child.on('close', () => resolve(out.trim() || path.join(os.homedir(), 'Documents'))))
}
const vaultRoot = path.join(await resolveDocumentsDir(), '纸笺')

async function run(command) {
  const child = spawn('powershell', ['-NoProfile', '-Command', command], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  await new Promise((r) => child.on('close', r))
  return out.trim()
}

const listTargets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP 超时：${method}`))
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
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '求值抛错')
  return r.result?.value
}

async function launch(label) {
  const inner =
    `cd '${repoRoot}'; ` +
    `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; ` +
    `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility --remote-debugging-port=${CDP_PORT}'; ` +
    `pnpm tauri:dev *>&1 | Tee-Object -FilePath '${path.join(os.tmpdir(), `zj-probe-t46-${label}.log`)}'`
  const dev = spawn('pwsh', ['-NoProfile', '-Command', inner], { stdio: 'ignore' })
  const deadline = Date.now() + 240_000
  let target = null
  while (Date.now() < deadline) {
    await sleep(1500)
    target = (await listTargets()).find(
      (t) => t.type === 'page' && !/[?&](tile|quick)=/.test(t.url ?? '') && /localhost:1420|tauri:\/\/localhost/.test(t.url ?? ''),
    )
    if (target) break
    if (dev.exitCode !== null) break
  }
  if (!target) throw new Error('等不到主窗口')
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  for (let i = 0; i < 90; i += 1) {
    if (await evaluate(client, `!!(window.__TAURI_INTERNALS__ && document.querySelector('[data-note-id]'))`).catch(() => false)) break
    await sleep(500)
  }
  return { dev, client }
}

async function stop(dev) {
  await run('Get-Process zhijian -ErrorAction SilentlyContinue | Stop-Process -Force')
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
  await sleep(1500)
}

/** Rust 侧是否真的注册了该键位（= 快捷键能否生效的权威判据） */
const isRegistered = (client, accelerator) =>
  evaluate(
    client,
    `window.__TAURI_INTERNALS__.invoke('plugin:global-shortcut|is_registered', { shortcut: ${JSON.stringify(accelerator)} })
       .then((v) => v).catch((e) => 'ERR:' + e)`,
  ).catch((e) => 'ERR:' + e.message)

console.log('纸笺 · t46 探针（快捷键启动下发 / 设置栏 / 快速笔记标题）')
console.log('')

if (process.platform !== 'win32') {
  console.log('  ⚠️ 仅支持 win32（依赖 WebView2 的 CDP 端口）。')
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
const mdCountBefore = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length

let first = null
let second = null
let shortcutsBackup = null
let createdFile = null
let createdId = null

try {
  /* ============ 第一次启动：用户的自定义绑定应当**已经注册**（启动下发生效） ============ */

  first = await launch('run1')
  const main1 = first.client
  shortcutsBackup = await evaluate(main1, `localStorage.getItem(${JSON.stringify(SHORTCUTS_KEY)})`)

  /**
   * 从**用户真实持久化设置**里取"已启用且有键位"的动作，逐个断言 Rust 侧已注册。
   *
   * 这样写有两个好处：① 不硬编码任何键位（不同机器不同）；② 直接验证用户的实际情况 ——
   * 用户报障时绑的正是 `pinNote`(Alt+D) / `quickNote`(Alt+M) 这类自定义键位。
   */
  const enabledBindings = JSON.parse(
    await evaluate(
      main1,
      `(() => {
         const raw = localStorage.getItem(${JSON.stringify(SHORTCUTS_KEY)})
         if (!raw) return '[]'
         const parsed = JSON.parse(raw)
         return JSON.stringify(
           Object.values(parsed)
             .filter((b) => b && b.enabled === true && typeof b.accelerator === 'string' && b.accelerator)
             .map((b) => ({ id: b.id, accelerator: b.accelerator })),
         )
       })()`,
    ),
  )
  info(`用户已启用的自定义绑定：${JSON.stringify(enabledBindings)}`)
  assert(
    Array.isArray(enabledBindings) && enabledBindings.length > 0,
    'A1. 读到「已启用且有键位」的绑定（本机存在这样的配置，正是报障的前提）',
    'A1. 本机没有已启用的自定义绑定 —— 该报障无法在此环境复现（请先在设置里绑一个再跑）',
  )

  const notRegistered = []
  for (const binding of enabledBindings) {
    const value = await isRegistered(main1, binding.accelerator)
    if (value !== true) notRegistered.push(`${binding.id}(${binding.accelerator})=${JSON.stringify(value)}`)
  }
  assert(
    notRegistered.length === 0,
    `A2. **用户的自定义绑定在启动后全部已注册**（${enabledBindings.map((b) => b.accelerator).join('、')}）—— 报障① 已修`,
    `A2. 启动后仍未注册：${notRegistered.join(', ')} —— 报障① 未修好`,
  )

  /**
   * **前后对照**（不碰用户设置）：人为把其中一条注销掉，模拟"重启前 Rust 侧没有它"的状态；
   * 再重启一次，断言它又回来了 —— 这就把"启动下发"这条链路单独拎出来证明了。
   */
  const probeBinding = enabledBindings[0]
  /**
   * ⚠️ 参数名踩坑记录：`unregister` 要的是 **`shortcuts`（复数、数组）**，而
   * `is_registered` 要的是 `shortcut`（单数）。写错时插件报
   * `invalid args 'shortcuts' for command 'unregister': ... missing required key shortcuts`
   * —— 好在这条错误信息足够直白（探针原样打印了它）。
   */
  const unregistered = await evaluate(
    main1,
    `window.__TAURI_INTERNALS__.invoke('plugin:global-shortcut|unregister', { shortcuts: [${JSON.stringify(probeBinding.accelerator)}] })
       .then(() => true).catch((e) => 'ERR:' + e)`,
  )
  const afterUnregister = await isRegistered(main1, probeBinding.accelerator)
  assert(
    unregistered === true && afterUnregister === false,
    `A3. 对照：人为注销 ${probeBinding.accelerator} 后确认未注册（false）`,
    `A3. 注销失败（unregister=${JSON.stringify(unregistered)}, is_registered=${JSON.stringify(afterUnregister)}）`,
  )
  await stop(first.dev)

  /* ============ 第二次启动：它必须被启动下发重新注册（报障 ① 的闭环） ============ */

  second = await launch('run2')
  const main2 = second.client
  await sleep(3000) // 等启动流程里的下发完成

  const restoredRegistration = await isRegistered(main2, probeBinding.accelerator)
  assert(
    restoredRegistration === true,
    `B. **重启后 ${probeBinding.id}(${probeBinding.accelerator}) 又被注册上了**（is_registered = true）—— 报障①「重启后快捷键失效」已修`,
    `B. 重启后仍未注册（is_registered = ${JSON.stringify(restoredRegistration)}）—— 报障① 未修好`,
  )

  /* ============ 设置 = 最右侧一栏 ============ */

  await evaluate(
    main2,
    `(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '设置'); if (!b) return false; b.click(); return true })()`,
  )
  await sleep(1200)
  const columnState = JSON.parse(
    await evaluate(
      main2,
      `JSON.stringify({
         column: !!document.querySelector('[data-zj="settings-column"]'),
         panel: !!document.querySelector('[data-zj="settings-panel"]'),
         noteList: !!document.querySelector('[data-note-id]'),
         editor: !!document.querySelector('.cm-content'),
         dialog: !!document.querySelector('[role="dialog"]')
       })`,
    ),
  )
  assert(columnState.column && columnState.panel, 'C1. 点「设置」后出现**设置栏**（不是单独一页）', `C1. 没看到设置栏：${JSON.stringify(columnState)}`)
  assert(columnState.noteList, 'C2. **主界面（笔记列表）仍在**（设置是一栏，不替换主区域）', `C2. 主界面被替换掉了：${JSON.stringify(columnState)}`)
  assert(!columnState.dialog, 'C3. 设置栏**不是浮层对话框**（没有 role=dialog 遮挡）', `C3. 设置仍是浮层：${JSON.stringify(columnState)}`)

  /* ============ 快速笔记：标题 + 正文 ============ */

  await evaluate(main2, `window.__TAURI_INTERNALS__.invoke('cmd_open_quick_note').then(() => true).catch((e) => 'ERR:' + e)`)
  let quickTarget = null
  for (let i = 0; i < 30 && !quickTarget; i += 1) {
    await sleep(600)
    quickTarget = (await listTargets()).find((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''))
  }
  assert(Boolean(quickTarget), 'D1. 捕捉框已打开', 'D1. 打不开捕捉框')
  if (!quickTarget) throw new Error('no quick window')
  const quick = await connect(quickTarget.webSocketDebuggerUrl)
  await quick.send('Runtime.enable')
  await sleep(2000)

  const hasTitleBox = await evaluate(quick, `!!document.querySelector('[data-zj-quick-note-title]')`)
  assert(hasTitleBox, 'D2. 捕捉框里有**标题输入框**（用户要求"能输入标题和正文"）', 'D2. 捕捉框里没有标题输入框')
  await evaluate(quick, `(() => { document.querySelector('[data-zj-quick-note-title]').focus(); return true })()`)
  await quick.send('Input.insertText', { text: TITLE })
  await sleep(200)
  await evaluate(quick, `(() => { document.querySelector('[data-zj-quick-note-input]').focus(); return true })()`)
  await quick.send('Input.insertText', { text: BODY })
  await sleep(300)
  for (const type of ['keyDown', 'keyUp']) {
    await quick.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  let createdName = null
  for (let i = 0; i < 25 && !createdName; i += 1) {
    await sleep(600)
    createdName = readdirSync(vaultRoot, { recursive: true })
      .map(String)
      .find((n) => n.endsWith('.md') && readFileSync(path.join(vaultRoot, n), 'utf8').includes(BODY))
  }
  assert(Boolean(createdName), `D3. 笔记已创建：${createdName}`, 'D3. 没建出笔记')
  if (createdName) {
    createdFile = path.join(vaultRoot, createdName)
    const raw = readFileSync(createdFile, 'utf8')
    createdId = raw.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? null
    assert(
      raw.includes(`title: "${TITLE}"`) || raw.includes(`title: ${TITLE}`),
      `D4. md 的标题是**用户填的标题**（${TITLE}），而不是正文首行 —— 标题框真的生效了`,
      `D4. md 的标题不对（用户填的是「${TITLE}」）：${raw.split('\n').slice(0, 6).join(' | ')}`,
    )
    assert(raw.includes(BODY), 'D5. md 正文包含用户输入的正文', 'D5. md 正文不对')
  }
  quick.close()
} catch (error) {
  fail(`探针执行中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  /**
   * ⚠️ **顺序**：任何"写回用户数据"的动作都必须在关掉应用**之前**。
   *
   * 第一版把 `stop()` 写在前面，于是（当时还在写 localStorage 的）还原步骤在页面已死后
   * CDP 超时，测试键位被留在了用户的真实设置里 —— 只能再写一个一次性补救脚本去清。
   * 教训：**清理先恢复用户数据，再拆环境**。
   * 本版探针**不写任何用户设置**（只用 unregister/is_registered 做前后对照），
   * 但顺序纪律保留在这里。
   */
  if (shortcutsBackup !== undefined && second?.client) {
    try {
      const stillSame = await evaluate(
        second.client,
        `localStorage.getItem(${JSON.stringify(SHORTCUTS_KEY)}) === ${JSON.stringify(shortcutsBackup)}`,
      )
      assert(
        stillSame === true,
        'E1. 本探针**没有改动**用户的快捷键设置（localStorage 与运行前逐字一致）',
        'E1. localStorage 与运行前不一致 —— 探针污染了用户设置，请检查',
      )
    } catch (error) {
      fail(`E1. 无法核对快捷键设置是否原样：${error.message}`)
    }
  } else if (shortcutsBackup !== undefined) {
    fail('E1. 无法核对快捷键设置（会话已关闭）—— 请手工检查 localStorage[' + SHORTCUTS_KEY + ']')
  }

  first?.client?.close()
  second?.client?.close()
  await stop(second?.dev ?? first?.dev)

  if (createdFile && existsSync(createdFile)) {
    unlinkSync(createdFile)
    ok('E2. 已删除探针笔记的 md')
  }
  if (createdId && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath)
      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(createdId)
      db.prepare('DELETE FROM notes WHERE id = ?').run(createdId)
      db.close()
      ok('E3. 已删除探针笔记的索引行')
    } catch (error) {
      fail(`E3. 清理索引失败：${error.message}`)
    }
  }
  const mdCountAfter = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length
  assert(mdCountAfter === mdCountBefore, `F. vault 的 md 数量复原（${mdCountBefore} → ${mdCountAfter}）`, `F. md 数量没复原（${mdCountBefore} → ${mdCountAfter}）`)
}

console.log('')
console.log('════════════════ 汇总 ════════════════')
for (const line of notes) console.log(`  ${line}`)
if (failures.length === 0) {
  console.log('\n✅ t46 探针：全部断言通过')
  process.exit(0)
}
console.log(`\n❌ t46 探针失败 ${failures.length} 项：`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
