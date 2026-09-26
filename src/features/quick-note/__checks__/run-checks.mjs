#!/usr/bin/env node
/**
 * 纸笺 · 快速笔记自检（t44）     运行：node src/features/quick-note/__checks__/run-checks.mjs
 * ============================================================================
 * 用户需求原话：「再加一个快速笔记功能，通过快捷键立马打开一个单独的记录框界面
 * 而不是整个程序界面，可以快速建立一个笔记。」
 *
 * 这道门守四件事：
 *  A. **URL 协议**：`?quick=` 的解析规则（含"写错值必须回落主界面"）；
 *  B. **按键真值表**：Enter=保存 / Shift+Enter=换行 / **组合期 Enter 绝不当成保存** / Esc=关闭。
 *     这一条是本功能最可能被打断的地方（中文输入法），也是最难靠手点覆盖的地方；
 *  C. **窗口创建**：Rust 侧 label / 尺寸 / 不可最大化 / 不创建第二个窗口；
 *  D. **接线**：主入口路由、快捷键动作、托盘入口、命令登记、能力授权、关闭语义。
 *
 * 纯静态 + 纯函数断言：不需要 Tauri、不需要浏览器、不需要 DB（可放进 `check:all`）。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..', '..')
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

const { readQuickNoteFlag, titleFromQuickContent, QUICK_NOTE_QUERY_KEY, QUICK_NOTE_UNTITLED } =
  await import('../quickNoteUrl.ts')
const { quickNoteKeyAction } = await import('../quickNoteKeys.ts')

const results = []
let currentGroup = '(未分组)'
const group = (title) => {
  currentGroup = title
  console.log(`\n── ${title}`)
}
function check(name, fn) {
  try {
    fn()
    results.push({ group: currentGroup, name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ group: currentGroup, name, ok: false, error: message })
    console.log(`  ❌ ${name}\n     ↳ ${message}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}：期望 ${b}，实际 ${a}`)
}

/**
 * 按大括号配对取一段函数体。
 * ⚠️ 不要用"匹配到第一个 `}` 为止"（`{0,700}?}`）：函数体里往往先出现别的 `}`，
 * 取到的片段会过短，于是断言对**正确代码**报错（本文件 t46 那组就踩过一次）。
 */
function bodyAfter(source, pattern) {
  const match = source.match(pattern)
  if (!match) return null
  const open = source.indexOf('{', match.index + match[0].length - 1)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

console.log('快速笔记自检（t44）')
console.log(`项目根：${repoRoot}`)

/* ==================== A. URL 协议（纯函数） ==================== */

group('A. URL 协议 ?quick=1')

check('命中：?quick=1 / quick=1 / ?quick / ?QUICK=true', () => {
  assertEqual(readQuickNoteFlag('?quick=1'), true, '?quick=1')
  assertEqual(readQuickNoteFlag('quick=1'), true, '无前导问号')
  assertEqual(readQuickNoteFlag('?quick'), true, '无值（开关式）')
  assertEqual(readQuickNoteFlag('?QUICK=1'), true, '键名大小写不敏感')
  assertEqual(readQuickNoteFlag('?quick=TRUE'), true, '值大小写不敏感')
  assertEqual(readQuickNoteFlag('?a=1&quick=1'), true, '多参数按名字取')
})

check('未命中：无参 / 空串 / 显式关闭 / 仅前缀相似', () => {
  assertEqual(readQuickNoteFlag(''), false, '空')
  assertEqual(readQuickNoteFlag('?'), false, '只有问号')
  assertEqual(readQuickNoteFlag('?tile=abc'), false, '磁贴参数不算')
  assertEqual(readQuickNoteFlag('?quick=0'), false, '?quick=0 必须回落主界面')
  assertEqual(readQuickNoteFlag('?quick=false'), false, '?quick=false 必须回落主界面')
  assertEqual(readQuickNoteFlag('?quickly=1'), false, '前缀相似不算（键名必须整体相等）')
  assertEqual(readQuickNoteFlag('?quick=2'), false, '未知值不猜（宁可回落主界面）')
})

check('查询参数名与 Rust 常量一致（两侧各写一遍，必须机器核对）', () => {
  const rs = read('src-tauri/src/quick_note.rs')
  const match = rs.match(/pub const QUICK_NOTE_QUERY_KEY:\s*&str\s*=\s*"([^"]+)";/)
  assert(Boolean(match), '找不到 quick_note.rs 的 QUICK_NOTE_QUERY_KEY')
  assertEqual(QUICK_NOTE_QUERY_KEY, match[1], 'TS 与 Rust 的查询参数名')
})

check('标题推断：取首个非空行，超长截断，全空回落「无标题」', () => {
  assertEqual(titleFromQuickContent('买牛奶'), '买牛奶', '单行')
  assertEqual(titleFromQuickContent('\n\n  第二行才是内容  \n第三行'), '第二行才是内容', '跳过空行并 trim')
  assertEqual(titleFromQuickContent(''), QUICK_NOTE_UNTITLED, '空内容')
  assertEqual(titleFromQuickContent('   \n  \t '), QUICK_NOTE_UNTITLED, '纯空白')
  const long = 'x'.repeat(60)
  const title = titleFromQuickContent(long)
  assert(title.length <= 41, `标题应被截断，实际长度 ${title.length}`)
  assert(title.endsWith('…'), '截断后应有省略号（提示用户标题不是全文）')
})

/* ==================== B. 按键真值表（纯函数） ==================== */

group('B. 按键真值表（Enter / Shift+Enter / 组合期 / Esc）')

check('Enter（无 Shift、非组合）⇒ save', () => {
  assertEqual(
    quickNoteKeyAction({ key: 'Enter', shiftKey: false, composing: false }),
    'save',
    '主路径',
  )
})

check('⚠️ 组合期 Enter ⇒ none（中文输入法确认候选词，绝不能保存并关窗）', () => {
  assertEqual(
    quickNoteKeyAction({ key: 'Enter', shiftKey: false, composing: true }),
    'none',
    '组合中',
  )
  // 兼容大小写形态（部分 IME 在 Windows 上给 "Enter"，某些环境给 "enter"）
  assertEqual(
    quickNoteKeyAction({ key: 'Enter', shiftKey: true, composing: true }),
    'none',
    '组合中且带 Shift',
  )
})

check('Shift+Enter ⇒ none（换行，交给 textarea 默认行为）', () => {
  assertEqual(quickNoteKeyAction({ key: 'Enter', shiftKey: true, composing: false }), 'none', '换行')
})

check('Escape ⇒ close（放弃这次捕捉）', () => {
  assertEqual(quickNoteKeyAction({ key: 'Escape', shiftKey: false, composing: false }), 'close', 'Esc')
  assertEqual(quickNoteKeyAction({ key: 'Escape', shiftKey: true, composing: true }), 'close', '组合中 Esc 也算放弃')
})

check('其它按键一律 none（不拦）', () => {
  for (const key of ['a', 'Backspace', 'Tab', 'ArrowUp', 'Process']) {
    assertEqual(quickNoteKeyAction({ key, shiftKey: false, composing: false }), 'none', `键 ${key}`)
  }
})

check('组件真的用了这个纯函数，且组合态取「原生 isComposing ∨ 自己的标志」', () => {
  const source = read('src/features/quick-note/QuickNoteApp.tsx')
  assert(source.includes('quickNoteKeyAction('), '组件没有调用 quickNoteKeyAction（判定被内联回去了？）')
  assert(
    /composingRef\.current\s*\|\|\s*event\.nativeEvent\.isComposing/.test(source),
    '组合态必须取两个来源的或：任一为真都算组合中（单看原生标记在部分输入法下不可靠）',
  )
  assert(
    /onCompositionStart=\{[\s\S]*?composingRef\.current = true/.test(source) &&
      /onCompositionEnd=\{[\s\S]*?composingRef\.current = false/.test(source),
    '组件必须在 compositionstart/end 上维护自己的组合标志',
  )
})

/* ==================== C. 窗口创建（Rust） ==================== */

group('C. 窗口创建（Rust quick_note.rs）')

const quickNoteRs = read('src-tauri/src/quick_note.rs')

check('窗口形态：无边框 + 置顶 + 不占任务栏 + 不可最大化', () => {
  for (const [pattern, why] of [
    [/\.decorations\(false\)/, '无边框（捕捉框不该有系统标题栏）'],
    [/\.always_on_top\(true\)/, '置顶（捕捉灵感时不该被别的窗口挡住）'],
    [/\.skip_taskbar\(true\)/, '不占任务栏（它不是主程序）'],
    [/\.maximizable\(false\)/, '不可最大化（t21 实测：capability 的 deny 挡不住注入脚本那条路）'],
    [/\.focused\(true\)/, '打开即聚焦（否则用户还要点一下才能打字）'],
  ]) {
    assert(pattern.test(quickNoteRs), `quick_note.rs 缺少：${why}`)
  }
})

check('尺寸显著小于主窗口（否则「不要整个程序界面」这个需求就没实现）', () => {
  const width = Number(quickNoteRs.match(/QUICK_NOTE_WIDTH:\s*f64\s*=\s*([\d.]+)/)?.[1])
  const height = Number(quickNoteRs.match(/QUICK_NOTE_HEIGHT:\s*f64\s*=\s*([\d.]+)/)?.[1])
  assert(Number.isFinite(width) && Number.isFinite(height), '解析不到窗口尺寸常量')
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'))
  const main = (conf.app?.windows ?? []).find((w) => w.label === 'main') ?? {}
  assert(
    width < (main.width ?? 0) && height < (main.height ?? 0),
    `快速笔记 ${width}×${height} 必须小于主窗口 ${main.width}×${main.height}`,
  )
})

check('已存在时只 show+focus，**绝不重建**（重建会丢掉用户敲了一半的内容）', () => {
  assert(
    /if let Some\(existing\) = quick_note_window\(app\)/.test(quickNoteRs),
    '缺少「已存在则复用」的分支',
  )
  assert(/existing\.show\(\)/.test(quickNoteRs), '复用分支必须 show()')
  // ⚠️ 容错换行：Rust 里这句为了挂 `.map_err(...)` 是**链式换行**写的
  //    （`existing\n    .set_focus()`）。断言若写成 `existing\.set_focus\(\)`
  //    就会对**正确代码**报错 —— 锚点对齐结构，别对齐排版。
  assert(
    /existing\s*\.\s*set_focus\(\)/.test(quickNoteRs),
    '复用分支必须 set_focus()（否则快捷键第二次按下时窗口不会跳到前台）',
  )
  const reuseBlock = quickNoteRs.slice(
    quickNoteRs.indexOf('if let Some(existing)'),
    quickNoteRs.indexOf('let url = quick_note_url'),
  )
  assert(
    !/build\(\)/.test(reuseBlock),
    '复用分支里不得再 build() —— 那等于重建窗口、丢掉已输入内容',
  )
})

check('label 判定是精确相等（不是前缀匹配）', () => {
  assert(
    /pub fn is_quick_note_label\(label: &str\) -> bool \{\s*label == QUICK_NOTE_LABEL\s*\}/.test(
      quickNoteRs,
    ),
    'is_quick_note_label 必须是精确相等；前缀匹配会把 quick-note-2 之类也认成它，关闭语义就串了',
  )
})

/* ==================== D. 接线（路由 / 快捷键 / 托盘 / 命令 / 能力 / 关闭） ==================== */

group('D. 接线')

const mainTsx = read('src/main.tsx')
const libRs = read('src-tauri/src/lib.rs')
const shortcutsRs = read('src-tauri/src/shortcuts.rs')
const trayRs = read('src-tauri/src/tray.rs')
const tauriTs = read('src/lib/tauri.ts')

check('主入口路由：?quick=1 ⇒ QuickNoteApp（且排在磁贴之后）', () => {
  assert(mainTsx.includes('readQuickNoteFlag(location.search)'), '主入口没有解析 ?quick=')
  assert(
    /quickNote\s*\?\s*<QuickNoteApp\s*\/>/.test(mainTsx),
    '主入口没有按 quickNote 渲染 <QuickNoteApp />',
  )
  assert(
    mainTsx.indexOf('readTileNoteId') < mainTsx.indexOf('readQuickNoteFlag'),
    '判定顺序应为「先磁贴后快速笔记」',
  )
})

check('快捷键：动作 id / Rust 支持清单 / 分发分支 / 不唤起主窗口', () => {
  assert(tauriTs.includes("'quickNote'"), 'tauri.ts 的 SHORTCUT_ACTION_IDS 没有 quickNote')
  assert(
    /pub const ACTION_QUICK_NOTE:\s*&str\s*=\s*"quickNote";/.test(shortcutsRs),
    'shortcuts.rs 没有 ACTION_QUICK_NOTE 常量（或值与 TS 不一致）',
  )
  assert(/ACTION_QUICK_NOTE,/.test(shortcutsRs), 'SUPPORTED_ACTION_IDS 没有登记 ACTION_QUICK_NOTE')
  const dispatch = shortcutsRs.slice(shortcutsRs.indexOf('ACTION_QUICK_NOTE =>'))
  const arm = dispatch.slice(0, dispatch.indexOf('other =>'))
  assert(
    /quick_note::spawn_open_quick_note\(app\)/.test(arm),
    'ACTION_QUICK_NOTE 的分支没有调用 spawn_open_quick_note',
  )
  assert(
    !/window::show_main/.test(arm),
    '⚠️ 该分支**不得**唤起主窗口 —— 用户要的就是"不要整个程序界面"',
  )
})

check('托盘入口存在（否则键位未绑定时这个功能不可达）', () => {
  assert(trayRs.includes('MENU_QUICK_NOTE'), '托盘菜单没有快速笔记项 id')
  assert(trayRs.includes('"快速笔记…"'), '托盘菜单没有快速笔记项文案')
  assert(trayRs.includes('&quick_note,'), '托盘菜单没有把该项加进菜单')
  const handler = trayRs.slice(trayRs.indexOf('MENU_QUICK_NOTE =>'))
  assert(
    /quick_note::spawn_open_quick_note\(app\)/.test(
      handler.slice(0, handler.indexOf('MENU_SETTINGS =>')),
    ),
    '托盘菜单项没有接到 spawn_open_quick_note',
  )
})

check('⚠️ 窗口创建必须避开「同步命令 / 事件处理器」死锁（t44 探针实测过这个坑）', () => {
  /**
   * 框架源码原文（tauri-2.11.6/src/webview/webview_window.rs:56-59，`build()` 的文档）：
   * > On Windows, this function deadlocks when used in a **synchronous command and event handlers**...
   * > You should use `async` commands and **separate threads** when creating windows.
   * 实测：第一版把命令写成同步 fn ⇒ 前端 invoke 永久挂起、窗口根本没建出来，
   * 而**编译、typecheck、cargo test、全部静态门都是绿的**（只有 probe:quick-note 抓到）。
   *
   * 注：本断言必须放在 D 组（`trayRs` / `shortcutsRs` 到此处才完成初始化）——
   * 第一版放在 C 组，直接踩了 TDZ（`Cannot access 'trayRs' before initialization`）。
   */
  assert(
    /#\[tauri::command\]\s*pub async fn cmd_open_quick_note/.test(quickNoteRs),
    'cmd_open_quick_note 必须是 `async fn` ——\n' +
      '     同步命令跑在主线程上，`WebviewWindowBuilder::build()` 在 Windows 上会死锁\n' +
      '     （前端 invoke 永久挂起、窗口不出现；静态门全绿也发现不了）',
  )
  assert(
    /pub fn spawn_open_quick_note/.test(quickNoteRs) && /std::thread::spawn/.test(quickNoteRs),
    '缺少 spawn_open_quick_note（独立线程版本）—— 事件处理器必须用它',
  )
  const shortcutArm = shortcutsRs.slice(shortcutsRs.indexOf('ACTION_QUICK_NOTE =>'))
  const shortcutBody = shortcutArm.slice(0, shortcutArm.indexOf('other =>'))
  assert(
    !/open_quick_note\(app\)/.test(shortcutBody.replace(/spawn_open_quick_note/g, '')),
    '全局快捷键分支里不应再直接调用 open_quick_note（应走 spawn 版本）',
  )
})

check('IPC 命令已登记（COMMANDS ↔ generate_handler! 由 check:contract 双向核对）', () => {
  assert(
    /openQuickNote:\s*'cmd_open_quick_note'/.test(tauriTs),
    'tauri.ts 的 COMMANDS 没有 openQuickNote',
  )
  assert(
    /quick_note::cmd_open_quick_note,/.test(libRs),
    'lib.rs 的 generate_handler! 没有注册 cmd_open_quick_note',
  )
})

check('关闭语义：lib.rs 必须对 quick-note 提前放行（否则"点关闭没反应"）', () => {
  const closeBlock = libRs.slice(libRs.indexOf('WindowEvent::CloseRequested'))
  assert(
    /quick_note::is_quick_note_label\(window\.label\(\)\)\s*\{\s*return;/.test(closeBlock.slice(0, 900)),
    'CloseRequested 里没有对快速笔记提前 return —— 它会被"关闭到托盘"逻辑拦下，\n' +
      '     表现是「点了关闭窗口还在」，用户会以为保存失败',
  )
})

check('能力授权：capability 的 windows 与 Rust label 常量一致，且含关闭/拖动权限', () => {
  const cap = JSON.parse(read('src-tauri/capabilities/quick-note.json'))
  const label = quickNoteRs.match(/pub const QUICK_NOTE_LABEL:\s*&str\s*=\s*"([^"]+)";/)?.[1]
  assert(Boolean(label), '找不到 QUICK_NOTE_LABEL')
  assert(cap.windows.includes(label), `capability 的 windows 不含 "${label}"（会变成整窗无权限）`)
  for (const permission of [
    'core:window:allow-close',
    'core:window:allow-start-dragging',
    'sql:allow-load',
    'sql:allow-select',
    'sql:allow-execute',
    'fs:allow-document-read-recursive',
    'fs:allow-document-write-recursive',
    'fs:allow-appdata-read-recursive',
    'fs:allow-appdata-write-recursive',
  ]) {
    assert(cap.permissions.includes(permission), `quick-note.json 缺 ${permission}`)
  }
})

check('保存路径：走 store 的公开入口，且新建后广播（主窗口才会知道多了一条）', () => {
  const app = read('src/features/quick-note/QuickNoteApp.tsx')
  assert(app.includes('createNoteFromInput('), '快速笔记没有走 createNoteFromInput（store 的公开写入口）')
  const store = read('src/store/notes.ts')
  const body = store.slice(store.indexOf('export async function createNoteFromInput'))
  assert(
    /void broadcastNoteChanged\(note\.id\)/.test(body.slice(0, 1200)),
    'createNoteFromInput 没有广播 —— 用户在主窗口看不到快速笔记刚建的那条',
  )
  assert(app.includes('folderId: null'), '快速笔记应落在「未归类」（不猜文件夹）')
})

check('浏览器预览下给出可读错误，而不是静默无反应', () => {
  const app = read('src/features/quick-note/QuickNoteApp.tsx')
  assert(app.includes('isTauri'), '缺少 isTauri 判定（浏览器 dev 下 initDb 会永久挂起）')
  assert(app.includes('NO_DB_MESSAGE'), '缺少可读的不可用说明')
})

/* ==================== E. t46：标题与正文分开输入 ==================== */

group('E. t46：标题 + 正文（用户要求「应该能输入标题和正文」）')

check('捕捉框有独立的标题输入框（且可留空）', () => {
  const app = read('src/features/quick-note/QuickNoteApp.tsx')
  assert(
    /data-zj-quick-note-title=/.test(app),
    '缺少标题输入框标记 data-zj-quick-note-title（探针据此断言用户能填标题）',
  )
  assert(
    /aria-label="快速笔记标题"/.test(app),
    '标题输入框必须有 aria-label（无障碍名称不能靠 placeholder 兜）',
  )
  assert(
    /QUICK_NOTE_TITLE_PLACEHOLDER/.test(app) && /可留空/.test(read('src/features/quick-note/quickNoteUrl.ts')),
    '标题占位文案必须写明"可留空"—— 否则用户以为必须填',
  )
})

check('保存时标题留空仍按首行推断（旧用法不丢）', () => {
  const app = read('src/features/quick-note/QuickNoteApp.tsx')
  assert(
    /title\.trim\(\)\s*\|\|\s*titleFromQuickContent\(content\)/.test(app),
    '标题处理必须是「填了用填的、留空按正文首个非空行推断」——丢掉后者等于破坏原有的快速记录用法',
  )
  assert(
    /await save\(text, title\)/.test(app),
    '保存必须把标题一起传下去（只传正文的话标题框就是个装饰）',
  )
})

check('标题框里 Enter 不直接保存（先填标题、再写正文的顺序）', () => {
  const app = read('src/features/quick-note/QuickNoteApp.tsx')
  const titleKeyBody =
    bodyAfter(app, /const handleTitleKeyDown\s*=\s*useCallback\(\s*\([^)]*\)\s*=>\s*\{/) ?? ''
  assert(Boolean(titleKeyBody), '找不到 handleTitleKeyDown 的函数体（锚点失效，需同步本断言）')
  assert(
    /inputRef\.current\?\.focus\(\)/.test(titleKeyBody),
    '标题框 Enter 应把光标送进正文框；直接保存会让"还没写正文"就成稿',
  )
  assert(
    /Escape/.test(titleKeyBody),
    '标题框也要能吃 Esc（用户在标题框里按 Esc 同样应该放弃）',
  )
  assert(
    /isComposing/.test(titleKeyBody),
    '标题框的按键同样必须先判输入法组合态（否则选词就把窗口关了）',
  )
})

/* ============================ 汇总 ============================ */

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} 快速笔记自检：共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`,
)
if (failed.length > 0) {
  console.log('\n失败清单：')
  for (const item of failed) console.log(`   - [${item.group}] ${item.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
