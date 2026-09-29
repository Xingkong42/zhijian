#!/usr/bin/env node
/**
 * 纸笺 · 前后端契约对账（架构师护栏，t19）
 * ============================================================================
 * 运行：node src/lib/__checks__/contract-checks.mjs   （或 `pnpm check:contract`）
 *      退出码 0 = 三张契约表两侧逐字一致；非 0 = 存在漂移
 *
 * ## 为什么需要它
 * 本项目已经在**同一种失败模式**上栽过两次：
 *   - 磁贴命令名：前端写 `tile_toggle`，Rust 注册 `cmd_toggle_tile`
 *     ⇒ invoke 报 not found 被 catch 吞掉 ⇒ 静默退化到 JS 建窗，界面看起来完全正常；
 *   - `EVENTS` / `COMMANDS` 两张表靠"人记得同步"，没有任何机器检查。
 * 这类缺陷的共同点是**不报错、不白屏、构建门全绿**，只有把「两侧的表」拿来做机器比对才能发现。
 *
 * 因此本脚本只做一件事：**把 TS 侧的登记表与 Rust 侧的登记表逐条互相包含地比一遍**
 * （双向断言：TS 多的报错、Rust 多的也报错 —— 单向包含只能发现一半的漂移）。
 *
 * ## 覆盖
 *   1. `src/lib/tauri.ts::EVENTS`  ↔  `src-tauri/src/events.rs` 的常量 + `ALL` 数组
 *   2. `src/lib/tauri.ts::SHORTCUT_ACTION_IDS` ↔ `src-tauri/src/shortcuts.rs::SUPPORTED_ACTION_IDS`
 *   3. `src/lib/tauri.ts::COMMANDS` ↔ `src-tauri/src/lib.rs::generate_handler!`
 *   4. 设置面板的动作项覆盖度（**缺失只告警不失败** —— 文件不归架构师，属 t20 接线项）
 *
 * 纯静态 + 只读：不改任何文件、不需要 Tauri、不需要浏览器、不需要 cargo。
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/**
 * 仓库根。**可用环境变量 `ZJ_CONTRACT_ROOT` 覆盖，指向一份镜像了相对路径的临时副本** ——
 * 这是给"变异测试"用的：检查本身必须能被证明**会失败**，否则它只是装饰品。
 * 覆盖机制让我们能在临时目录里改坏契约文件来验证脚本会转红，**而不碰真实仓库的任何文件**。
 */
const projectRoot = process.env.ZJ_CONTRACT_ROOT
  ? path.resolve(process.env.ZJ_CONTRACT_ROOT)
  : path.resolve(here, '..', '..', '..')

const results = []
const warnings = []

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

function warn(message) {
  warnings.push(message)
  console.log(`  ⚠️  ${message.replace(/\n/g, '\n      ')}`)
}

const read = (rel) => readFileSync(path.join(projectRoot, rel), 'utf8')

/** 列目录（已排序，保证输出稳定可复现） */
const readDir = (rel) => readdirSync(path.join(projectRoot, rel)).sort()

/** 双向集合比较：任何一侧多出来的条目都要被点名（单向包含只能发现一半的漂移） */
function assertSameSet(a, b, labelA, labelB, hint) {
  const onlyA = a.filter((x) => !b.includes(x))
  const onlyB = b.filter((x) => !a.includes(x))
  assert(
    onlyA.length === 0 && onlyB.length === 0,
    [
      `两侧不一致：`,
      `  ${labelA} 独有 ${JSON.stringify(onlyA)}`,
      `  ${labelB} 独有 ${JSON.stringify(onlyB)}`,
      `  ${labelA}=${JSON.stringify(a)}`,
      `  ${labelB}=${JSON.stringify(b)}`,
      hint ? `  ↳ ${hint}` : '',
    ]
      .filter(Boolean)
      .join('\n     '),
  )
}

/** 从 TS 的 `xxx = { ... } as const` 里取所有字面量值 */
function tsConstObjectValues(source, name) {
  const block = source.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`))
  assert(Boolean(block), `找不到 ${name} 常量块`)
  const values = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
  assert(values.length > 0, `${name} 里没有解析出任何条目`)
  return values
}

const tauriTs = read('src/lib/tauri.ts')

/* ========================= 1. 事件名 ========================= */

console.log('\n── 1. EVENTS（TS）↔ events.rs（Rust）')

const tsEvents = tsConstObjectValues(tauriTs, 'EVENTS')

const eventsRs = read('src-tauri/src/events.rs')
/** `pub const X: &str = "zhijian://...";` → 值 */
const rustEventConsts = [...eventsRs.matchAll(/pub const \w+:\s*&str\s*=\s*"([^"]+)";/g)].map((m) => m[1])
/** `ALL` 数组里的常量**名**（要再映射回值，防止"常量改了但 ALL 忘了改"） */
const eventConstNameToValue = new Map(
  [...eventsRs.matchAll(/pub const (\w+):\s*&str\s*=\s*"([^"]+)";/g)].map((m) => [m[1], m[2]]),
)
const allBlock = eventsRs.match(/pub const ALL: &\[&str\] = &\[([\s\S]*?)\];/)
assert(Boolean(allBlock), '找不到 events.rs 的 ALL 数组')
const rustAllValues = [...allBlock[1].matchAll(/^\s*([A-Z_]+),/gm)].map((m) => {
  const value = eventConstNameToValue.get(m[1])
  assert(value !== undefined, `ALL 里引用了未定义的常量 ${m[1]}`)
  return value
})

check('事件名两侧双向一致（tsEVENTS ↔ events.rs 常量）', () => {
  assertSameSet(
    [...tsEvents].sort(),
    [...rustEventConsts].sort(),
    'tauri.ts::EVENTS',
    'events.rs 常量',
    '改事件名必须同时改 src-tauri/src/events.rs 与 src/lib/tauri.ts 的 EVENTS（禁止散写字符串字面量）',
  )
})

check('events.rs 的 ALL 数组 == 其中的常量集合（防"常量改了 ALL 忘改"）', () => {
  assertSameSet([...rustAllValues].sort(), [...rustEventConsts].sort(), 'events.rs::ALL', 'events.rs 常量')
  assert(
    rustAllValues.length === new Set(rustAllValues).size,
    `ALL 里有重复事件名（重复会让前端 listen 语义歧义）：${JSON.stringify(rustAllValues)}`,
  )
})

check('事件名一律使用 zhijian:// 方案（禁止裸名/其它 scheme）', () => {
  const bad = [...tsEvents, ...rustEventConsts].filter((name) => !name.startsWith('zhijian://'))
  assert(bad.length === 0, `以下事件名不符合 zhijian:// 约定：${JSON.stringify(bad)}`)
})

check('事件名两侧**逐字相同**（同名常量在两侧必须映射到同一字符串）', () => {
  const tsValues = new Set(tsEvents)
  const mismatched = rustEventConsts.filter((v) => !tsValues.has(v))
  assert(
    mismatched.length === 0,
    `Rust 侧存在 TS 侧没有的事件字符串：${JSON.stringify(mismatched)}\n     ↳ 只改一侧的 typo（如 window-show vs window-shown）不会被类型检查发现，只会让监听永不触发`,
  )
})

/* ===================== 2. 快捷键动作 id ===================== */

console.log('\n── 2. SHORTCUT_ACTION_IDS（TS）↔ SUPPORTED_ACTION_IDS（Rust）')

const tsActionIds = (() => {
  const block = tauriTs.match(/SHORTCUT_ACTION_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/)
  assert(Boolean(block), '找不到 tauri.ts 的 SHORTCUT_ACTION_IDS')
  const ids = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert(ids.length > 0, 'SHORTCUT_ACTION_IDS 为空')
  return ids
})()

const shortcutsRs = read('src-tauri/src/shortcuts.rs')
const actionNameToValue = new Map(
  [...shortcutsRs.matchAll(/pub const (ACTION_\w+):\s*&str\s*=\s*"([^"]+)";/g)].map((m) => [m[1], m[2]]),
)
const rustActionIds = (() => {
  const block = shortcutsRs.match(/SUPPORTED_ACTION_IDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/)
  assert(Boolean(block), '找不到 shortcuts.rs 的 SUPPORTED_ACTION_IDS')
  const ids = [...block[1].matchAll(/\b(ACTION_\w+)\b/g)].map((m) => {
    const value = actionNameToValue.get(m[1])
    assert(value !== undefined, `SUPPORTED_ACTION_IDS 引用了未定义的常量 ${m[1]}`)
    return value
  })
  assert(ids.length > 0, 'SUPPORTED_ACTION_IDS 为空')
  return ids
})()

check('动作 id 两侧双向一致（TS 多写会被 Rust 拒绝注册 ⇒ 静默失效）', () => {
  assertSameSet(
    [...tsActionIds].sort(),
    [...rustActionIds].sort(),
    'tauri.ts::SHORTCUT_ACTION_IDS',
    'shortcuts.rs::SUPPORTED_ACTION_IDS',
    'Rust 的 cmd_sync_global_shortcuts 会拒绝未知 id（前端多写 ⇒ 该动作静默注册失败）',
  )
})

/* ========================= 3. IPC 命令名 ========================= */

console.log('\n── 3. COMMANDS（TS）↔ generate_handler!（Rust）')

const tsCommands = tsConstObjectValues(tauriTs, 'COMMANDS')

const registeredCommands = (() => {
  const libRs = read('src-tauri/src/lib.rs')
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]/)
  assert(Boolean(block), '找不到 lib.rs 的 generate_handler!')
  const names = [...block[1].matchAll(/(\w+)::(\w+)/g)].map((m) => m[2])
  assert(names.length > 0, 'generate_handler! 里没有解析出任何命令')
  return names
})()

check('命令名两侧双向一致（前端多写 ⇒ invoke not found ⇒ 静默退化到 JS 回退路径）', () => {
  assertSameSet(
    [...tsCommands].sort(),
    [...registeredCommands].sort(),
    'tauri.ts::COMMANDS',
    'generate_handler!',
    '历史上正是这里漂移过：前端 tile_toggle vs Rust cmd_toggle_tile ⇒ 功能"看起来正常"但 Rust 侧全是死代码',
  )
})

check('命令命名纪律：新增命令一律 cmd_ 前缀（core 兼容命令 window_*/app_version 除外）', () => {
  const allowedLegacy = new Set(['window_show', 'window_hide', 'window_toggle', 'app_version'])
  const bad = registeredCommands.filter((name) => !name.startsWith('cmd_') && !allowedLegacy.has(name))
  assert(
    bad.length === 0,
    `以下命令既没有 cmd_ 前缀、也不在 core 兼容白名单里：${JSON.stringify(bad)}\n     ↳ 白名单：${JSON.stringify([...allowedLegacy])}（t12 之前的既有名字，改动会破坏已发布的调用方）`,
  )
})

/* ============ 4. 设置面板动作项覆盖度（告警，不失败） ============ */

console.log('\n── 4. 设置面板动作项覆盖度（只告警）')

const settingsActionIds = (() => {
  try {
    const source = read('src/features/settings/shortcuts.ts')
    const block = source.match(/SHORTCUT_ACTIONS: readonly ShortcutActionDefinition\[\] = \[([\s\S]*?)\n\]/)
    if (!block) return null
    return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
  } catch {
    return null
  }
})()

if (settingsActionIds === null) {
  warn('未能解析 src/features/settings/shortcuts.ts 的 SHORTCUT_ACTIONS（文件可能改名）—— 跳过覆盖度检查')
} else {
  const unreachable = rustActionIds.filter((id) => !settingsActionIds.includes(id))
  if (unreachable.length === 0) {
    console.log(`  ✅ 设置面板覆盖全部 ${rustActionIds.length} 个动作 id`)
    results.push({ name: '设置面板覆盖全部动作 id', ok: true })
  } else {
    warn(
      `设置面板缺少动作项：${JSON.stringify(unreachable)}\n` +
        `      后果：这些动作**无法在 UI 里绑定键位**（Rust 侧其实已实现，属"功能不可达"而非崩溃）。\n` +
        `      归属：t20 接线项（src/features/settings/** 不归架构师），见 docs/RUN.md §5.3 / ARCHITECTURE §4.14.6。\n` +
        `      说明：Rust 的 cmd_sync_global_shortcuts 只处理传进来的绑定，缺项＝保持未绑定，不报错。`,
    )
  }
}

/* ============ 5. 本轮前置修复的防回归（Bug 1 / Bug 2 / 错误边界） ============ */

console.log('\n── 5. 前置修复防回归（用户实测缺陷不得复活）')

/**
 * 📌 为什么这两条**可以静态断言**：
 * Bug 2（点空文件夹/标签/回收站 → 整树白屏）的根因是 **Hook 数量随状态变化** ——
 * 这是一个**纯静态**属性：只要「提前 return」之后还有 Hook 调用，就一定会复发。
 * 首轮验收漏掉它，是因为它只在「有笔记 → 无笔记」这一**状态转换**时触发，
 * 首屏空库/单次渲染都看不出来（构建门更看不出来）。所以这里用行号比较把它钉死。
 */
const editorPaneSource = read('src/features/editor/EditorPane.tsx')
const editorPaneLines = editorPaneSource.split(/\r?\n/)

check('Bug 2 防回归：EditorPane 的 `if (!note) return` 之后**不得再有 Hook 调用**', () => {
  // ⚠️ 锚点必须取**组件级**的提前 return，不能取回调里的同名守卫：
  //    `handleTagsChange` 内部也有一句 `if (!note) return`（第 389 行，单行无大括号），
  //    函数体后半段自然会有 Hook —— 若误取它，本断言会对**正确代码**报错（第一版就这样误伤过）。
  //    组件级提前 return 的形态是 `if (!note) {`（带大括号、随后 return JSX）。
  const braced = []
  editorPaneLines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    if (/if\s*\(\s*!note\s*\)\s*\{\s*$/.test(trimmed)) braced.push(index)
  })
  const earlyReturnIndex =
    braced.find((index) =>
      editorPaneLines
        .slice(index + 1, index + 4)
        .some((line) => /^\s*return\s*\(/.test(line)),
    ) ?? braced[braced.length - 1]

  assert(
    earlyReturnIndex !== undefined,
    '找不到组件级的 `if (!note) {` 提前 return —— 结构可能已重写，请人工确认后更新本断言',
  )
  const offenders = []
  editorPaneLines.forEach((line, index) => {
    if (index <= earlyReturnIndex) return
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return // 注释不算
    // Hook 调用形态：useXxx( ；`use` 开头的普通函数调用也算（宁严不松）
    if (/(^|[^.\w])use[A-Z]\w*\s*\(/.test(line)) offenders.push(`${index + 1}: ${trimmed.slice(0, 80)}`)
  })
  assert(
    offenders.length === 0,
    `提前 return（第 ${earlyReturnIndex + 1} 行）之后仍有 Hook 调用：\n` +
      offenders.map((o) => `       · ${o}`).join('\n') +
      `\n     ↳ 后果：note 由「有」变「无」时 Hook 数量减少，React 抛\n` +
      `       "Rendered fewer hooks than expected" 并卸载整棵树 ⇒ 整个界面白屏\n` +
      `       （用户实测：选中一篇笔记后点空白文件夹 / 空标签 / 回收站）。\n` +
      `     ↳ 修法：把 Hook 移到 \`if (!note)\` 之前（第 ${earlyReturnIndex + 1} 行）。`,
  )
})

check('Bug 1 防回归：CodeMirrorEditor 的「外部内容同步」必须保留三道守卫', () => {
  // 不依赖注释锚点（同一句话在文件里出现多次，第一版就取错了位置），
  // 直接断言**三道守卫的代码形态**都在：
  const cmSource = read('src/features/editor/CodeMirrorEditor.tsx')
  const missing = []
  // 守卫①「组合中不动」：**必须用更强的 `view.compositionStarted`**（t32 的结论）。
  // 为什么不再"两种都接受"：`composing` 要等**首次变更之后**才为 true，覆盖不到
  // 「组合已开始但还没落字」的窗口 —— 而那正是「拼音和汉字同时入文」的入口。
  // 若把 `compositionStarted` 降级回 `composing`，保护确实变弱了；"两种都接受"会让这种回退
  // **静默通过**（data 复核时指出）。故这里只接受强形态，并在失败信息里写明理由与"检测到降级"。
  const hasCompositionStarted = /if\s*\(\s*view\.compositionStarted\s*\)\s*return/.test(cmSource)
  const hasWeakerComposing = /if\s*\(\s*view\.composing\s*\)\s*return/.test(cmSource)
  if (!hasCompositionStarted) {
    missing.push(
      '组合期守卫必须用 `view.compositionStarted`（t32：`composing` 要等首次变更才为 true，' +
        '覆盖不到「组合已开始但还没落字」的窗口）' +
        (hasWeakerComposing
          ? '。⚠️ 代码当前用的是**较弱的 `view.composing`** —— 这等于把 t32 的加固**降级回退**，请改回或先说明理由'
          : ''),
    )
  }
  if (!/value\s*===\s*lastEmittedRef\.current/.test(cmSource)) {
    missing.push('`value === lastEmittedRef.current`（跳过自己产生、经 store 回传的内容）')
  }
  if (!/selection:\s*\{\s*anchor\s*\}/.test(cmSource)) {
    missing.push('`selection: { anchor }`（真外部改写时保持光标位置，而不是丢回首行）')
  }
  assert(
    missing.length === 0,
    `「外部内容同步」缺少守卫：${missing.join('、')}\n` +
      `     ↳ 后果（用户实测 Bug 1）：异步 store 的**过期 value** 反复全文覆盖编辑器 ⇒\n` +
      `       中文输入法拼音与汉字一起入文、回车后光标跳回首行。`,
  )
})

check('错误边界仍在 main.tsx 最外层（渲染出错时给可读提示，而不是全白）', () => {
  const mainSource = read('src/main.tsx')
  assert(/class\s+AppErrorBoundary/.test(mainSource), 'main.tsx 里找不到 AppErrorBoundary 类')
  assert(
    /getDerivedStateFromError/.test(mainSource),
    'AppErrorBoundary 缺少 getDerivedStateFromError —— 它不会真的接住渲染错误',
  )
  assert(
    /<AppErrorBoundary>/.test(mainSource) && /<\/AppErrorBoundary>/.test(mainSource),
    'AppErrorBoundary 没有被真正包裹在渲染树里',
  )
})

check('main.tsx 的窗口路由：磁贴走 TileApp、快速笔记走 QuickNoteApp、否则走 App（且只渲染一次）', () => {
  const mainSource = read('src/main.tsx')
  assert(
    /readTileNoteId\(\s*location\.search\s*\)/.test(mainSource),
    'main.tsx 未按 `?tile=` 做窗口路由 —— 磁贴窗口会渲染成主界面（并重复订阅全局快捷键）',
  )
  // t44：快速笔记同理 —— 它的需求就是「不要整个程序界面」，
  // 路由漏了的话捕捉框会渲染成完整主界面（用户看到的就是"快捷键打开了整个程序"）。
  assert(
    /readQuickNoteFlag\(\s*location\.search\s*\)/.test(mainSource),
    'main.tsx 未按 `?quick=` 做窗口路由 —— 快速笔记窗口会渲染成主界面',
  )
  assert(
    /tileNoteId\s*\?\s*<TileApp\s+noteId=\{tileNoteId\}\s*\/>\s*:\s*quickNote\s*\?\s*<QuickNoteApp\s*\/>\s*:\s*<App\s*\/>/.test(
      mainSource,
    ),
    '路由三元表达式不是「TileApp / QuickNoteApp / App」形态（改契约请同步本断言）',
  )
  // 判定顺序：磁贴参数更具体（带 noteId），必须先判它
  assert(
    mainSource.indexOf('readTileNoteId') < mainSource.indexOf('readQuickNoteFlag'),
    '路由判定顺序应为「先磁贴后快速笔记」（更具体的参数先判）',
  )
  const renders = mainSource.match(/createRoot\s*\(/g) ?? []
  assert(
    renders.length === 1,
    `main.tsx 里出现 ${renders.length} 次 createRoot(...) —— 只允许一次（重复渲染会让模块级 TDZ 变量被提前引用而白屏）`,
  )
})

/* ============ 6. t44 跨窗口笔记同步的「有人发 / 有人收」接线 ============ */

console.log('\n── 6. t44 跨窗口笔记同步接线（发/收两端都必须真的接上）')

/**
 * 去注释（**字符串感知**）。为什么不能直接 `line.replace(/\/\/.*$/, '')`：
 * 事件名本身就是 `'zhijian://note-changed'`，那里面就有 `//` ——
 * 朴素写法会把这一行截成 `noteChanged: 'zhijian:`，于是"字面量只出现一次"之类的断言
 * 会因为自己的工具而得出错误结论（本轮已经栽过一次"断言命中的是注释"）。
 */
function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/** 从 `openIndex`（必须是 `{`）配对到对应的 `}`，返回块内文本。按**大括号配对**取块，不按"往后 N 个字符" */
function braceBlock(source, openIndex) {
  assert(source[openIndex] === '{', `braceBlock 起点不是 {：${JSON.stringify(source.slice(openIndex, openIndex + 20))}`)
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, i)
    }
  }
  throw new Error('大括号不配对 —— 结构可能已被重写')
}

/** 取「具名动作 / 具名导出函数」的函数体；找不到就抛（非空守卫：0 命中必须失败，不能静默跳过） */
function bodyAfter(source, pattern, label) {
  const match = source.match(pattern)
  assert(Boolean(match), `找不到 ${label}（模式 ${pattern}）—— 结构可能已重写，请人工确认后更新本断言`)
  const openIndex = source.indexOf('{', match.index + match[0].length - 1)
  assert(openIndex >= 0, `${label} 之后找不到函数体大括号`)
  return braceBlock(source, openIndex)
}

const tauriNoComments = stripComments(tauriTs)
const storeSource = stripComments(read('src/store/notes.ts'))
const tileAppSource = stripComments(read('src/features/tiles/TileApp.tsx'))
const appSource = stripComments(read('src/App.tsx'))

check('t44 发/收两端都在 lib 层存在，且都引用 EVENTS.noteChanged（禁止散写字符串）', () => {
  const missing = []
  if (!/export async function broadcastNoteChanged/.test(tauriNoComments)) missing.push('broadcastNoteChanged 未导出')
  if (!/export async function onNoteChanged/.test(tauriNoComments)) missing.push('onNoteChanged 未导出')
  assert(missing.length === 0, `${missing.join('；')}`)

  const broadcastBody = bodyAfter(
    tauriNoComments,
    /export async function broadcastNoteChanged\s*\([^)]*\)[^{]*\{/,
    'broadcastNoteChanged 函数体',
  )
  const listenBody = bodyAfter(
    tauriNoComments,
    /export async function onNoteChanged\s*\([^)]*\)[^{]*\{/,
    'onNoteChanged 函数体',
  )
  assert(
    /EVENTS\.noteChanged/.test(broadcastBody) && /EVENTS\.noteChanged/.test(listenBody),
    '广播/订阅没有引用 EVENTS.noteChanged（说明自己又写了一份事件名字面量 —— 改名时必然漏一处）',
  )
  // 事件名字面量全仓只允许出现在 EVENTS 表里这一处（注释里用的是反引号，不会误伤）
  const literals = tauriTs.match(/'zhijian:\/\/note-changed'/g) ?? []
  assert(
    literals.length === 1,
    `tauri.ts 里 'zhijian://note-changed' 字面量出现 ${literals.length} 次（应为 1 次，仅 EVENTS 表）`,
  )
})

check('t44 广播必须「永不抛错」且只在 Tauri 环境下生效（否则会连累"保存成功"的判定）', () => {
  const broadcastBody = bodyAfter(
    tauriNoComments,
    /export async function broadcastNoteChanged\s*\([^)]*\)[^{]*\{/,
    'broadcastNoteChanged 函数体',
  )
  assert(/catch/.test(broadcastBody), 'broadcastNoteChanged 没有 try/catch —— 广播失败会把保存链路一起带崩')
  assert(/isTauri/.test(broadcastBody), 'broadcastNoteChanged 没有判 isTauri —— 纯浏览器 dev 下会抛错')
})

check('t44 订阅必须过滤「自己的回声」（两条接收侧安全性的共同基石）', () => {
  const listenBody = bodyAfter(
    tauriNoComments,
    /export async function onNoteChanged\s*\([^)]*\)[^{]*\{/,
    'onNoteChanged 函数体',
  )
  assert(
    /payload\.source\s*===\s*self/.test(listenBody) || /payload\.source\s*!==\s*self/.test(listenBody),
    'onNoteChanged 没有按 `payload.source === 本窗口 label` 过滤自己的回声 ——\n' +
      '     后果：本窗口写库 → 收到自己的广播 → 重读覆盖正在输入的草稿（正是 t16/t32 修过的那类缺陷）',
  )
})

check('t44 写入侧：store 的四个写动作都广播（漏一个 = 那条写入路径永远同步不出去）', () => {
  const actions = [
    ['create', /create:\s*async\s*\([^)]*\)\s*=>\s*\{/],
    ['update', /update:\s*async\s*\([^)]*\)\s*=>\s*\{/],
    ['remove', /remove:\s*async\s*\([^)]*\)\s*=>\s*\{/],
    ['restore', /restore:\s*async\s*\([^)]*\)\s*=>\s*\{/],
  ]
  const silent = []
  for (const [name, pattern] of actions) {
    const body = bodyAfter(storeSource, pattern, `notesStore.${name}`)
    if (!/void broadcastNoteChanged\(/.test(body)) silent.push(name)
  }
  assert(
    silent.length === 0,
    `以下写动作没有广播（用户表现为"这边改了、另一边永远不变"）：${JSON.stringify(silent)}\n` +
      `     ↳ 所有"改内容"的入口都收敛到这几个动作，只在这里广播才不会漏路径`,
  )
})

check('t44 接收侧·磁贴：订阅后只认自己那条、重读而不是自己拼内容、且不打断输入', () => {
  const callIndex = tileAppSource.indexOf('onNoteChanged(')
  assert(callIndex >= 0, 'TileApp 没有订阅 onNoteChanged —— 磁贴收不到主窗口的改动（用户实测的那一半）')
  const body = braceBlock(tileAppSource, tileAppSource.indexOf('{', callIndex))
  const missing = []
  if (!/payload\.noteId\s*!==\s*noteId/.test(body)) missing.push('没有只处理「本窗口这条」')
  if (!/load\(noteId\)/.test(body)) missing.push('没有重读该条（必须重读，不能在接收侧拼内容）')
  if (!/document\.hasFocus\(\)/.test(body)) missing.push('没有「本窗口有焦点就不动」的守卫')
  if (!/hasPendingRef\.current/.test(body)) missing.push('没有「本地有未落库输入就不动」的守卫')
  assert(
    missing.length === 0,
    `磁贴接收侧缺少：${missing.join('、')}\n` +
      `     ↳ 这两道守卫的作用：绝不弄丢用户刚敲的字（焦点独占 ⇒ 有焦点就说明用户正在这里打字）`,
  )
})

check('t44 接收侧·主窗口：订阅后刷新列表 + 元数据，并只对「当前这篇」自增采纳令牌', () => {
  const callIndex = appSource.indexOf('onNoteChanged(')
  assert(callIndex >= 0, 'App 没有订阅 onNoteChanged —— 磁贴里打的字永远进不到主窗口（用户实测的那一半）')
  const body = braceBlock(appSource, appSource.indexOf('{', callIndex))
  const missing = []
  if (!/document\.hasFocus\(\)/.test(body)) missing.push('没有「本窗口有焦点就不动」的守卫')
  if (!/\.refresh\(\)/.test(body)) missing.push('没有刷新笔记集合')
  if (!/reloadMetaRef\.current\(\)/.test(body)) missing.push('没有刷新元数据（标签/计数也可能被磁贴改过）')
  if (!/payload\.noteId\s*===\s*useNotesStore\.getState\(\)\.selectedId/.test(body)) {
    missing.push('没有「只对当前选中的这篇」自增采纳令牌（对别的笔记自增会误放行当前草稿的采纳）')
  }
  assert(missing.length === 0, `主窗口接收侧缺少：${missing.join('、')}`)
})

check('t44 采纳令牌链路完整：App 透传 → EditorPane 收到后清本地编辑历史（否则磁贴写的内容仍被拒）', () => {
  assert(
    /remoteAdoptToken=\{remoteAdoptToken\}/.test(appSource),
    'App 没有把 remoteAdoptToken 透传给 EditorPane（令牌停在 App 里，等于没接）',
  )
  const paneSource = stripComments(editorPaneSource)
  const guardIndex = paneSource.search(/if\s*\(\s*remoteAdoptToken\s*!==\s*remoteAdoptRef\.current\s*\)\s*\{/)
  assert(
    guardIndex >= 0,
    'EditorPane 没有「令牌变化」的判定块 ——\n' +
      '     后果：`locallyEdited` 是单调的，本篇只要被本地编辑过一次，\n' +
      '     磁贴写进来的内容就永远被拒（这正是用户实测的现象）',
  )
  const guardBody = braceBlock(paneSource, paneSource.indexOf('{', guardIndex))
  assert(
    /locallyEditedRef\.current\s*=\s*false/.test(guardBody),
    '令牌变化时没有清 `locallyEditedRef` —— 令牌白加了',
  )
  assert(
    paneSource.indexOf('remoteAdoptRef.current = remoteAdoptToken') > paneSource.indexOf('locallyEditedRef = useRef(false)'),
    '令牌判定块出现在了 `locallyEditedRef` 声明之前（会命中 TDZ / 判定不到），请把声明顺序调整回来',
  )
  // 反向守卫：采纳判据里的 `busy` 硬闸门不得被删（它是"绝不弄丢输入"的最后一道）
  const draftSyncSource = stripComments(read('src/features/editor/draftSync.ts'))
  assert(
    /if\s*\(\s*input\.busy\s*\)\s*return\s+false/.test(draftSyncSource),
    'shouldAdoptExternalDraft 里的 `busy` 闸门不见了 —— 这是任何通路下都不得移除的硬守卫',
  )
})

/* ============ 7. 窗口 label ↔ capability 覆盖（t44） ============ */

console.log('\n── 7. 窗口 label ↔ capability 覆盖（缺授权 = 窗口一打开就是一屏 ACL 报错）')

/**
 * 为什么要机器对账这件事（t33 的真实事故）：
 * 磁贴窗口当时"能创建/能拖/能关"，功能看起来正常，但窗口里**什么都读不出来** ——
 * 因为 `capabilities/tiles.json` 漏了 `fs` 权限，而磁贴跑的是与主窗口同一套 db 层，
 * 而 t15 之后 **md 是真相源**，`initDb()` 必须经 FsPort 读写 vault。
 * 用户看到的是「磁贴完全不能用，上面显示乱码」（其实是一屏英文 ACL 报错）。
 * 关键教训：**按窗口内代码的"直接调用"配权限是不够的，要按传递依赖配**。
 * 因此这里把「Rust 侧的窗口 label」与「capability 的 windows 匹配式」做双向核对，
 * 并对每个非主窗口把传递依赖（sql + fs）逐条钉死。
 */
const capabilitiesDir = 'src-tauri/capabilities'
const capabilityFiles = readDir(capabilitiesDir).filter((name) => name.endsWith('.json'))
assert(capabilityFiles.length > 0, `${capabilitiesDir} 下没有解析到任何 capability 文件`)

const capabilities = capabilityFiles.map((name) => {
  const parsed = JSON.parse(read(path.posix.join(capabilitiesDir, name)))
  return {
    file: `${capabilitiesDir}/${name}`,
    identifier: parsed.identifier,
    windows: Array.isArray(parsed.windows) ? parsed.windows : [],
    permissions: Array.isArray(parsed.permissions)
      ? parsed.permissions.map((item) => (typeof item === 'string' ? item : item.identifier))
      : [],
  }
})

/** Rust 里声明的窗口 label 常量（真值来自代码，不是这里的字面量） */
const quickNoteRs = read('src-tauri/src/quick_note.rs')
const quickNoteLabel = (() => {
  const match = quickNoteRs.match(/pub const QUICK_NOTE_LABEL:\s*&str\s*=\s*"([^"]+)";/)
  assert(Boolean(match), '找不到 quick_note.rs 的 QUICK_NOTE_LABEL')
  return match[1]
})()

/** 磁贴 label 形态来自 tiles.rs 的前缀常量（`tile-<noteId>`） */
const tilesRs = read('src-tauri/src/tiles.rs')
const tileLabelPrefix = (() => {
  const match = tilesRs.match(/pub const TILE_LABEL_PREFIX:\s*&str\s*=\s*"([^"]+)";/)
  assert(Boolean(match), '找不到 tiles.rs 的 TILE_LABEL_PREFIX')
  return match[1]
})()

check('每个会加载前端的窗口 label 都有 capability 覆盖（main / tile-* / quick-note）', () => {
  const allPatterns = capabilities.flatMap((cap) => cap.windows)
  const missing = []
  if (!allPatterns.includes('main')) missing.push('main（主窗口）')
  const tilePattern = `${tileLabelPrefix}*`
  if (!allPatterns.includes(tilePattern)) {
    missing.push(`${tilePattern}（磁贴窗口，tiles.rs 的前缀常量是「${tileLabelPrefix}」）`)
  }
  if (!allPatterns.includes(quickNoteLabel)) {
    missing.push(
      `${quickNoteLabel}（快速笔记；Rust 常量 QUICK_NOTE_LABEL = "${quickNoteLabel}"）\n` +
        `       ⚠️ 这里对不上就是**静默无权限**：窗口照样能打开，但里面所有 IPC 都被拒\n` +
        `       （t33 的形态：窗口"能开能拖"，内容区却是一屏英文 ACL 报错）`,
    )
  }
  assert(missing.length === 0, `以下窗口没有任何 capability 覆盖：\n       · ${missing.join('\n       · ')}`)
})

check('非主窗口的能力必须覆盖「传递依赖」：sql + fs + 关闭/拖动（t33 教训的静态化）', () => {
  /** 按 label 匹配式找 capability；找不到就报错（不许静默跳过） */
  const capFor = (pattern) => {
    const found = capabilities.find((cap) => cap.windows.includes(pattern))
    assert(Boolean(found), `找不到匹配 ${pattern} 的 capability 文件`)
    return found
  }
  /** 每个非主窗口都需要的权限及各自的由来 */
  const required = new Map([
    ['sql:allow-load', '窗口内要 initDb（磁贴/快速笔记都直接落库）'],
    ['sql:allow-select', '同上'],
    ['sql:allow-execute', '窗口内要写入（磁贴自动保存 / 快速笔记新建）'],
    [
      'fs:allow-document-read-recursive',
      't15 起 md 是真相源：initDb 经 FsPort 读 <文档>/纸笺/**，**不受 sql 权限覆盖**',
    ],
    ['fs:allow-document-write-recursive', '同一原因（写 md 与 .paper/*.json）'],
    ['fs:allow-appdata-read-recursive', 'appDataDir（迁移备份 / 日志）'],
    ['fs:allow-appdata-write-recursive', '同上'],
    ['core:window:allow-close', '关闭按钮走 getCurrentWindow().close()；core:default 只含窗口只读操作'],
    [
      'core:window:allow-start-dragging',
      'drag.js 命中 data-tauri-drag-region 时 invoke plugin:window|start_dragging —— 走 IPC、受 ACL 管',
    ],
  ])

  const problems = []
  for (const [pattern, label] of [
    [`${tileLabelPrefix}*`, '磁贴'],
    [quickNoteLabel, '快速笔记'],
  ]) {
    const cap = capFor(pattern)
    for (const [permission, why] of required) {
      if (!cap.permissions.includes(permission)) {
        problems.push(`${label}（${cap.file}）缺 ${permission} —— ${why}`)
      }
    }
    // 反向：这两个窗口都**不该**有全局快捷键权限（会在每个窗口里重复注册全局键位）
    if (cap.permissions.some((permission) => permission.startsWith('global-shortcut:'))) {
      problems.push(`${label}（${cap.file}）被授予了 global-shortcut 权限 —— 每个窗口都会重复注册全局键位`)
    }
  }
  assert(problems.length === 0, problems.map((line) => `       · ${line}`).join('\n'))
})

check('动作 id 只有一处字面量真相源（settings/shortcuts.ts 不得再手抄一份联合类型）', () => {
  const source = stripComments(read('src/features/settings/shortcuts.ts'))
  /**
   * ⚠️ 只取**类型别名那一行**（`[^\n]+`），不要用 `[^;]*`：
   * 第一版写成 `[^;]*'newNote'` 就误报了 —— 该别名行**没有分号**，
   * 于是模式一路吃到文件后半段 `SHORTCUT_ACTIONS` 里的 `id: 'newNote'`，
   * 对**正确代码**报错。锚点必须落在结构上（一行），不能落在"某个字符之前"。
   */
  const alias = source.match(/export type ShortcutActionId\s*=\s*([^\n]+)/)
  assert(Boolean(alias), '找不到 `export type ShortcutActionId = ...` 的定义行')
  const aliasBody = alias[1].trim()
  assert(
    !/['"]/.test(aliasBody),
    `settings/shortcuts.ts 又出现了手抄的动作 id 字面量联合：${aliasBody}\n` +
      '     ↳ 它是「第三份副本」：check:contract 只核对 tauri.ts ↔ Rust 两张表，\n' +
      '       这份副本漂移时没有任何门会红（t44 新增 quickNote 时正是被它拦下）。\n' +
      '       正确写法：`export type ShortcutActionId = (typeof TAURI_ACTION_IDS)[number]`',
  )
  assert(
    /\(typeof\s+TAURI_ACTION_IDS\)/.test(aliasBody),
    `ShortcutActionId 应当从 tauri.ts 的 SHORTCUT_ACTION_IDS 推导，当前是：${aliasBody}`,
  )
})

/* ---------------- 应用装配：单实例锁（t53） ---------------- */

/**
 * 从 `from` 起第一段花括号配平的代码块。
 * 刻意不用「接下来 N 个字符」：那种锚点会随文件重排静默失配（本项目已栽过）。
 */
function blockAt(source, from) {
  const open = source.indexOf('{', from)
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

/**
 * 报障原文（用户）：「程序最小化到托盘后，再点桌面快捷图标，又会打开一个新的程序，
 * 系统托盘会有两个实例」。根因：lib.rs 的装配注释里写着"单实例"，却**从未注册**
 * 任何单实例插件 —— 注释描述了意图，代码里没有实现。
 *
 * 三条必须同时成立，缺一条就是半修复：
 *  1. 依赖在（Cargo.toml）；
 *  2. 插件注册了，而且**是第一个** —— 官方要求，先注册别的插件会让锁失效；
 *  3. 回调里唤起了主窗口 —— 只加锁不唤起，用户双击图标会变成"点了没反应"。
 */
check('单实例锁已注册、是第一个插件、且会唤起已有窗口（t53）', () => {
  const cargo = read('src-tauri/Cargo.toml')
  assert(
    /tauri-plugin-single-instance\s*=/.test(cargo),
    'Cargo.toml 缺少 tauri-plugin-single-instance 依赖 —— 没有它，第二次启动必然新开进程（两个托盘图标、两份快捷键注册）',
  )

  // 去注释后再匹配：注释里出现 `.plugin(` 字样不该干扰"谁是第一个插件"的判定
  const libCode = stripComments(read('src-tauri/src/lib.rs'))
  const initAt = libCode.indexOf('tauri_plugin_single_instance::init')
  assert(initAt >= 0, 'lib.rs 没有注册 tauri_plugin_single_instance::init')

  /**
   * 断言方式：**第一个 `.plugin(` 后面紧跟的必须是单实例插件**。
   *
   * 这段被变异测试改过两轮，两次都不对，值得留档：
   *  · 第一版 `lib.indexOf('.plugin(') < initAt` 是**反的** —— 在它前面插一个别的插件时，
   *    第一个 `.plugin(` 反而更靠前，断言照样通过（变异 M2 抓到假绿）；
   *  · 第二版 `!lib.slice(0, initAt).includes('.plugin(')` 又**过严** ——
   *    `initAt` 之前本就紧邻着属于同一条语句的 `.plugin(` 前缀，正确代码也会被判红。
   */
  const firstPluginAt = libCode.indexOf('.plugin(')
  assert(firstPluginAt >= 0, 'lib.rs 里找不到任何 .plugin(...) 注册（装配结构变了？）')
  const afterFirstPlugin = libCode.slice(firstPluginAt + '.plugin('.length).trimStart()
  assert(
    afterFirstPlugin.startsWith('tauri_plugin_single_instance::init'),
    `第一个注册的插件不是单实例锁（实际是 ${afterFirstPlugin.slice(0, 40)}…）：官方要求它必须最先注册，否则锁不生效`,
  )

  const callback = blockAt(libCode, initAt)
  assert(Boolean(callback), '提取不到单实例回调体（锚点失效，断言会空跑）')
  assert(
    /window::show_main\(/.test(callback),
    '回调里必须调用 window::show_main：只加锁不唤起，用户双击图标毫无反馈（把"新开一个窗口"换成了"点了没反应"）',
  )
})

/* ---------------- 应用版本号：四处必须一致 ---------------- */

/**
 * 应用版本散在四个地方，用途各不相同，所以**四处都要改**：
 *  · `package.json`            —— npm 包版本（前端构建元数据）
 *  · `src-tauri/Cargo.toml`    —— crate 版本，`app_version` 命令的返回值（设置面板显示的那个）
 *  · `src-tauri/tauri.conf.json` —— 安装包 / 窗口元数据版本（NSIS 安装包文件名也用它）
 *  · `src/lib/tauri.ts`        —— `APP_META`，导出笔记时写进 front-matter 的版本
 *
 * 人工同步必然漂移：改一处忘一处，就会出现「安装包 0.2.1 / 关于里 0.1.0 /
 * 导出文件里 0.1.0」这种自相矛盾，而且没有任何门会红。所以在这里钉一条。
 *
 * ⚠️ 只比这四处，**不要**去全仓库扫 "0.1.0" —— 那会撞上第三方依赖版本
 * （`react-markdown` 10.1.0、Cargo.lock 里若干 0.1.0 的 crate）。
 */
check('应用版本号四处一致（package.json / Cargo.toml / tauri.conf.json / APP_META）', () => {
  const pkg = JSON.parse(read('package.json')).version
  const cargo = read('src-tauri/Cargo.toml').match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')).version
  const meta = read('src/lib/tauri.ts').match(/\bversion:\s*'([^']+)'/)?.[1]

  assert(Boolean(cargo), 'Cargo.toml 里找不到 version = "x.y.z"（锚点失效，断言会空跑）')
  assert(Boolean(meta), "tauri.ts 里找不到 version: 'x.y.z'（锚点失效，断言会空跑）")

  const spots = [
    ['package.json', pkg],
    ['src-tauri/Cargo.toml', cargo],
    ['src-tauri/tauri.conf.json', conf],
    ['src/lib/tauri.ts', meta],
  ]
  const values = [...new Set(spots.map(([, value]) => value))]
  assert(
    values.length === 1,
    `四处版本不一致：\n${spots.map(([file, value]) => `       · ${file} = ${value}`).join('\n')}`,
  )
  assert(/^\d+\.\d+\.\d+$/.test(values[0]), `版本号不是 x.y.z 形式：${values[0]}`)
})

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 契约对账：共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项` +
    (warnings.length > 0 ? `，告警 ${warnings.length} 项（不判失败）` : ''),
)
if (failed.length > 0) {
  console.log('\n漂移命中（这类缺陷不报错、不白屏，只有两侧表机器比对才能发现）：')
  for (const item of failed) console.log(`   - ${item.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
