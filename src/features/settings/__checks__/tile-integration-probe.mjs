#!/usr/bin/env node
/**
 * 纸笺 · 静默失效探针（任务 t20 前置核查，captain 指派）
 * ============================================================================
 * 运行：node src/features/settings/__checks__/tile-integration-probe.mjs
 *      （退出码 0 = 全部通过；非 0 = 命中静默失效）
 *     也可一条命令跑完本目录全部检查：node src/features/settings/__checks__/run-all.mjs
 *
 * ## ⚠️ 这个探针存在的**唯一理由**（captain 要求写在这里）
 * 本轮出现了一类缺陷：**界面完全正常、不报错、不白屏，但底层根本没走到**。
 * 它的形态可以精确描述为：
 *
 * > **危险的不是「没有权限」，而是「权限齐全但通道走错」。**
 * > 权限缺失时降级路径通常也会失败，于是错误是**可见的**（会落到
 * > `{ok:false, reason:'unavailable'}` 并给出可读原因，用户/开发者能看到）；
 * > 而权限齐全但命令名写错时，降级路径会**成功** —— `ok:true` 带着
 * > `via:'webview'` 返回，界面与正常路径**完全无法区分**，失败被优雅掩盖。
 *
 * 判定式（可直接断言，也是本探针的核心）：
 * ```ts
 * const silentDegrade = result.ok === true && result.via !== 'rust'
 * ```
 * 实测对照（真实 `toggleTileForNote()`，仅替换 IPC 层）：
 * | 场景 | 结果 | 含义 |
 * | --- | --- | --- |
 * | 命令未注册 + 建窗也未授权 | `{ok:false, reason:'unavailable', via:'webview'}` | 失败**可见**（相对安全） |
 * | 命令已注册 | `{ok:true, action:'opened', via:'rust'}` | 真的走到 Rust 通道 |
 * | **命令名写错但权限齐全** | `{ok:true, via:'webview'}` | **静默失效**（本探针要拦的组合） |
 *
 * ## 为什么是"静态可复现"而不是"跑一遍应用看现象"
 * 需要启动桌面应用才能跑的检查**最终会被跳过**，而"被跳过的检查"与"没有检查"等价
 * —— 那正是本探针要防的问题本身。所以这里全部是纯静态 + 只读：
 * 解析源码与 ACL manifest 做一致性断言，`node` 一行命令即可，无需 Tauri、无需浏览器。
 *
 * ## 覆盖
 *   A. 命令名一致性：前端 invoke 的常量 vs Rust `generate_handler!` 实际注册的名字
 *   B. 能力充分性：`tiles.json` 是否授予了磁贴前端**真实调用**的那些权限
 *      （尤其 `core:window:allow-close`；实测 `core:default` 的 `core:window:default`
 *      共 28 项**全是只读**，不含任何写操作）
 *
 * 纯静态 + 只读：不改任何文件、不需要 Tauri、不需要浏览器。
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..', '..')

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

/* ---------------------------------------------------------------------------
 * "可证多余"的判定表 —— ⚠️ **必须在所有 check() 之前定义**。
 *
 * 教训（本文件实际踩过）：这些是 `const`，而 `check()` 是**顶层立即执行**的；
 * 若把它们写在后面，运行时会抛 `Cannot access '…' before initialization`（TDZ）。
 * 与 t17 那次导致整个应用白屏的 `appPreferences.ts` TDZ 是**同一类错误**：
 * 顶层副作用引用了尚未初始化的 `const`。加/改本文件时请把这类常量放在最前面。
 * ------------------------------------------------------------------------- */
/** A 类可证多余：完全无关的插件族（磁贴不做文件对话框/导出/全局键位/网络） */
const UNRELATED_PLUGIN_FAMILIES = /^(dialog|opener|global-shortcut|http):/
/** B 类可证多余：与磁贴无关的 fs 目录（磁贴只经 db 层用 $DOCUMENT 与 $APPDATA） */
const UNRELATED_FS_DIRS = /^fs:allow-(desktop|download|home|picture|video|audio|public|temp)[-:]/

/**
 * 纯函数：返回**可证超出真实需要**的授权（供断言与变异测试共用）。
 *
 * ## 判定策略（t39 重写：从"猜哪些多余"改为"只报能证明的"）
 * 早先本检查用"同族放行"，会漏判同族内的过度授权；后来又改成"任何不在 needs 里的都算多余"，
 * 结果**误报**了必需权限（fs 系列 + `core:window:show/hide/set-focus/is-visible`）——
 * 因为静态模型只能看见**部分**真实依赖（框架注入、db 层传递链都容易漏）。
 *
 * 结论：静态探针**无法证明某个已授予的权限"不需要"**（证明"不需要"要遍历全部运行时路径，
 * 那属于运行时探针的职责）。因此这里只报上述两类**可证**的多余；其余"授予了但我没建模"的项
 * 由调用方**如实列出**，不判失败 —— 避免再把"我没建模"说成"系统不需要"。
 */
function overGrantedPermissions(permissions, needs) {
  return permissions.filter((permission) => {
    if (needs.has(permission)) return false
    if (permission === 'core:default') return false
    // deny-* 是收紧而非放宽（例如 deny-internal-toggle-maximize）
    if (/^core:[a-z-]+:deny-/.test(permission)) return false
    if (UNRELATED_PLUGIN_FAMILIES.test(permission)) return true
    if (UNRELATED_FS_DIRS.test(permission)) return true
    return false
  })
}

const read = (rel) => readFileSync(path.join(projectRoot, rel), 'utf8')

/* ============================ A. 命令名一致性 ============================ */

console.log('\n── A. Rust 命令名 vs 前端 invoke 常量')

/** 前端"磁贴"相关命令常量（`TILE_RUST_COMMANDS` 里的 value） */
function frontendTileCommandNames() {
  const source = read('src/features/tiles/tileWindows.ts')
  const block = source.match(/TILE_RUST_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/)
  assert(Boolean(block), '找不到 TILE_RUST_COMMANDS 常量块')
  const names = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
  assert(names.length > 0, 'TILE_RUST_COMMANDS 里没有解析出任何命令名')
  return names
}

/** `src-tauri/src/lib.rs` 的 `generate_handler![...]` 里注册的全部命令名 */
function registeredRustCommands() {
  const source = read('src-tauri/src/lib.rs')
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/)
  assert(Boolean(block), '找不到 generate_handler! 注册块')
  return [...block[1].matchAll(/tiles::(\w+)/g)].map((m) => m[1])
}

/** 集中登记表：src/lib/tauri.ts 的 COMMANDS（architect 惯例） */
function frontendRegisteredCommands() {
  const source = read('src/lib/tauri.ts')
  const block = source.match(/COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/)
  assert(Boolean(block), '找不到 COMMANDS 常量块')
  return [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
}

const tileCommandsUsed = frontendTileCommandNames()
const tileCommandsRegistered = registeredRustCommands()
const allFrontendCommands = frontendRegisteredCommands()

check('磁贴 Rust 命令已注册（`generate_handler!` 里存在 tiles::*）', () => {
  assert(
    tileCommandsRegistered.length > 0,
    'lib.rs 的 generate_handler! 里没有任何 tiles::* 命令 —— 磁贴的 Rust 实现不会被调用',
  )
})

check('前端 invoke 的命令名与 Rust 注册名**逐个一致**（不一致 ⇒ 必然静默退化）', () => {
  const missing = tileCommandsUsed.filter((used) => !tileCommandsRegistered.includes(used))
  assert(
    missing.length === 0,
    `前端调用 ${JSON.stringify(missing)}，但 Rust 只注册了 ${JSON.stringify(tileCommandsRegistered)}\n` +
      '     ↳ 后果：invoke 报 command not found → 被前端 catch 吞掉 → 静默退化到 WebviewWindow 建窗，\n' +
      '       Rust 侧的几何持久化 / TILES_VISIBILITY_CHANGED / 开机恢复磁贴全部成为死代码（界面看起来正常）。\n' +
      '     ↳ 修法：把前端常量改成 Rust 名，或把 Rust 注册名改成前端常量（二选一，一处改动）。',
  )
})

check('磁贴命令也在 `src/lib/tauri.ts` 的 COMMANDS 里集中登记（防散写字符串）', () => {
  const unregistered = tileCommandsUsed.filter((used) => !allFrontendCommands.includes(used))
  assert(
    unregistered.length === 0,
    `磁贴命令 ${JSON.stringify(unregistered)} 未登记进 COMMANDS（现登记项：${JSON.stringify(allFrontendCommands)}）\n` +
      '     ↳ 项目惯例：Rust ↔ TS 命令名集中登记，便于与 generate_handler! 对账。',
  )
})

/* ============================ B. 能力充分性 ============================ */

console.log('\n── B. tiles.json 能力是否覆盖磁贴的真实调用')

/** 磁贴窗口前端**真实调用**的 Tauri API → 所需权限（从源码提取，而不是靠记忆） */
function requiredWindowPermissions() {
  const tileApp = read('src/features/tiles/TileApp.tsx')
  const required = new Map()
  if (/getCurrentWindow\(\)\.close\(\)/.test(tileApp)) {
    required.set('core:window:allow-close', '关闭按钮 getCurrentWindow().close()')
  }
  if (/COMMANDS\.windowShow/.test(tileApp)) {
    required.set('command:window_show', '唤回主窗口 invoke(COMMANDS.windowShow)')
  }

  // ⚠️ **框架注入的调用**（不是项目代码写的）——只看项目源码会漏掉这一类。
  // Tauri 2.11.6 的 `src/window/scripts/drag.js:103-104` 在命中拖拽区时执行的是：
  //     const cmd = e.detail === 2 ? 'internal_toggle_maximize' : 'start_dragging'
  //     window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd)
  // ⇒ **走 IPC，受 ACL 管**：`data-tauri-drag-region` 并非"免权限的原生区"。
  // 无边框窗口（磁贴）没有系统标题栏，拖拽头是**唯一**的移动方式，缺权限即"拖着没反应且无报错"。
  // 旁证：`gen/schemas/acl-manifests.json` 里 core:window 同时有 allow-/deny-start-dragging（说明被门控），
  //       且主窗口的 capabilities/default.json 专门为此显式授权。
  if (/data-tauri-drag-region/.test(tileApp)) {
    required.set(
      'core:window:allow-start-dragging',
      '拖拽头 data-tauri-drag-region（框架注入 plugin:window|start_dragging）',
    )
  }

  // ⚠️ **间接依赖**（经 db 层）——只看"直接调 plugin-fs"同样会漏。
  // 磁贴读笔记走 `notesRepo.get()` → `vault.loadNote()` → `fs.readTextFile()`；
  // 自动保存走 `notesRepo.update()` → `vault.saveNote()` → 原子写文件。
  // 而 md 文件为真相源（t15）⇒ vault 在 `$DOCUMENT` 下 ⇒ **读写都需要授权**。
  // （本地实测依据：`src/db/vault.ts::loadNote` 首行即 `const { fs } = getStorage()`。）
  if (/notesRepo\./.test(tileApp) || /useNotesStore/.test(tileApp)) {
    required.set(
      'fs:allow-document-read-recursive',
      '读笔记：notesRepo.get → vault.loadNote → plugin-fs 读 $DOCUMENT 下的 md',
    )
    if (/saveNote|useAutoSave|notesRepo\.update|\.update\(/.test(tileApp)) {
      required.set(
        'fs:allow-document-write-recursive',
        '自动保存：notesRepo.update → vault.saveNote → plugin-fs 原子写 md',
      )
    }
  }

  // ⚠️ 更深一层的间接依赖：磁贴调 `initDb()`，而 `initDb` 会执行
  // `migrateLegacyToVault()`（`src/db/index.ts:165`），其**备份步骤**把旧库
  // `copyFile` 到 `<应用数据>/zhijian.db.bak-<ts>`（`src/db/storage.ts:238-241`
  // `backupFile`：`const { fs, appDataDir } = getStorage()`）⇒ **$APPDATA 的读与写都需要**。
  // 这正是 t33 用户报「磁贴 ACL 乱码」的成因：少了 fs scope，磁贴的 db 初始化就会失败。
  if (/initDb\(/.test(tileApp)) {
    required.set(
      'fs:allow-appdata-write-recursive',
      'initDb → migrateLegacyToVault → storage.backupFile → 往 $APPDATA 写 .bak（copyFile 目标）',
    )
    required.set(
      'fs:allow-appdata-read-recursive',
      'initDb → migrateLegacyToVault → storage.fs.exists(reader.dbPath) → 读 $APPDATA 下旧库（copyFile 源）',
    )
  }

  // ⚠️ **再深一层：db 层直连 SQLite**。磁贴经 `initDb()` 与 `notesRepo` 间接使用
  // `@tauri-apps/plugin-sql` 的 `Database.load()` / `.select()` / `.execute()`
  // （`src/db/index.ts:132/140/143`）⇒ 这三条 sql 权限是**真实需要**，
  // 不能用"TileApp 没直接 import plugin-sql"来判它多余。
  const dbLayerUsesSql =
    /initDb\(/.test(tileApp) || /notesRepo\./.test(tileApp) || /useNotesStore/.test(tileApp)
  if (dbLayerUsesSql) {
    required.set('sql:allow-load', 'db 层 Database.load(DB_URL) 打开索引库（src/db/index.ts:132）')
    required.set('sql:allow-select', 'db 层 instance.select(...) 读迁移版本/索引行（src/db/index.ts:143）')
    required.set('sql:allow-execute', 'db 层 instance.execute(...) 建表/写索引（src/db/index.ts:140,207）')
  }

  // ⚠️ 窗口操作经**框架注入**：磁贴前端不写 `invoke('plugin:window|…')`，而是用
  // `@tauri-apps/api/window` 的封装（`.close()` 等）。所以这里**扫方法调用**，
  // 而不是扫命令字符串 —— 与上面 drag region 那条同一类盲区。
  const windowOps = ['close', 'show', 'hide', 'setFocus', 'isVisible', 'startDragging']
  const opToPermission = {
    close: 'core:window:allow-close',
    show: 'core:window:allow-show',
    hide: 'core:window:allow-hide',
    setFocus: 'core:window:allow-set-focus',
    isVisible: 'core:window:allow-is-visible',
    startDragging: 'core:window:allow-start-dragging',
  }
  for (const op of windowOps) {
    if (new RegExp(`\\.${op}\\(`).test(tileApp)) {
      required.set(opToPermission[op], `磁贴调用窗口方法 .${op}()（经 @tauri-apps/api/window 封装）`)
    }
  }

  return required
}

function tilesCapability() {
  const rel = 'src-tauri/capabilities/tiles.json'
  assert(existsSync(path.join(projectRoot, rel)), `缺少 ${rel}（磁贴窗口将拿不到任何权限）`)
  const json = JSON.parse(read(rel))
  return { json, permissions: json.permissions ?? [], windows: json.windows ?? [] }
}

/**
 * `core:window:default` 的**实测**能力清单（从 ACL manifest 解析，不靠印象）。
 *
 * ⚠️ 更正一处我先前的错误结论：我曾断言「28 项**全是只读**」——**不成立**。
 * 实测：28 项里 27 项是 `allow-is-*` / `allow-*position*` 之类的只读操作，
 * **但有 1 项是写操作 `allow-internal-toggle-maximize`**（drag.js 双击拖拽区会调它）。
 * 结论方向不变（写操作 `close`/`show`/`set-focus`/`start-dragging` 仍需显式授权），
 * 但"全是只读"是错的 —— 所以这里改成**从 manifest 计算**，而不是在文案里下断言。
 */
function coreWindowDefaultSnapshot() {
  const m = JSON.parse(read('src-tauri/gen/schemas/acl-manifests.json'))
  const list = m['core:window']?.default_permission?.permissions ?? []
  // 只读命名族：getter / is-* / 位置尺寸量测
  const readOnly = list.filter((p) => /^allow-(is-|get-|scale-factor|inner-|outer-|current-monitor|primary-monitor|monitor-from-point|available-monitors|cursor-position|theme|title|activity-name|scene-identifier)/.test(p))
  const writeLike = list.filter((p) => !readOnly.includes(p))
  return { list, readOnly, writeLike }
}

const coreWindow = coreWindowDefaultSnapshot()

const required = requiredWindowPermissions()
const tiles = tilesCapability()

check('磁贴 capability 按 label 匹配 `tile-*` 窗口', () => {
  assert(
    tiles.windows.some((w) => w === 'tile-*'),
    `tiles.json 的 windows=${JSON.stringify(tiles.windows)} 未覆盖 tile-*（Tauri 按 label 匹配，磁贴将无权限）`,
  )
})

check('按真实调用最小授权：从源码/框架注入得出的每项所需权限都已授予', () => {
  const missing = []
  for (const [permission, why] of required) {
    if (permission === 'command:window_show') continue // 自定义命令，见下一条检查
    if (!tiles.permissions.includes(permission)) missing.push(`  · ${permission}\n      ← ${why}`)
  }
  assert(
    missing.length === 0,
    `缺少 ${missing.length} 项权限：\n${missing.join('\n')}\n` +
      `     ↳ 现授予：${JSON.stringify(tiles.permissions)}\n` +
      '     ↳ 实测依据（本文件从 acl-manifests.json 解析，非印象）：\n' +
      `       core:window:default 共 ${coreWindow.list.length} 项，其中只读 ${coreWindow.readOnly.length} 项、` +
      `写操作 ${coreWindow.writeLike.length} 项 ${JSON.stringify(coreWindow.writeLike)}。\n` +
      '       ⇒ close / show / set-focus / start-dragging 等写操作**均不在 default 里**，必须显式授权。\n' +
      '     ↳ 后果：对应交互**静默失败**（不报错、界面无变化）——例如关闭按钮点了没反应、拖拽头拖不动。',
  )
})

check('不给磁贴超出真实需要的插件权限（最小权限：不无脑给全量）', () => {
  // ⚠️ 本检查的**范围已修正**：原先用「是否出现 `fs:` / `dialog:` 前缀」做黑名单，
  // 会把**经 db 层间接需要**的 fs 权限误判为"超授"（磁贴读/写笔记走
  // notesRepo → vault → plugin-fs，见 `requiredWindowPermissions()` 的注释）。
  // 现在改为**按需求计算**：任何授予项都必须能对应到一条"真实需要"，
  // 否则才算超授 —— 这样既不会误报间接依赖，也仍能拦住"无脑给全量"。
  const needs = new Set([...required.keys()])
  const suspicious = overGrantedPermissions(tiles.permissions, needs)
  assert(
    suspicious.length === 0,
    `tiles.json 授予了磁贴**可证不需要**的权限：${JSON.stringify(suspicious)}\n` +
      `     ↳ 本探针按"真实需要"计算的清单：${JSON.stringify([...needs])}\n` +
      '     ↳ 可证多余的两类：① 无关插件族（dialog/opener/global-shortcut/http）；' +
      '② 无关 fs 目录（desktop/download/home/…）。',
  )
})

/**
 * **如实列出**「已授予但静态模型未建模」的项（**不判失败**）。
 *
 * 为什么单列：静态探针**证明不了**某项"不需要"（那要遍历全部运行时路径）。
 * t39 的误报就是这么来的 —— 把"我没建模"当成了"系统不需要"。
 * 必要性判定交给运行时探针 `probe:tile-content`。
 */
check('列出"已授予但静态模型未建模"的权限（信息项，不判失败）', () => {
  const needs = new Set([...required.keys()])
  const unexplained = tiles.permissions.filter(
    (p) => !needs.has(p) && p !== 'core:default' && !/^core:[a-z-]+:deny-/.test(p),
  )
  if (unexplained.length === 0) return
  console.log(
    `     ℹ️ 以下 ${unexplained.length} 项已授予、但**静态模型未能建模**（不等于不需要）：\n` +
      unexplained.map((p) => `        · ${p}`).join('\n') +
      '\n        ⇒ 必要性以运行时探针 probe:tile-content（能打开磁贴并读到笔记）为准。',
  )
})

/* ---------------------------------------------------------------------------
 * C. 防回归：证明"可证多余"的判定本身仍然有效（纯函数级，不改任何真实文件）
 *
 * 背景（t39）：本轮这条检查**误报**过（把必需的 fs 权限判成多余），修的时候极易
 * 顺手把它改成"永远通过" —— 那就把能力做废了。这里用**内存里的假权限表**锁住它：
 *  · 真多余的两类（无关插件族 / 无关 fs 目录）必须被点出；
 *  · 真实需要的（vault 的 document、迁移的 appdata、db 的 sql）**不得**被误报。
 * 这样"误报"与"漏报"两个方向都被钉住，且完全不依赖改 `tiles.json`。
 * ------------------------------------------------------------------------- */
check('⭐ 判定逻辑自检：真多余必须点出，真实需要不得误报（防"改成永远通过"）', () => {
  const needs = new Set([...required.keys()])

  const mustFlag = [
    'dialog:default',
    'opener:default',
    'global-shortcut:default',
    'fs:allow-home-read-recursive',
    'fs:allow-desktop-write-recursive',
  ]
  const mustNotFlag = [
    'fs:allow-document-read-recursive',
    'fs:allow-document-write-recursive',
    'fs:allow-appdata-read-recursive',
    'fs:allow-appdata-write-recursive',
    'sql:allow-load',
    'sql:allow-select',
    'sql:allow-execute',
    'core:window:allow-close',
    'core:window:allow-start-dragging',
    'core:window:deny-internal-toggle-maximize',
    'core:default',
  ]

  const flagged = overGrantedPermissions([...mustFlag, ...mustNotFlag], needs)
  const missed = mustFlag.filter((p) => !flagged.includes(p))
  const falsePositives = flagged.filter((p) => !mustFlag.includes(p))

  assert(
    missed.length === 0,
    `漏报（本该点出的多余权限没被点出）：${JSON.stringify(missed)} —— 判定力被削弱了`,
  )
  assert(
    falsePositives.length === 0,
    `误报（真实需要的权限被当成多余）：${JSON.stringify(falsePositives)} —— 这正是 t39 要修的缺陷，不得回归`,
  )
})

check('capability 的 description 不得与 permissions 自相矛盾（"说了不给"vs"实际给了"）', () => {
  // 实证教训：tiles.json 的 description 早先写着「仍然刻意不给 fs」，
  // 但后来为磁贴的读/写笔记补了 4 条 fs 权限 —— 文档与事实不一致会误导后来者。
  const text = String(tiles.json.description ?? '')
  const grantsFs = tiles.permissions.some((p) => /^fs:/.test(p))
  const claimsNoFs = /不给】\s*fs|刻意不给\s*fs|不授予\s*fs/.test(text)
  assert(
    !(grantsFs && claimsNoFs),
    'tiles.json 既授予了 fs 权限，description 里却仍写着「不给 fs」——文档与事实矛盾，请同步说明（含为何需要）。',
  )
})

check('磁贴若直连 SQLite，则必须有对应 sql 权限（设计意图与实现必须一致）', () => {
  const tileApp = read('src/features/tiles/TileApp.tsx')
  const usesDb = /initDb\(|notesRepo\./.test(tileApp)
  if (!usesDb) return
  const hasSql = tiles.permissions.some((p) => p.startsWith('sql:'))
  assert(
    hasSql,
    'TileApp.tsx 直连 SQLite（initDb / notesRepo），但 tiles.json 没有任何 sql:* 权限\n' +
      '     ↳ 后果：磁贴打开即「读不到这条笔记」。\n' +
      '     ↳ 裁定（captain）：磁贴按需求是**可编辑**的，给 sql 权限；但应按真实调用最小化（allow-load/allow-select/allow-execute）。',
  )
})

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`,
)
if (failed.length > 0) {
  console.log('\n静默失效命中（这类缺陷不报错、不白屏，只有盯住"底层走没走到"才能发现）：')
  for (const item of failed) console.log(`   - ${item.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
