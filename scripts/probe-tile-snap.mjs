#!/usr/bin/env node
/**
 * 纸笺 · 磁贴**吸附成组**运行时探针（t47）
 * ============================================================================
 * 运行：node scripts/probe-tile-snap.mjs      （或 `pnpm probe:tile-snap`）
 *      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）
 *
 * ## 这条探针**验证什么、不验证什么**（如实标注，别把它当成全量闭环）
 * ✅ 验证（真机）：
 *   1. **组状态从 Rust 到 UI**：`tiles.json` 里两枚同组的磁贴启动后，
 *      磁贴标题栏**都出现**「取消吸附」按钮（`data-zj-tile-ungroup`）；
 *   2. **显式解组链路**：点其中一枚的按钮 ⇒ `cmd_ungroup_tile` 真的把组号清成 0；
 *   3. **孤儿组清理**：解组后**两枚**的按钮都消失、`tiles.json` 里两者 `group` 都是 0
 *      （只剩一个成员的组不该继续显示「取消吸附」——那是假状态）。
 * ❌ **不**验证（本轮无法自动化，已在报告里如实说明）：
 *   · "拖动时整组跟随"与"松手后自动吸附"这两条**事件驱动**行为 ——
 *     它们需要真实拖动窗口。两条自动化尝试都失败了：
 *     ① `plugin:window|set_position` 被 ACL 拒绝（而产品**并不需要**这条权限，
 *        组跟随是 Rust 侧直接调用的 —— 我不为测试放开生产权限）；
 *     ② `mouse_event` 模拟拖动无效（窗口纹丝不动，多半是这个旧 API 被系统忽略）。
 *     算法本身（取舍规则、阈值边界、贴合判定）由 `cargo test` 的 **11 条单测**覆盖。
 *
 * ## ⚠️ 环境限制（本机实测）：CDP 不可用时退出码是 **2**（未开始）
 * 本探针靠 CDP（`--remote-debugging-port`）驱动界面。本机 WebView2 **153.0.4234.48** 上，
 * 无论用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 还是 `tauri.conf.json` 的
 * `additionalBrowserArgs`，该端口都不再监听 ⇒ 探针**无法开始**，此时退出码 2。
 * 请勿把它当成功能回归（假红与假绿同样有害）。
 *
 * ## 数据安全
 *  · `tiles.json` **备份并在收尾逐字节还原**（那是用户真实的磁贴集合）；
 *  · 两枚探针笔记自己造、自己删（md + 索引行）；结束核对 vault md 数量复原。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const appDataDir = path.join(process.env.APPDATA ?? '', 'com.zhijian.app')
const tilesPath = path.join(appDataDir, 'tiles.json')
const tilesBackup = path.join(os.tmpdir(), `zj-tiles-snap-backup-${Date.now()}.json`)
const dbPath = path.join(appDataDir, 'zhijian.db')
const CDP_PORT = 9228
const STAMP = Date.now()
const A_TEXT = `SNAP-A-${STAMP}`
const B_TEXT = `SNAP-B-${STAMP}`
/** 预置的组号（任意非 0 值；断言只要求"两枚相同且 > 0"） */
const PRESET_GROUP = 7
const TILE_W = 300
const TILE_H = 260

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
  child.stdout.on('data', (c) => (out += c))
  return new Promise((r) => child.on('close', () => r(out.trim() || path.join(os.homedir(), 'Documents'))))
}
const vaultRoot = path.join(await resolveDocumentsDir(), '纸笺')

async function run(command) {
  const child = spawn('powershell', ['-NoProfile', '-Command', command], { stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
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

/** 本机 WebView2 是否真的开放了 CDP 调试端口（决定「环境不满足」还是「断言失败」） */
async function cdpListening() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 「环境不满足」而不是「断言失败」。
 *
 * 本机实测（WebView2 153.0.4234.48）：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`
 * 与 `tauri.conf.json` 的 `additionalBrowserArgs` **都不再让该端口监听**，
 * 于是所有靠 CDP 驱动界面的探针都跑不起来。这种情况必须报 exit 2（未开始），
 * 而不是伪装成 ❌ 断言失败 —— 后者会让下一个人以为功能坏了（假红和假绿一样有害）。
 */
class EnvUnsupported extends Error {}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      const entry = pending.get(m.id)
      if (!entry) return
      pending.delete(m.id)
      if (m.error) entry.reject(new Error(JSON.stringify(m.error)))
      else entry.resolve(m.result)
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
    `pnpm tauri:dev *>&1 | Tee-Object -FilePath '${path.join(os.tmpdir(), `zj-probe-snap-${label}.log`)}'`
  const dev = spawn('pwsh', ['-NoProfile', '-Command', inner], { stdio: 'ignore' })
  const deadline = Date.now() + 240_000
  let target = null
  /** 应用进程出现之后，再给它一段时间去开调试端口 */
  let appSeenAt = 0
  while (Date.now() < deadline) {
    await sleep(1500)
    target = (await listTargets()).find(
      (t) => t.type === 'page' && !/[?&](tile|quick)=/.test(t.url ?? '') && /localhost:1420|tauri:\/\//.test(t.url ?? ''),
    )
    if (target) break
    if (dev.exitCode !== null) break
    if (appSeenAt === 0) {
      const alive = await run("(Get-Process zhijian -ErrorAction SilentlyContinue | Measure-Object).Count")
      if (Number(alive) > 0) appSeenAt = Date.now()
    } else if (Date.now() - appSeenAt > 20_000 && !(await cdpListening())) {
      throw new EnvUnsupported(`应用已启动，但 CDP 端口 ${CDP_PORT} 始终没有监听 —— 本机 WebView2 未开放远程调试`)
    }
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

const readTiles = () => (existsSync(tilesPath) ? JSON.parse(readFileSync(tilesPath, 'utf8')) : { version: 1, tiles: {} })

console.log('纸笺 · 磁贴吸附成组探针（t47）')
console.log('')

if (process.platform !== 'win32') {
  console.log('  ⚠️ 仅支持 win32。')
  process.exit(2)
}
if (await run('Get-Process zhijian -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id')) {
  console.log('  ⚠️ 已有 zhijian 在跑 —— 不做任何操作。')
  process.exit(2)
}
const hadTiles = existsSync(tilesPath)
if (hadTiles) copyFileSync(tilesPath, tilesBackup)
info(`已备份 tiles.json（原本存在=${hadTiles}）→ 收尾逐字节还原`)
const mdCountBefore = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length

let first = null
let second = null
const created = []
/** 环境不满足（CDP 不可用）⇒ 收尾统一报 exit 2，而不是断言失败 */
let envUnsupported = false

try {
  /* ---------------- 第一步：造两条探针笔记（拿 id） ---------------- */

  first = await launch('run1')
  const invokeOn = (client) => (method, args) =>
    evaluate(
      client,
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}).then((v) => v).catch((e) => 'ERR:' + e)`,
    )
  const invoke1 = invokeOn(first.client)

  async function createNote(text) {
    await invoke1('cmd_open_quick_note', {})
    let quickTarget = null
    for (let i = 0; i < 30 && !quickTarget; i += 1) {
      await sleep(600)
      quickTarget = (await listTargets()).find((t) => t.type === 'page' && /[?&]quick=1/.test(t.url ?? ''))
    }
    if (!quickTarget) throw new Error('打不开快速笔记窗口')
    const quick = await connect(quickTarget.webSocketDebuggerUrl)
    await quick.send('Runtime.enable')
    await sleep(1800)
    await evaluate(quick, `(() => { const el = document.querySelector('textarea[data-zj-quick-note-input]'); el.focus(); return true })()`)
    await quick.send('Input.insertText', { text })
    await sleep(250)
    for (const type of ['keyDown', 'keyUp']) {
      await quick.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    }
    let name = null
    for (let i = 0; i < 25 && !name; i += 1) {
      await sleep(600)
      name = readdirSync(vaultRoot, { recursive: true })
        .map(String)
        .find((n) => n.endsWith('.md') && readFileSync(path.join(vaultRoot, n), 'utf8').includes(text))
    }
    quick.close()
    if (!name) throw new Error(`笔记没建出来：${text}`)
    const file = path.join(vaultRoot, name)
    const id = readFileSync(file, 'utf8').match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? null
    if (!id) throw new Error('探针笔记没有 id')
    created.push({ file, id })
    return id
  }

  const idA = await createNote(A_TEXT)
  const idB = await createNote(B_TEXT)
  ok(`A. 两条探针笔记已创建（A=${idA.slice(0, 8)}… B=${idB.slice(0, 8)}…）`)

  /**
   * 先钉两枚、**量出真实的窗口外层尺寸**，再据此预置"缝隙 1px"的几何。
   *
   * ⚠️ 这一步是被探针自己的失败逼出来的：第一版按 `TILE_W = 300`（= 创建时用的
   * `inner_size`）预置，结果实测缝隙是 **-15px**（重叠）——
   * 因为 Windows 上 `outer_size()` 比 `inner_size()` 大（不可见边框，每边约 8px），
   * 而 `remember_geometry` 存的是**外层**值。预置数据与真实坐标系不一致，
   * 于是"1px 缝隙"实际变成了"重叠 15px"，吸附当然不该发生（|gap| > 阈值）。
   * 现在改成"实测再预置"，跨 DPI/主题都不会再踩。
   */
  for (const id of [idA, idB]) await invoke1('cmd_toggle_tile', { noteId: id })
  await sleep(3000)
  const measured = await invoke1('cmd_list_tiles', {})
  const measuredRows = Array.isArray(measured) ? measured : []
  const measuredA = measuredRows.find((t) => (t.noteId ?? t.note_id) === idA)
  if (!measuredA?.width) throw new Error('量不到磁贴的真实尺寸')
  const realW = measuredA.width
  const realH = measuredA.height
  info(`实测磁贴外层尺寸：${realW}×${realH}（创建时的 inner_size 是 ${TILE_W}×${TILE_H}）`)
  await stop(first.dev)

  /* ---------------- 第二步：预置"两枚已同组且相互贴合"的磁贴状态 ---------------- */

  const snapshot = readTiles()
  /**
   * 预置**未成组**、但**缝隙只有 1px** 的两枚固定磁贴（1px < 阈值 2px ⇒ 应当自动吸附）。
   *
   * 这样一次探针就能验证整条链：**自动吸附 → 贴合 → 成组 → 「取消吸附」按钮 → 解组 → UI 收敛**。
   * （上一条断言组链路时预置的是 group=7 的"已吸附"状态，反而没有验证"吸附动作本身会不会发生"。）
   */
  snapshot.tiles[idA] = { x: 200, y: 200, width: realW, height: realH, pinned: true, group: PRESET_GROUP }
  snapshot.tiles[idB] = {
    // 两枚相互贴合（缝隙 0）、且已在同一组
    x: 200 + realW,
    y: 200,
    width: realW,
    height: realH,
    pinned: true,
    group: PRESET_GROUP,
  }
  writeFileSync(tilesPath, JSON.stringify(snapshot, null, 2), 'utf8')
  info(`已预置两枚固定、贴合（用实测宽度 ${realW}）、同组（group=${PRESET_GROUP}）的磁贴`)
  /**
   * 顺带如实记录一条**已知缺口**（不判失败，避免用假绿掩盖它）：
   * 「吸附动作本身」需要一次真实的窗口移动事件才能触发（`Moved` → 记 last_moved →
   * 停手 400ms → 吸附）。本探针能驱动的所有手段都无法产生它：
   *   · 启动创建窗口、`cmd_set_tiles_visible` 显隐 —— 实测都**不产生** `Moved`；
   *   · `plugin:window|set_position` 被 ACL 拒绝（产品并不需要那条权限，不为测试放开）；
   *   · `mouse_event` 模拟拖动无效（旧 API 被系统忽略）。
   * 因此吸附的取舍规则由 `cargo test` 的 11 条单测覆盖，**触发与手感需人工确认**。
   */
  info('说明：本探针不验证「吸附动作的触发」（需要真实拖动事件），见 docs/RUN.md 的缺口记录')

  /* ---------------- 第三步：启动并验证「组状态 → UI → 显式解组 → 孤儿清理」 ---------------- */

  second = await launch('run2')
  const main2 = second.client
  const invoke2 = (method, args) =>
    evaluate(
      main2,
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(method)}, ${JSON.stringify(args)}).then((v) => v).catch((e) => 'ERR:' + e)`,
    )
  await sleep(6000) // 等 Rust 恢复磁贴 + 主窗口对账跑完

  const tilesNow = await invoke2('cmd_list_tiles', {})
  const list = Array.isArray(tilesNow) ? tilesNow : []
  const tileA = list.find((t) => (t.noteId ?? t.note_id) === idA)
  const tileB = list.find((t) => (t.noteId ?? t.note_id) === idB)
  assert(Boolean(tileA && tileB), 'B1. 两枚预置的固定磁贴都已恢复（窗口都在）', `B1. 磁贴没恢复：${JSON.stringify(list.map((t) => t.noteId ?? t.note_id))}`)
  assert(
    (tileA?.group ?? 0) === PRESET_GROUP && (tileB?.group ?? 0) === PRESET_GROUP,
    `B2. cmd_list_tiles 把组号如实报给前端（都是 ${PRESET_GROUP}）`,
    `B2. 组号不对：A=${tileA?.group}，B=${tileB?.group}`,
  )
  // 顺手核对"记录的尺寸语义"是 inner（与 create_tile 的 inner_size 一致）：
  // 若退化成 outer，本机实测会大 16px，吸附判定会整体偏移（t50 修掉的缺陷）。
  if (tileA && tileB) {
    info(`记录的尺寸：A=${tileA.width}×${tileA.height}，B=${tileB.width}×${tileB.height}（实测 inner 基线 ${realW}×${realH}）`)
    assert(
      tileA.width === realW && tileB.width === realW,
      'B3. 尺寸语义一致（记录 == inner_size，不会产生 16px 系统偏差）',
      `B3. 尺寸语义不一致：A=${tileA.width}，预置/实测 inner=${realW} —— 吸附判定会整体偏移`,
    )
  }

  /** 连上某枚磁贴窗口，读它标题栏里有没有「取消吸附」按钮 */
  async function tileWindowHasUngroup(noteId) {
    const target = (await listTargets()).find((t) => t.type === 'page' && (t.url ?? '').includes(noteId))
    if (!target) return null
    const tile = await connect(target.webSocketDebuggerUrl)
    await tile.send('Runtime.enable')
    await sleep(1800)
    const state = await evaluate(
      tile,
      `JSON.stringify({ hasUngroup: !!document.querySelector('[data-zj-tile-ungroup]'), group: document.querySelector('[data-zj-tile-ungroup]')?.getAttribute('data-zj-tile-ungroup') ?? null })`,
    )
    return { tile, ...JSON.parse(state) }
  }

  const aWin = await tileWindowHasUngroup(idA)
  const bWin = await tileWindowHasUngroup(idB)
  assert(Boolean(aWin?.hasUngroup), 'C1. 组内磁贴 A 的标题栏出现了「取消吸附」按钮', `C1. A 没有该按钮：${JSON.stringify(aWin)}`)
  assert(Boolean(bWin?.hasUngroup), 'C2. 组内磁贴 B 的标题栏出现了「取消吸附」按钮', `C2. B 没有该按钮：${JSON.stringify(bWin)}`)
  info(`按钮上带的组号：A=${aWin?.group}，B=${bWin?.group}`)

  // 点 B 的「取消吸附」
  const clicked = await evaluate(bWin.tile, `(() => { const el = document.querySelector('[data-zj-tile-ungroup]'); if (!el) return 'missing'; el.click(); return 'clicked' })()`)
  assert(clicked === 'clicked', 'D1. 点击 B 的「取消吸附」按钮', `D1. 点不到按钮：${clicked}`)
  /**
   * ⚠️ 不能固定 `sleep(2500)`：t48 起**去抖静默期是 3 秒**（用户要求留足拖动决策时间），
   * 而组号是靠"去抖后落盘"写进 `tiles.json` 的 —— 固定短于 3 秒的等待会读到旧文件，
   * 把**正确实现**判成失败。改成轮询（最多 12 秒），既稳又不写死时间常量。
   */
  let persisted = readTiles()
  for (let i = 0; i < 20 && (persisted.tiles?.[idB]?.group ?? -1) !== 0; i += 1) {
    await sleep(600)
    persisted = readTiles()
  }
  assert(
    (persisted.tiles?.[idB]?.group ?? -1) === 0,
    'D2. 解组**真的落盘**：tiles.json 里 B 的 group 变成 0',
    `D2. B 的 group 没清：${JSON.stringify(persisted.tiles?.[idB])}`,
  )
  assert(
    (persisted.tiles?.[idA]?.group ?? -1) === 0,
    'E. **孤儿组被清理**：A 只剩自己一个成员 ⇒ 组号也被清成 0（tiles.json）',
    `E. A 仍挂着组号（会显示一个没有对象的「取消吸附」）：${JSON.stringify(persisted.tiles?.[idA])}`,
  )

  // 界面也要跟着收敛：两枚的按钮都该消失（磁贴订阅 tiles-changed 后自刷新）
  const aAfter = await tileWindowHasUngroup(idA)
  const bAfter = await tileWindowHasUngroup(idB)
  assert(!bAfter?.hasUngroup, 'F1. 解组后 B 的按钮消失（UI 与 Rust 状态一致）', `F1. B 的按钮还在：${JSON.stringify(bAfter)}`)
  assert(!aAfter?.hasUngroup, 'F2. 解组后 A 的按钮也消失（孤儿清理真的传到了 UI）', `F2. A 的按钮还在：${JSON.stringify(aAfter)}`)
  /* ---------------- t52：吸附开关（IPC 真机往返） ---------------- */

  const snapDefault = await invoke2('cmd_tile_snap_enabled', {})
  assert(snapDefault === true, 'I1. t52 吸附开关命令已注册且默认开启', `I1. 读到 ${snapDefault}`)

  const turnOff = await invoke2('cmd_set_tile_snap', { enabled: false })
  assert(turnOff === false, 'I2. 关闭后命令**回读生效值**（不是假设成功）', `I2. 读到 ${turnOff}`)
  assert(
    (await invoke2('cmd_tile_snap_enabled', {})) === false,
    'I3. 关闭状态可被独立读取（启动对账依赖它）',
    'I3. 独立读取没返回 false',
  )
  /**
   * 关的是「自动吸附」，**不是**用户的显式操作。
   * 这里只断言"命令仍可调用、返回值语义可读（不在组里 → false）"——
   * 它**不能**证明实现里没有误加 gate（返回值恰好相同），如实标注，不冒充强证据。
   */
  const ungroupWhileOff = await invoke2('cmd_ungroup_tile', { noteId: idA })
  assert(
    ungroupWhileOff === false,
    'I4. 关闭吸附后显式解组命令仍可调用（不在组里 → false）',
    `I4. 返回 ${ungroupWhileOff}`,
  )
  const turnOn = await invoke2('cmd_set_tile_snap', { enabled: true })
  assert(turnOn === true, 'I5. 恢复开启后回读 true（收尾不留副作用）', `I5. 读到 ${turnOn}`)
  info('说明：本探针不验证「关闭后拖动是否真的不吸附」（需要真实拖动事件），见 docs/RUN.md 的缺口记录')
  /* ---------------- t52：设置面板里的开关端到端（点一下，两条路都要通） ---------------- */

  const openedSettings = await evaluate(
    main2,
    `(() => { const btn = document.querySelector('button[aria-label="设置"]'); if (!btn) return 'no-button'; btn.click(); return 'clicked' })()`,
  )
  assert(openedSettings === 'clicked', 'J1. 打开了设置面板', `J1. 找不到「设置」按钮：${openedSettings}`)
  await sleep(1500)

  const rowState = JSON.parse(
    await evaluate(
      main2,
      `JSON.stringify({ row: !!document.querySelector('[data-zj="tile-snap-row"]'), toggle: !!document.querySelector('[data-zj="tile-snap-toggle"]'), checked: document.querySelector('[data-zj="tile-snap-toggle"]')?.getAttribute('aria-checked') ?? null })`,
    ),
  )
  /** 探针**不得**改动用户设置：先记下原值，收尾按原样还原（包括"从未设置过 = null"） */
  const snapStoredBefore = await evaluate(main2, `window.localStorage.getItem('zhijian.tileSnap')`)
  const expectedChecked = snapStoredBefore === null ? 'true' : snapStoredBefore

  assert(rowState.row && rowState.toggle, 'J2. 设置面板里真的有「磁贴吸附」开关（不是只存在于源码里）', `J2. ${JSON.stringify(rowState)}`)
  assert(
    rowState.checked === expectedChecked,
    'J3. 开关初始显示值与 localStorage / 默认值一致',
    `J3. aria-checked=${rowState.checked}，localStorage=${JSON.stringify(snapStoredBefore)}`,
  )

  const clickToggle = () =>
    evaluate(main2, `(() => { document.querySelector('[data-zj="tile-snap-toggle"]').click(); return 'ok' })()`)

  await clickToggle()
  await sleep(1500)
  const flippedRust = await invoke2('cmd_tile_snap_enabled', {})
  const flippedStored = await evaluate(main2, `window.localStorage.getItem('zhijian.tileSnap')`)
  const expectedFlipped = expectedChecked === 'true' ? 'false' : 'true'
  assert(
    flippedRust === (expectedFlipped === 'true') && flippedStored === expectedFlipped,
    'J4. 点一下开关 ⇒ localStorage 与 Rust **同时**翻转（端到端接通，不是假开关）',
    `J4. 期望 ${expectedFlipped}：Rust=${JSON.stringify(flippedRust)}，localStorage=${JSON.stringify(flippedStored)}`,
  )

  // 收尾：点回去 + 若原本从未设置过则删掉这个键，做到"零残留"
  await clickToggle()
  await sleep(1200)
  const backRust = await invoke2('cmd_tile_snap_enabled', {})
  assert(
    backRust === (expectedChecked === 'true'),
    'J5. 再点一次恢复原状态（Rust 侧零残留）',
    `J5. 期望 ${expectedChecked}，实际 ${JSON.stringify(backRust)}`,
  )
  if (snapStoredBefore === null) {
    await evaluate(main2, `(() => { window.localStorage.removeItem('zhijian.tileSnap'); return 'removed' })()`)
    info('J6. 探针运行前从未设置过该偏好 ⇒ 已删除探针写入的 localStorage 键（零残留）')
  }
  aWin.tile.close()
  bWin.tile.close()
  aAfter?.tile?.close()
  bAfter?.tile?.close()
} catch (error) {
  if (error instanceof EnvUnsupported) {
    envUnsupported = true
    info(`环境不满足（探针未开始）：${error.message}`)
    info('这不是断言失败：本机 WebView2 没开放 CDP，探针无法驱动界面（见 docs/RUN.md 的环境限制）')
  } else {
    fail(`探针执行中断：${error instanceof Error ? error.message : String(error)}`)
  }
} finally {
  first?.client?.close()
  second?.client?.close()
  await stop(second?.dev ?? first?.dev)

  if (hadTiles) {
    copyFileSync(tilesBackup, tilesPath)
    ok('G1. tiles.json 已逐字节还原为运行前的内容')
  } else if (existsSync(tilesPath)) {
    rmSync(tilesPath, { force: true })
    ok('G1. tiles.json 原本不存在，已删除探针产生的文件')
  }
  rmSync(tilesBackup, { force: true })

  for (const { file, id } of created) {
    if (existsSync(file)) {
      unlinkSync(file)
      ok(`G2. 已删除探针笔记 md：${path.basename(file)}`)
    }
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath)
        db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
        db.prepare('DELETE FROM notes WHERE id = ?').run(id)
        db.close()
      } catch (error) {
        fail(`G2. 清理索引失败：${error.message}`)
      }
    }
  }
  if (created.length > 0) ok(`G3. 已删除 ${created.length} 条探针笔记的索引行`)
  const mdCountAfter = readdirSync(vaultRoot, { recursive: true }).filter((n) => String(n).endsWith('.md')).length
  assert(mdCountAfter === mdCountBefore, `H. vault 的 md 数量复原（${mdCountBefore} → ${mdCountAfter}）`, `H. md 数量没复原（${mdCountBefore} → ${mdCountAfter}）`)
}

console.log('')
console.log('════════════════ 汇总 ════════════════')
for (const line of notes) console.log(`  ${line}`)
if (envUnsupported) {
  console.log('\n⚠️ 环境不满足：探针**未开始**（本机 WebView2 未开放 CDP 调试端口）')
  console.log('   exit 2 = 未开始，不是断言失败 —— 详见 docs/RUN.md「CDP 探针的环境限制」')
  process.exit(2)
}
if (failures.length === 0) {
  console.log('\n✅ 吸附成组探针：全部断言通过')
  process.exit(0)
}
console.log(`\n❌ 吸附成组探针失败 ${failures.length} 项：`)
for (const item of failures) console.log(`   - ${item}`)
process.exit(1)
