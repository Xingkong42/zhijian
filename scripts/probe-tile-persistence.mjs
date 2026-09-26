#!/usr/bin/env node
/**
 * 纸笺 · 磁贴「持久化 / 对账 / 自愈」运行时探针（t45）
 * ============================================================================
 * 运行：node scripts/probe-tile-persistence.mjs      （或 `pnpm probe:tile-persistence`）
 *      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）
 *
 * ## 它回答用户的四句话（前三句是报障，第四句是要求）
 *  ① 「用磁贴的 × 关闭磁贴，主界面上『取消桌面磁贴』按钮不能自动恢复成『钉到桌面』」
 *  ② 「关闭磁贴后关闭整个程序，下次开启后还是会显示那些磁贴」
 *  ③ 「每次启动程序，中间会显示一个空白磁贴，显示这条笔记不存在」
 *  ④ 「固定某个磁贴……用户自己决定哪个磁贴在开启后永久保留，下次启动自动出现」
 *
 * ## 为什么必须真机（静态门 + 单测都覆盖不到的部分）
 * 这四条全是**跨进程生命周期**行为：关窗 → 落盘 → 退出 → 启动 → 恢复。
 * `check:tiles` 只能证明"代码接上了"，cargo 单测只能证明"纯函数语义对"，
 * 而"真的重启之后桌面上剩下哪些窗口"只有跑一次才知道 —— 这正是前几轮反复踩到的边界
 * （t33 的 ACL 报错墙、t44 的同步命令死锁，都是静态门全绿却在真机上翻车）。
 *
 * ## 数据安全
 *  · **备份并还原 `tiles.json`**（那是用户真实的磁贴集合，本机有 5 条）；
 *  · 探针笔记自己造（复用"快速笔记"这条真实路径），收尾连 md 与索引行一起删；
 *  · 结束时核对 vault 的 md 数量复原。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const appDataDir = path.join(process.env.APPDATA ?? '', 'com.zhijian.app')
const tilesPath = path.join(appDataDir, 'tiles.json')
const tilesBackup = path.join(os.tmpdir(), `zj-tiles-probe-backup-${Date.now()}.json`)
const dbPath = path.join(appDataDir, 'zhijian.db')
const CDP_PORT = 9224
const STAMP = Date.now()
const BASE = `TILEPROBE-${STAMP}`
/** 故意指向一条不存在的笔记：模拟"笔记已删、磁贴记录还在"（用户报障 ③ 的成因） */
const GHOST_NOTE_ID = `ghost-${STAMP}`

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

async function listTargets() {
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
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '求值抛错')
  return result.result?.value
}

/** 启动应用并返回主窗口的 CDP 客户端 */
async function launchApp(label) {
  const inner =
    `cd '${repoRoot}'; ` +
    `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; ` +
    `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility --remote-debugging-port=${CDP_PORT}'; ` +
    `pnpm tauri:dev *>&1 | Tee-Object -FilePath '${path.join(os.tmpdir(), `zj-probe-tile-persist-${label}.log`)}'`
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
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(client, `!!(window.__TAURI_INTERNALS__ && document.querySelector('[data-note-id]'))`).catch(() => false)) break
    await sleep(500)
  }
  return { dev, client }
}

async function stopApp() {
  await run('Get-Process zhijian -ErrorAction SilentlyContinue | Stop-Process -Force')
  await sleep(2000)
  const owners = await run('(Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue).OwningProcess')
  for (const pid of owners.split(/\s+/).filter(Boolean)) {
    await run(`Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`)
  }
  await sleep(1500)
}

const readTilesFile = () => {
  if (!existsSync(tilesPath)) return { version: 1, tiles: {} }
  return JSON.parse(readFileSync(tilesPath, 'utf8'))
}

/* ------------------------------ 环境前置 ------------------------------ */

console.log('纸笺 · 磁贴持久化/对账/自愈探针（t45 端到端，含一次真实重启）')
console.log(`  tiles.json : ${tilesPath}`)
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
if (existsSync(tilesPath)) copyFileSync(tilesPath, tilesBackup)
const hadTilesFile = existsSync(tilesPath)
const mdCountBefore = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length
info(`已备份 tiles.json（原本存在=${hadTilesFile}）→ 收尾会逐字节还原`)

let first = null
let second = null
let createdFile = null
let createdId = null

try {
  /* ================= 第一段：钉住 → × 关闭 → 再钉住并固定 ================= */

  first = await launchApp('run1')
  const main1 = first.client

  // 1) 造一条探针笔记（走快速笔记这条真实路径）
  await evaluate(main1, `window.__TAURI_INTERNALS__.invoke('cmd_open_quick_note').then(() => true).catch((e) => 'ERR:' + e)`)
  let quickTarget = null
  for (let i = 0; i < 30 && !quickTarget; i += 1) {
    await sleep(600)
    quickTarget = (await listTargets()).find((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''))
  }
  assert(Boolean(quickTarget), 'A1. 快速笔记窗口已打开（造探针笔记）', 'A1. 打不开快速笔记窗口')
  if (!quickTarget) throw new Error('no quick window')
  const quick = await connect(quickTarget.webSocketDebuggerUrl)
  await quick.send('Runtime.enable')
  await sleep(1800)
  await evaluate(quick, `(() => { const el = document.querySelector('textarea[data-zj-quick-note-input]'); el.focus(); return true })()`)
  await quick.send('Input.insertText', { text: BASE })
  await sleep(300)
  for (const type of ['keyDown', 'keyUp']) {
    await quick.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  let createdName = null
  for (let i = 0; i < 25 && !createdName; i += 1) {
    await sleep(600)
    createdName = readdirSync(vaultRoot, { recursive: true })
      .map(String)
      .find((n) => n.endsWith('.md') && readFileSync(path.join(vaultRoot, n), 'utf8').includes(BASE))
  }
  assert(Boolean(createdName), `A2. 探针笔记已创建：${createdName}`, 'A2. 探针笔记没建出来')
  if (!createdName) throw new Error('no probe note')
  createdFile = path.join(vaultRoot, createdName)
  createdId = readFileSync(createdFile, 'utf8').match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? null
  quick.close()
  assert(Boolean(createdId), `A3. 拿到探针笔记 id：${createdId}`, 'A3. 探针笔记没有 id')
  if (!createdId) throw new Error('no id')

  // 2) 钉住（**不固定**）→ 磁贴出现；图钉应为 off
  const pinnedState = await evaluate(main1, `window.__TAURI_INTERNALS__.invoke('cmd_toggle_tile', { noteId: '${createdId}' }).then((v) => v).catch((e) => 'ERR:' + e)`)
  assert(pinnedState === true, 'B1. 钉住成功（返回 true）', `B1. 钉住失败：${pinnedState}`)
  let tileTarget = null
  for (let i = 0; i < 30 && !tileTarget; i += 1) {
    await sleep(600)
    tileTarget = (await listTargets()).find((t) => t.type === 'page' && (t.url ?? '').includes(createdId))
  }
  assert(Boolean(tileTarget), 'B2. 磁贴窗口出现', 'B2. 磁贴窗口没出现')
  if (!tileTarget) throw new Error('no tile window')
  const tile = await connect(tileTarget.webSocketDebuggerUrl)
  await tile.send('Runtime.enable')
  await sleep(2500)
  const pinAttr1 = await evaluate(tile, `document.querySelector('[data-zj-tile-pin]')?.getAttribute('data-zj-tile-pin')`)
  assert(pinAttr1 === 'off', 'B3. 新钉的磁贴默认**未固定**（图钉为 off）', `B3. 图钉状态应为 off，实际 ${pinAttr1}`)

  // 3) 用磁贴自己的 × 关闭 → 主窗口按钮必须自动恢复（用户报障 ①）
  const beforeClose = await evaluate(
    main1,
    `(() => { const el = document.querySelector('[data-note-id="${createdId}"]'); el.click(); return true })()`,
  ).catch(() => false)
  await sleep(1500)
  const labelBefore = await evaluate(main1, `document.querySelector('[data-zj-tile-toggle]')?.getAttribute('aria-label')`)
  const pressedBefore = await evaluate(main1, `document.querySelector('[data-zj-tile-toggle]')?.getAttribute('aria-pressed')`)
  info(`× 关闭前：主窗口磁贴按钮 aria-label=${JSON.stringify(labelBefore)}、aria-pressed=${pressedBefore}（beforeClose=${beforeClose}）`)

  await evaluate(tile, `document.querySelector('[data-zj-tile-close]').click(), true`)
  await sleep(3500)
  const tileGone = !(await listTargets()).some((t) => t.type === 'page' && (t.url ?? '').includes(createdId))
  assert(tileGone, 'C1. 点磁贴的 × 后窗口真的关掉了', 'C1. × 点了但窗口还在')
  const pressedAfter = await evaluate(main1, `document.querySelector('[data-zj-tile-toggle]')?.getAttribute('aria-pressed')`)
  const labelAfter = await evaluate(main1, `document.querySelector('[data-zj-tile-toggle]')?.getAttribute('aria-label')`)
  assert(
    pressedAfter === 'false',
    `C2. **主窗口按钮自动恢复为「钉到桌面」**（aria-pressed=${pressedAfter}，label=${JSON.stringify(labelAfter)}）—— 用户报障 ① 已修`,
    `C2. × 关闭后主窗口按钮仍停在「取消桌面磁贴」（aria-pressed=${pressedAfter}，label=${JSON.stringify(labelAfter)}）—— 报障 ① 未修好`,
  )
  tile.close()

  // 4) 再钉住并点图钉固定
  await evaluate(main1, `window.__TAURI_INTERNALS__.invoke('cmd_toggle_tile', { noteId: '${createdId}' }).then((v) => v).catch((e) => 'ERR:' + e)`)
  let tileTarget2 = null
  for (let i = 0; i < 30 && !tileTarget2; i += 1) {
    await sleep(600)
    tileTarget2 = (await listTargets()).find((t) => t.type === 'page' && (t.url ?? '').includes(createdId))
  }
  assert(Boolean(tileTarget2), 'D1. 再次钉住，磁贴窗口出现', 'D1. 第二次钉住失败')
  if (!tileTarget2) throw new Error('no tile window 2')
  const tile2 = await connect(tileTarget2.webSocketDebuggerUrl)
  await tile2.send('Runtime.enable')
  await sleep(2500)
  await evaluate(tile2, `document.querySelector('[data-zj-tile-pin]').click(), true`)
  await sleep(2500)
  const pinAttr2 = await evaluate(tile2, `document.querySelector('[data-zj-tile-pin]')?.getAttribute('data-zj-tile-pin')`)
  assert(pinAttr2 === 'on', 'D2. 点图钉后状态变为**已固定**（on）', `D2. 固定后图钉状态应为 on，实际 ${pinAttr2}`)
  tile2.close()

  /* ================= 第二段：写脏条目 → 真实重启 → 断言恢复集合 ================= */

  await stopApp()
  // 提交内存里的状态到磁盘（正常退出会落盘；这里显式确认 pinned 已写进去）
  const snapshot = readTilesFile()
  assert(
    snapshot.tiles?.[createdId]?.pinned === true,
    'E1. tiles.json 里探针笔记已标记 pinned:true（固定状态真的落盘了）',
    `E1. tiles.json 里 pinned 不是 true：${JSON.stringify(snapshot.tiles?.[createdId])}`,
  )
  // 注入一条"指向不存在笔记"的脏条目（用户报障 ③ 的成因）
  snapshot.tiles[GHOST_NOTE_ID] = { x: 300.0, y: 300.0, width: 280.0, height: 240.0, pinned: true }
  writeFileSync(tilesPath, JSON.stringify(snapshot, null, 2), 'utf8')
  info(`已注入脏条目 ${GHOST_NOTE_ID}（pinned:true，笔记并不存在）`)

  second = await launchApp('run2')
  const main2 = second.client
  await sleep(6000) // 等 Rust 恢复磁贴 + 主窗口启动对账跑完

  const targets2 = await listTargets()
  const tileUrls = targets2.filter((t) => t.type === 'page' && /[?&]tile=/.test(t.url ?? '')).map((t) => t.url)
  info(`重启后磁贴窗口：${JSON.stringify(tileUrls)}`)

  assert(
    tileUrls.some((url) => url.includes(createdId)),
    'F1. **固定的磁贴重启后自动出现**（需求 ④：用户自己决定哪个永久保留）',
    `F1. 固定的磁贴重启后没有出现（tileUrls=${JSON.stringify(tileUrls)}）`,
  )
  /**
   * 报障 ②（「关闭磁贴后重启还是会显示那些磁贴」）的**直接**证据。
   *
   * ⚠️ 断言不能写成"恰好 1 枚"：探针笔记固定之后，用户自己固定过的磁贴**也应该**恢复
   * （本机就有两枚是用户固定过的）—— 第一版写成"恰好 1 枚"，在用户固定了磁贴之后
   * 就把**正确行为**判成了失败。正确口径是"恢复集合 == tiles.json 里 pinned 的集合"。
   */
  const expectedPinnedIds = Object.entries(snapshot.tiles ?? {})
    .filter(([id, geometry]) => geometry?.pinned === true && id !== GHOST_NOTE_ID)
    .map(([id]) => id)
  info(`应恢复（pinned）的条目：${JSON.stringify(expectedPinnedIds.map((id) => id.slice(0, 8) + '…'))}`)
  assert(
    tileUrls.length === expectedPinnedIds.length &&
      expectedPinnedIds.every((id) => tileUrls.some((url) => url.includes(id))),
    `F2. **只恢复被固定的磁贴**：实际 ${tileUrls.length} 枚 == 固定条目 ${expectedPinnedIds.length} 枚（未固定的一个都没出现）—— 报障 ② 已修`,
    `F2. 恢复集合与"固定条目"不一致：出现了 ${tileUrls.length} 枚，固定条目 ${expectedPinnedIds.length} 枚 —— ${JSON.stringify(tileUrls)}`,
  )
  assert(
    !tileUrls.some((url) => url.includes(GHOST_NOTE_ID)),
    'F3. **指向不存在笔记的脏磁贴没有留下空白窗口**（用户报障 ③ 已修）',
    `F3. 脏条目仍然开出了空白磁贴（tileUrls=${JSON.stringify(tileUrls)}）`,
  )
  const afterRestart = readTilesFile()
  assert(
    afterRestart.tiles?.[GHOST_NOTE_ID]?.pinned === false,
    'F4. 脏条目的固定标记已被取消（不会再被恢复；tiles.json 里的几何缓存保留）',
    `F4. 脏条目仍是 pinned:true：${JSON.stringify(afterRestart.tiles?.[GHOST_NOTE_ID])}`,
  )
  console.log('')
} catch (error) {
  fail(`探针执行中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  first?.client?.close()
  second?.client?.close()
  await stopApp()
  if (first?.dev && first.dev.exitCode === null) {
    try {
      first.dev.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
  if (second?.dev && second.dev.exitCode === null) {
    try {
      second.dev.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
  await sleep(1500)

  // 还原用户的 tiles.json（逐字节）
  if (hadTilesFile) {
    copyFileSync(tilesBackup, tilesPath)
    ok('G1. tiles.json 已逐字节还原为运行前的内容')
  } else if (existsSync(tilesPath)) {
    rmSync(tilesPath, { force: true })
    ok('G1. tiles.json 原本不存在，已删除探针产生的文件')
  }
  rmSync(tilesBackup, { force: true })

  // 删除探针笔记（md + 索引行）
  if (createdFile && existsSync(createdFile)) {
    unlinkSync(createdFile)
    ok('G2. 已删除探针笔记的 md')
  }
  if (createdId && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath)
      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(createdId)
      db.prepare('DELETE FROM notes WHERE id = ?').run(createdId)
      db.close()
      ok('G3. 已删除探针笔记的索引行')
    } catch (error) {
      fail(`G3. 清理索引失败（下次启动按 md 真相源自愈）：${error.message}`)
    }
  }
  const mdCountAfter = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length
  assert(mdCountAfter === mdCountBefore, `H. vault 的 md 数量复原（${mdCountBefore} → ${mdCountAfter}）`, `H. md 数量没复原（${mdCountBefore} → ${mdCountAfter}）`)
}

console.log('')
console.log('════════════════ 汇总 ════════════════')
for (const line of notes) console.log(`  ${line}`)
if (failures.length === 0) {
  console.log('\n✅ 磁贴持久化探针：全部断言通过')
  process.exit(0)
}
console.log(`\n❌ 磁贴持久化探针失败 ${failures.length} 项：`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
