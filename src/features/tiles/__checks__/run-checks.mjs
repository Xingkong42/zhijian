/**
 * 磁贴纯逻辑自检（任务 t24 要求 ≥8 项）。
 * 归属：编辑器成员。
 *
 * 特点：**不需要浏览器、不需要 Tauri、不需要数据库**。
 *  - `../tileUrl.ts` 是无 JSX 的纯函数模块，Node 24 的类型擦除可以直接 import；
 *  - `../TileApp.tsx` 是 .tsx（Node 无法直接 import：ERR_UNKNOWN_FILE_EXTENSION），
 *    因此用 `vite.ssrLoadModule` 载入**真实模块**核对导出面（t23 同款做法）。
 *
 * 运行：node src/features/tiles/__checks__/run-checks.mjs
 */

import {
  TILE_AUTO_SAVE_DELAY_MS,
  TILE_MISSING_NOTE_HINT,
  TILE_MISSING_NOTE_TITLE,
  TILE_QUERY_KEY,
  TILE_WINDOW_PREFIX,
  isTileLocation,
  readTileNoteId,
  tileUrlSearch,
  tileWindowLabel,
  tileWindowUrl,
} from '../tileUrl.ts'

/* ------------------------------ 断言框架 ------------------------------ */

const results = []

/** 外部依赖体检结果（别人文件里的缺口，只报告不判失败） */
const externalNotes = []

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
}

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/* ======================= 1. readTileNoteId：正常路径 ======================= */

eq('readTileNoteId：标准 ?tile=<id>', readTileNoteId('?tile=note-a'), 'note-a')
eq('readTileNoteId：不带前导问号也认', readTileNoteId('tile=note-a'), 'note-a')
eq(
  'readTileNoteId：UUID 原样返回',
  readTileNoteId('?tile=3f1c9a2e-7b44-4d1f-9c3a-2b5e8f0a1d22'),
  '3f1c9a2e-7b44-4d1f-9c3a-2b5e8f0a1d22',
)
eq('readTileNoteId：URL 编码会被解码', readTileNoteId('?tile=%E7%AC%94%E8%AE%B0'), '笔记')
eq('readTileNoteId：首尾空白被裁掉', readTileNoteId('?tile=%20note-a%20'), 'note-a')

/* ======================= 2. readTileNoteId：缺失/无关参数 ======================= */

eq('readTileNoteId：空 search → null', readTileNoteId(''), null)
eq('readTileNoteId：只有问号 → null', readTileNoteId('?'), null)
eq('readTileNoteId：没有 tile 参数 → null', readTileNoteId('?foo=1&bar=2'), null)
eq('readTileNoteId：参数名前缀相似不算命中', readTileNoteId('?tile0=note-a'), null)
eq('readTileNoteId：大小写敏感（TILE 不算）', readTileNoteId('?TILE=note-a'), null)
eq('readTileNoteId：没有 = 的空参数 → null', readTileNoteId('?tile'), null)

/* ======================= 3. readTileNoteId：多参数与顺序 ======================= */

eq('readTileNoteId：多参数中取 tile', readTileNoteId('?foo=1&tile=xyz&bar=2'), 'xyz')
eq('readTileNoteId：tile 排在最后也行', readTileNoteId('?a=1&b=2&tile=last'), 'last')
eq('readTileNoteId：重复 tile 取第一个', readTileNoteId('?tile=first&tile=second'), 'first')

/* ======================= 4. readTileNoteId：空值/非法编码 ======================= */

eq('readTileNoteId：空值 → null', readTileNoteId('?tile='), null)
eq('readTileNoteId：纯空白 → null', readTileNoteId('?tile=%20%20%20'), null)
eq('readTileNoteId：畸形百分号编码 → null', readTileNoteId('?tile=%E0%A4%A'), null)
eq('readTileNoteId：截断的 UTF-8 序列 → null', readTileNoteId('?tile=%E4%B8'), null)
eq('readTileNoteId：非法单字节 %FF → null', readTileNoteId('?tile=%FF'), null)
// 文档化的宽松分支：URLSearchParams 对「截断的转义」既不抛错也不插 U+FFFD，而是原样保留。
// 这种值一定匹配不到任何笔记（走「这条笔记不在了」），因此不做额外校验，避免误伤合法值。
eq('readTileNoteId：截断转义原样保留（不误判为非法）', readTileNoteId('?tile=note%2'), 'note%2')
eq('readTileNoteId：双重编码的合法值不被误伤', readTileNoteId('?tile=a%2520b'), 'a%20b')

/* ======================= 5. 标签 / URL 构造 ======================= */

eq('tileWindowLabel：加前缀', tileWindowLabel('note-a'), 'tile-note-a')
eq('tileWindowLabel：前缀常量一致', TILE_WINDOW_PREFIX, 'tile-')
check(
  'tileWindowLabel：UUID 不做任何替换（label 合法）',
  tileWindowLabel('3f1c9a2e-7b44-4d1f-9c3a-2b5e8f0a1d22') ===
    'tile-3f1c9a2e-7b44-4d1f-9c3a-2b5e8f0a1d22',
  tileWindowLabel('3f1c9a2e-7b44-4d1f-9c3a-2b5e8f0a1d22'),
)
// Tauri label 允许字母/数字与 `-` `/` `:` `_`：这些保留，其余（空格、?、中文…）替换成 `_`
eq('tileWindowLabel：不允许的字符被替换', tileWindowLabel('a b?c'), 'tile-a_b_c')
eq('tileWindowLabel：Tauri 允许的 / 与 : 保留', tileWindowLabel('a/b:c'), 'tile-a/b:c')
eq(
  'tileWindowUrl：同源同路径 + 编码参数',
  tileWindowUrl('note a', 'tauri://localhost', '/index.html'),
  'tauri://localhost/index.html?tile=note%20a',
)
eq('tileUrlSearch：只给 query 片段', tileUrlSearch('笔记'), '?tile=%E7%AC%94%E8%AE%B0')
eq('tileUrlSearch：参数名固定', TILE_QUERY_KEY, 'tile')
check(
  'tileUrlSearch 结果能被 readTileNoteId 读回（往返一致）',
  readTileNoteId(tileUrlSearch('a b/c')) === 'a b/c',
  tileUrlSearch('a b/c'),
)
eq('isTileLocation：有 tile → true', isTileLocation('?tile=x'), true)
eq('isTileLocation：无 tile → false', isTileLocation('?foo=1'), false)

/* ======================= 6. 常量/文案 ======================= */

check(
  'TILE_AUTO_SAVE_DELAY_MS 落在契约区间 400–600ms',
  TILE_AUTO_SAVE_DELAY_MS >= 400 && TILE_AUTO_SAVE_DELAY_MS <= 600,
  String(TILE_AUTO_SAVE_DELAY_MS),
)
check('失效笔记文案非空（不出现空白页）', TILE_MISSING_NOTE_TITLE.length > 0 && TILE_MISSING_NOTE_HINT.length > 0)

/* ======================= 7. TileApp.tsx 导出面（Vite SSR） ======================= */

const tileApp = await loadTsxModule('/src/features/tiles/TileApp.tsx')
if (!tileApp) {
  check('TileApp.tsx 可被 Vite SSR 载入', false, 'ssrLoadModule 失败，见上方异常')
} else {
  check('TileApp.tsx 导出 TileApp 组件', typeof tileApp.TileApp === 'function')
  check('TileApp.tsx 默认 I/O 可注入（导出 defaultLoadTileNote）', typeof tileApp.defaultLoadTileNote === 'function')
  check('TileApp.tsx 导出 defaultSaveTileNote', typeof tileApp.defaultSaveTileNote === 'function')
  check(
    'TileApp.tsx 也导出 readTileNoteId（主入口可直接从它引）',
    typeof tileApp.readTileNoteId === 'function',
  )
  eq('TileApp.tsx 的 readTileNoteId 与 tileUrl 同源', tileApp.readTileNoteId?.('?tile=note-a'), 'note-a')
}

const tilesIndex = await loadTsxModule('/src/features/tiles/index.ts')
if (!tilesIndex) {
  check('tiles/index.ts 可被载入', false, 'ssrLoadModule 失败')
} else {
  check('index.ts 重新导出 readTileNoteId', typeof tilesIndex.readTileNoteId === 'function')
  check('index.ts 重新导出 toggleTileForNote', typeof tilesIndex.toggleTileForNote === 'function')
  check('index.ts 重新导出 TileApp', typeof tilesIndex.TileApp === 'function')
  eq('index.ts 的 readTileNoteId 与 tileUrl 是同一实现', tilesIndex.readTileNoteId('?tile=z'), 'z')

  /* ============ 跨界联动：前端命令常量 ↔ Rust 注册命令（真实踩过的坑） ============
     曾经 JS 写 'tile_toggle' 而 Rust 注册的是 'cmd_toggle_tile'：invoke 报 not found 被 catch
     吞掉 → 静默退化成前端建窗，功能「看着正常」，但 Rust 侧的几何持久化 / 可见性事件 /
     开机恢复磁贴全都不执行。这里直接读 Rust 源码核对，杜绝同类漂移。 */
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '../../../..')
  const libRs = readIfExists(path.join(repoRoot, 'src-tauri/src/lib.rs'), fs)
  const tilesRs = readIfExists(path.join(repoRoot, 'src-tauri/src/tiles.rs'), fs)

  if (!libRs || !tilesRs) {
    check('可读取 Rust 源码以核对命令名', false, 'src-tauri/src/{lib.rs,tiles.rs} 缺失')
  } else {
    const commands = tilesIndex.TILE_RUST_COMMANDS ?? {}
    check('tiles 导出 TILE_RUST_COMMANDS', typeof commands.toggle === 'string')
    for (const [role, name] of Object.entries(commands)) {
      check(
        `Rust 侧注册了命令 ${name}（${role}）`,
        libRs.includes(`tiles::${name}`) && tilesRs.includes(`fn ${name}`),
        `lib.rs 含 "tiles::${name}"=${libRs.includes(`tiles::${name}`)}；tiles.rs 含 "fn ${name}"=${tilesRs.includes(`fn ${name}`)}`,
      )
    }

    const fallback = tilesIndex.TILE_FALLBACK_WINDOW ?? {}
    const rustNumber = (key) => {
      const matched = new RegExp(`${key}\\s*:\\s*f64\\s*=\\s*([0-9.]+)`).exec(tilesRs)
      return matched ? Number(matched[1]) : null
    }
    eq('退化建窗宽 = Rust TILE_DEFAULT_WIDTH', fallback.width, rustNumber('TILE_DEFAULT_WIDTH'))
    eq('退化建窗高 = Rust TILE_DEFAULT_HEIGHT', fallback.height, rustNumber('TILE_DEFAULT_HEIGHT'))
    eq('退化建窗最小宽 = Rust TILE_MIN_WIDTH', fallback.minWidth, rustNumber('TILE_MIN_WIDTH'))
    eq('退化建窗最小高 = Rust TILE_MIN_HEIGHT', fallback.minHeight, rustNumber('TILE_MIN_HEIGHT'))

    const rustPrefix = /TILE_LABEL_PREFIX:\s*&str\s*=\s*"([^"]+)"/.exec(tilesRs)
    eq('label 前缀 = Rust TILE_LABEL_PREFIX', TILE_WINDOW_PREFIX, rustPrefix ? rustPrefix[1] : null)
    check('Rust 侧 URL 带 tile= 参数（前端 readTileNoteId 依赖）', /tile=\{note_id\}/.test(tilesRs))

    /* ---------- 外部依赖体检（软报告，不计失败）----------
       本目录的代码真实依赖下列权限；它们归 architect 的 capabilities/tiles.json。
       `data-tauri-drag-region` 不是"免权限"的：Tauri 2.11 注入的 drag.js 会执行
       `__TAURI_INTERNALS__.invoke('plugin:window|start_dragging')`，走 IPC ⇒ 受 ACL 管。
       这里只打印体检结果，不把别人的文件计入我的失败数；缺口一补就自动变绿。 */
    const tilesCapability = readIfExists(
      path.join(repoRoot, 'src-tauri/capabilities/tiles.json'),
      fs,
    )
    if (!tilesCapability) {
      externalNotes.push('capabilities/tiles.json 不存在 → 磁贴窗口所有 IPC 都会被拒')
    } else {
      const required = [
        ['core:window:allow-close', 'TileApp 的「关闭磁贴」（getCurrentWindow().close()）'],
        ['core:window:allow-start-dragging', '拖拽头（drag.js → plugin:window|start_dragging）'],
        ['sql:allow-load', 'initDb()（plugin-sql Database.load）'],
        ['sql:allow-select', 'notesRepo.get（读笔记）'],
        ['sql:allow-execute', 'notesStore.update（自动保存）'],
      ]
      for (const [permission, why] of required) {
        if (!tilesCapability.includes(`"${permission}"`)) {
          externalNotes.push(`tiles.json 缺 ${permission} → ${why}`)
        }
      }

      /* 「该 deny 的有没有 deny」——system 指出这类**多授权导致的意外行为**两套探针原先都覆盖不到。
         **通则**（system 建议的收紧，这里直接实现）：只要存在任何**可达的最大化通路**，磁贴能力就
         必须显式 `deny-internal-toggle-maximize`（Tauri 侧 deny 优先于 allow）。
         当前已核实的通路与依据：
           a) 拖拽头：drag.js 双击拖拽区 invoke `plugin:window|internal_toggle_maximize`
              ⇒ 双击磁贴头会把便签最大化（system 已 grep tiles.rs/lib.rs 确认这是**唯一**通路）；
           b) `core:default` 自带 `allow-internal-toggle-maximize`
              （core:window:default 的 27 只读 + 1 写里的那一项，system 实测）；
           c) 将来若 tiles.rs 新增程序化最大化（`set_maximized`/`toggle_maximize`/`maximize(`），
              也必须同步保留这条 deny —— 下面的检测已把它纳入。
         因此这条断言不写死"看到 core:default 就要求 deny"，而是**逐条探测可达通路**，
         通路集合为空时不强制（避免将来拖拽头被移除后产生误判）。 */
      const tileAppSource = readIfExists(
        path.join(repoRoot, 'src/features/tiles/TileApp.tsx'),
        fs,
      )
      const maximizePaths = []
      if (tilesCapability.includes('"core:default"')) {
        maximizePaths.push('core:default 自带 allow-internal-toggle-maximize')
      }
      if (tileAppSource && /data-tauri-drag-region/.test(tileAppSource)) {
        maximizePaths.push('拖拽头（drag.js 双击 → internal_toggle_maximize）')
      }
      if (/internal_toggle_maximize|toggle_maximize|set_maximized|maximize\(/.test(tilesRs)) {
        maximizePaths.push('tiles.rs 里的程序化最大化')
      }
      const hasMaximizeDeny = tilesCapability.includes(
        '"core:window:deny-internal-toggle-maximize"',
      )
      // ⚠️ t22（F1）修正：这条断言**曾经给出虚假信心**。旧版本只要求"有 deny"就判通过，
      //    而 t21 的运行时实证证明：**双击磁贴头仍然铺满屏**、tiles.json 被写成最大化矩形 ——
      //    也就是说 `drag.js` 那条**注入脚本**调用路径**不受 capability deny 约束**。
      //    ⇒ 断言必须改为检查**真正的护栏**（Rust 侧两层），deny 只作为防御纵深保留。
      //    （框架层 `resolve_access` 确实先查 denied_commands：tauri-2.11.6/src/ipc/authority.rs:446-452；
      //      但它对显式 JS API 调用有效、对注入路径实测无效 —— 这个差异写进了 capabilities/tiles.json 描述。）
      // ⚠️ 必须**先剥掉注释行**再匹配：本文件这三条护栏的关键字在**注释里也会出现**
      //    （例如「ASCII 锚点 tile-geometry-untrusted 是给探针用的」这句注释）。
      //    t22 的变异测试实测踩到过：把 `.maximizable(false)` 注释掉，断言**仍然通过**
      //    —— 因为正则匹配到了注释里的那段文字。断言写松了就会假绿。
      const tilesRsCode = tilesRs
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim()
          return !(
            trimmed.startsWith('//') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('*')
          )
        })
        .join('\n')
      const hasFrameworkGate = /\.maximizable\(false\)/.test(tilesRsCode)
      const hasGeometryGate =
        /pub fn sanitize_geometry/.test(tilesRsCode) &&
        /tile-geometry-untrusted/.test(tilesRsCode) &&
        /is_maximized\(\)/.test(tilesRsCode)
      check(
        't22-F1：真正挡「双击最大化」的两层护栏都在（framework maximizable(false) + 几何闸门），deny 仅作纵深',
        (!maximizePaths.length || hasMaximizeDeny) && hasFrameworkGate && hasGeometryGate,
        `通路：${maximizePaths.join('、') || '（无）'}；deny=${hasMaximizeDeny}（仅纵深，**不充分**）；` +
          `maximizable(false)=${hasFrameworkGate}（框架闸门，plugin.rs:228 只在 is_maximizable() 为真时最大化）；` +
          `sanitize_geometry + 最大化不落盘=${hasGeometryGate}（几何闸门）`,
      )
      check(
        't22-F1：运行时闭环探针可复跑（否则这条又是「静态绿、运行时被推翻」）',
        readIfExists(path.join(repoRoot, 'scripts/probe-tile-maximize.ps1'), fs) !== null &&
          /IsZoomed/.test(readIfExists(path.join(repoRoot, 'scripts/probe-tile-maximize.ps1'), fs)),
        '缺少 scripts/probe-tile-maximize.ps1（真机双击 → IsZoomed 必须为 false 的闭环证据）',
      )
      // 把探测到的通路打出来：既证明这条断言**不是空跑**（当前应命中 2 条），
      // 也让将来加最大化通路的人一眼看到"必须同时保住 Rust 侧两层护栏"。
      if (maximizePaths.length > 0) {
        console.log(
          `\n最大化通路探测：${maximizePaths.join('；')} → ` +
            `框架闸门 ${hasFrameworkGate ? '✓' : '✗'}、几何闸门 ${hasGeometryGate ? '✓' : '✗'}` +
            `（deny ${hasMaximizeDeny ? '在位，但**不充分**' : '缺失'}）`,
        )
      }
    }
  }
}

/** 读文本文件；不存在返回 null（用于可选核对 Rust 源码） */
function readIfExists(filePath, fs) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/* ------------------------------ helpers ------------------------------ */

/** 用 Vite SSR 管线载入 .tsx/.ts 模块（Node 原生无法 import .tsx） */
async function loadTsxModule(modulePath) {
  const path = await import('node:path')
  const url = await import('node:url')
  const vite = await import('vite')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const root = path.resolve(here, '../../../..')
  const server = await vite.createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  try {
    return await server.ssrLoadModule(modulePath)
  } catch (error) {
    check(`Vite SSR 载入 ${modulePath}`, false, error instanceof Error ? error.message : String(error))
    return null
  } finally {
    await server.close()
  }
}

/* ============ t45：固定磁贴 / 状态对账 / 脏磁贴清理（用户报障的防回归） ============
   用户原话三句，对应下面三组断言：
     ② 「我关闭磁贴后，关闭整个程序后，下次开启后还是会显示那些磁贴」
     ③ 「每次启动程序，中间会显示一个空白磁贴，显示这条笔记不存在」
     ① 「用磁贴的 × 关闭后，主界面上『取消桌面磁贴』按钮不能自动恢复」
   加一条产品要求：「固定某个磁贴，用户自己决定哪个磁贴在开启后永久保留」。
   这些行为的失败形态全是"看起来没事"（重启才知道、下次开机才知道），所以必须机器守住。 */

{
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const urlMod = await import('node:url')
  const hereDir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url))
  const projectRoot = pathMod.resolve(hereDir, '../../../..')
  const read = (rel) => {
    try {
      return fsMod.readFileSync(pathMod.join(projectRoot, rel), 'utf8')
    } catch {
      return ''
    }
  }
  /** 去注释再匹配：本项目栽过「断言命中的其实是注释」 */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  /** 按大括号配对取一段函数体（断言要锚在结构上，不能"往后 N 个字符"） */
  const bodyAfter = (source, pattern) => {
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

  const tilesRs = read('src-tauri/src/tiles.rs')
  const eventsRs = read('src-tauri/src/events.rs')
  const appTsx = strip(read('src/App.tsx'))
  const tileWindowsTs = strip(read('src/features/tiles/tileWindows.ts'))
  const tileAppTsx = strip(read('src/features/tiles/TileApp.tsx'))
  const tauriTs = strip(read('src/lib/tauri.ts'))

  // ---- ② 启动只恢复「被固定」的磁贴 ----
  const restoreBody = bodyAfter(tilesRs, /fn tiles_to_restore\s*\([^)]*\)[^{]*\{/)
  /**
   * ⚠️ 这条断言被变异测试改过两次，两次都值记录：
   *  1. 第一版只检查"体内出现 `.pinned` 与 `filter`" —— 把条件改成 `!geometry.pinned`
   *     （语义完全相反：只恢复**没固定**的）照样通过 ⇒ **假断言**；
   *  2. 第二版用 `\.filter\([^)]*\.pinned\)` —— 对**正确代码**报错，因为 `[^)]*`
   *     跨不过闭包的参数括号（`|(_, geometry)|` 里就有 `)`）。
   * 现在：正向用 `[^;]{0,120}?`（`;` 是 Rust 语句边界，不会出现在这段区间里），
   * 再用负向断言排除取反形态。**能区分"正确"与"相反"的断言才算断言。**
   */
  const filterPinned = /\.filter\([^;]{0,120}?\.pinned/.test(restoreBody ?? '')
  const filterNegated = /\.filter\([^;]{0,120}?!\s*\w+\.pinned/.test(restoreBody ?? '')
  check(
    't45-②：启动恢复名单只看 pinned（且不得取反）',
    Boolean(restoreBody) && filterPinned && !filterNegated,
    'tiles_to_restore 必须按 `geometry.pinned` 正向过滤；取反或不过滤都会让"关掉的磁贴下次启动又回来"（用户报障 ②）',
  )
  check(
    't45-②：init 必须用 tiles_to_restore，不得再直接遍历文件条目',
    /tiles_to_restore\(&file\)/.test(tilesRs) && !/file\.tiles\.keys\(\)\.cloned\(\)/.test(tilesRs),
    'init 若回到"文件里有条目就恢复"，用户关掉的磁贴会再次出现在桌面上',
  )
  check(
    't45-②：旧文件（无 pinned 字段）必须回落为未固定',
    /#\[serde\(default\)\]\s*pub pinned:\s*bool/.test(tilesRs),
    '缺 `#[serde(default)]` 时旧 tiles.json 会解析失败或语义漂移；升级后旧残留会自己冒出来',
  )

  // ---- 拖动不得抹掉「固定」----
  const rememberBody = bodyAfter(tilesRs, /fn remember_geometry\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't45：移动/缩放不得改变 pinned（否则"拖一下就失去固定"）',
    Boolean(rememberBody) && /pinned/.test(rememberBody) && /existing|get\(/.test(rememberBody),
    'remember_geometry 必须保留已存的 pinned；整体覆盖会让拖动把固定状态清成 false',
  )

  // ---- ① 磁贴被关闭 ⇒ 广播事件 ⇒ 主窗口对账 ----
  check(
    't45-①：窗口 Destroyed 必须广播 TILES_CHANGED',
    /WindowEvent::Destroyed\s*=>[\s\S]{0,600}?emit\(events::TILES_CHANGED/.test(tilesRs),
    '没有这条事件时，用户从磁贴那侧关掉后，主窗口按钮会一直停在「取消桌面磁贴」',
  )
  check(
    't45-①：TILES_CHANGED 已在 events.rs 登记（常量 + ALL）',
    /pub const TILES_CHANGED:\s*&str\s*=\s*"zhijian:\/\/tiles-changed";/.test(eventsRs) &&
      /^\s*TILES_CHANGED,\s*$/m.test(eventsRs),
    '事件必须同时出现在常量与 ALL 数组里（check:contract 还会与前端 EVENTS 双向核对）',
  )
  check(
    't45-①：前端订阅 onTilesChanged 并对账（引用 EVENTS 常量，不写死字符串）',
    /export async function onTilesChanged/.test(tauriTs) &&
      /EVENTS\.tilesChanged/.test(tauriTs) &&
      /onTilesChanged\(/.test(appTsx),
    'App 必须订阅磁贴集合变化并重新对账（Rust 是权威，前端只能靠事件知道它变了）',
  )

  // ---- ③ 脏磁贴清理 ----
  const pruneBody = bodyAfter(appTsx, /const pruneStaleTiles\s*=\s*useCallback\(\s*async\s*\([^)]*\)\s*=>\s*\{/)
  check(
    't45-③：清理判据必须与磁贴的读取路径一致（notesRepo.get）',
    Boolean(pruneBody) && /notesRepo\.get\(/.test(pruneBody),
    '判据要用 `notesRepo.get(id)`（与磁贴自己的读路径同一条查询）；用别的口径会出现"判据说能读到、磁贴读不到"',
  )
  check(
    't45-③：清理判据**不得**用 includeDeleted 判存在性',
    Boolean(pruneBody) && !/includeDeleted/.test(pruneBody),
    '回收站里的笔记在索引里是存在的，但磁贴读不到它 —— 用 includeDeleted 判存在性正好漏掉本 bug 的情形',
  )
  /**
   * 下面两条来自**真机探针抓到的第二个 bug**（比第一个更危险）：
   * `pruneStaleTiles` 在挂载后立刻跑，而启动流程（initDb → 各仓储）是异步的 ⇒
   * 库还没就绪就查库、`notesRepo.get` 抛错；第一版把异常也当成"不可读"，
   * 于是竞态下会把**用户正常的磁贴（含已固定的）**全部清掉。
   * 现象随机（取决于 initDb 与挂载的先后），静态门与单测都看不见 ⇒ 必须钉死。
   */
  check(
    't45-③：清理前必须确保数据库就绪（否则竞态下会把正常磁贴当脏条目）',
    Boolean(pruneBody) && /await initDb\(\)/.test(pruneBody),
    '不 await initDb 就在挂载后查库，`notesRepo.get` 会抛错；真机实测会误删用户正常的磁贴',
  )
  /**
   * 判据必须落在**逐条检查那次查询的 catch 块体内部**。
   * 两次踩坑记录（都很典型）：
   *  1. 用"catch 之后 180 字符"：把 catch 块**之后**正常路径的 `stale.push` 也算了进去
   *     ⇒ 对正确代码报错；
   *  2. 直接取"第一个 catch"：拿到的是上面 `await initDb()` 那个 catch（含 `return`）
   *     ⇒ 又对正确代码报错。
   * 现在从 `notesRepo.get(` 之后取 catch —— 锚在**语义位置**上，而不是"第几个出现"。
   */
  const getIndex = (pruneBody ?? '').indexOf('notesRepo.get(')
  const catchBody =
    getIndex >= 0 ? bodyAfter(pruneBody.slice(getIndex), /catch\s*\([^)]*\)\s*\{/) : null
  check(
    't45-③：查询抛错必须"跳过该条"，绝不能当成"笔记不存在"',
    Boolean(catchBody) && /continue/.test(catchBody) && !/stale\.push/.test(catchBody),
    '把异常当成"不存在"会在竞态下清掉用户正常的（甚至已固定的）磁贴；必须 fail-safe：查不了就保留',
  )
  check(
    't45-③：启动时必须先清理脏磁贴再对账',
    /await pruneStaleTiles\(\)[\s\S]{0,200}?await refreshTileState\(\)/.test(appTsx),
    '先清后取：清理本身会改动磁贴集合，顺序反了会让按钮状态过期一轮',
  )

  // ---- 取消固定的顺序 + 删除笔记时一并退场 ----
  const retireBody = bodyAfter(
    appTsx,
    /const retireTiles\s*=\s*useCallback\(\s*async\s*\([^)]*\)\s*=>\s*\{/,
  )
  const pinnedIndex = retireBody ? retireBody.indexOf('setTilePinned(') : -1
  // t48：关窗那一步从 `toggleTileForNote` 换成了 `closeTileForNote`（确保关闭，避免"关了又开"）
  const closeIndex = retireBody ? retireBody.indexOf('closeTileForNote(') : -1
  check(
    't45：退场必须先取消固定、再关窗（顺序反了会在退出竞态里"复活"）',
    pinnedIndex >= 0 && closeIndex > pinnedIndex,
    // ⚠️ 区分两种失败：锚点没匹配（结构变了）与顺序真的反了 —— 混在一起会让人查错方向
    //    （第一版锚点漏了 `async`，报出来的却是"顺序反了"；t48 换成 closeTileForNote 又红过一次，都属前者）。
    retireBody === null
      ? '找不到 retireTiles 的函数体（锚点失效，需同步本断言）'
      : '先关窗后取消固定：若此刻退出应用，tiles.json 里留着 pinned=true ⇒ 下次启动它又出现',
  )
  check(
    't45：软删与硬删笔记都必须让它的磁贴退场（不能只修一处）',
    /handleRemoveNote[\s\S]{0,400}?await retireTiles\(\[id\]\)/.test(appTsx) &&
      /handleHardDeleteNote[\s\S]{0,600}?await retireTiles\(\[id\]\)/.test(appTsx),
    '只改软删的话，"彻底删除"仍会留下一个指向不存在笔记的磁贴（用户报障 ③ 的另一半）',
  )

  // ---- 顺带修掉的真 bug：closeTileForNote 曾把"关闭"变成"打开" ----
  const closeBody = bodyAfter(tileWindowsTs, /export async function closeTileForNote\s*\([^)]*\)[^{]*\{/)
  check(
    't45：closeTileForNote 必须先判"是否开着"（原先会凭空打开一枚磁贴）',
    Boolean(closeBody) && /isTileWindowOpen\(/.test(closeBody),
    '它的实现原先无条件调用 toggle（没开就打开）却返回 closed —— 调用方会凭空造出一枚磁贴',
  )

  // ---- 固定功能的 UI 契约 ----
  check(
    't45：磁贴标题栏有固定按钮，且是**三态**（unknown / on / off）',
    /data-zj-tile-pin=/.test(tileAppTsx) &&
      /'unknown'/.test(tileAppTsx) &&
      /aria-pressed=/.test(tileAppTsx),
    '读不到固定状态时必须显示 unknown 并禁用，而不是把图钉画成"未固定"（那是在编造状态）',
  )
  check(
    't45：固定写操作以 Rust 返回值为准（失败要弹回，不能本地取反了事）',
    /applied === null/.test(tileAppTsx) && /setPinned\(applied\)/.test(tileAppTsx),
    '本地取反 + 写失败 = 用户以为固定住了，下次启动却什么都没出现',
  )
  check(
    't45：读固定状态走 Rust 权威列表（不得本地缓存推断）',
    /export async function defaultLoadTilePinned/.test(tileAppTsx) &&
      /listTiles\(\)/.test(tileAppTsx),
    '固定状态只存在 Rust 的 tiles.json 里，前端自存一份就会成为第二个真相源',
  )
  // ---- t46：固定磁贴"永远留在桌面上"（全部显隐只影响临时磁贴）+ 清空回收站 ----
  const allVisibleBody = bodyAfter(tilesRs, /pub fn set_all_visible_impl\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  /**
   * 用户明确要求（Q2）：固定的磁贴永远留在桌面上，快捷键只影响临时磁贴。
   * 断言必须能区分"跳过固定的"与"无差别全收" —— 只检查"出现 pinned 字样"是不够的
   * （注释里也会出现），所以锚在**过滤表达式**上。
   */
  check(
    't46：全部显隐必须跳过已固定的磁贴（否则"永久保留"是假的）',
    Boolean(allVisibleBody) && /geometry_for\([^)]*\)\.pinned/.test(allVisibleBody ?? ''),
    'set_all_visible_impl 里必须按 pinned 跳过：固定的磁贴只应由用户自己在磁贴上操作',
  )
  check(
    't46：没有临时磁贴时不得谎报显隐状态',
    Boolean(allVisibleBody) && /windows\.is_empty\(\)/.test(allVisibleBody ?? ''),
    '只有固定磁贴时本函数不改变任何窗口 —— 此时必须如实回报"桌面上还有磁贴可见"，不能返回一个没执行过的 target',
  )

  /**
   * ⚠️ 这两条断言被变异测试证明过是**假断言**（第一版窗口写 `[\s\S]{0,900}?`）：
   * `handleEmptyTrash` 的**相邻函数**（`handleHardDeleteNote`）里也有
   * `notesRepo.hardDelete(` 与 `retireTiles(`，于是"只要附近有这些调用"就通过 ——
   * 把 handleEmptyTrash 里的调用全删掉，断言照样绿。
   * 现在锚在**函数体内部**（大括号配对）。
   */
  const emptyTrashBody = bodyAfter(appTsx, /const handleEmptyTrash\s*=\s*useCallback\(\s*async\s*\([^)]*\)\s*=>\s*\{/)
  check(
    't46：清空回收站必须走数据层 hardDelete（不能自己删文件）',
    Boolean(emptyTrashBody) && /notesRepo\.hardDelete\(/.test(emptyTrashBody ?? ''),
    'md 是真相源：绕过 hardDelete 自己删文件会留下"文件没了、索引还在"的半死状态',
  )
  check(
    't46：清空回收站后必须让这些笔记的磁贴退场',
    Boolean(emptyTrashBody) && /retireTiles\(/.test(emptyTrashBody ?? ''),
    '否则桌面上会留下指向已删笔记的空白磁贴（正是 t45 那个报障的形态）',
  )

  /* ---------------- t47：吸附成组（拖动跟随 / 松手吸附 / 拖开解组 / 显式解组） ---------------- */

  check(
    't47：吸附阈值是命名常量（手感可调、可被单测引用）',
    // 值本身也钉住：它是**产品决策**（用户把 8px 收到 2px），被无意改动时应当报警
    /pub const SNAP_THRESHOLD:\s*f64\s*=\s*2\.0;/.test(tilesRs) && /t48 按用户要求从 8px 收到 2px/.test(tilesRs),
    '阈值必须是一个具名常量且值符合最新决策（2px）；写死在调用处会让"手感"无法被审查与单测',
  )
  check(
    't47：吸附算法是**纯函数**（几何进、位置出，不碰窗口/状态）',
    /pub fn snap_position\(\s*moving:\s*TileGeometry,\s*others:\s*&\[TileGeometry\],\s*threshold:\s*f64,?\s*\)\s*->\s*Option<\(f64, f64\)>/.test(
      tilesRs,
    ),
    '吸附必须是纯函数才能穷举单测（拖拽手感只能真机调，但取舍规则必须能机器验证）',
  )

  const rememberBodyT47 = bodyAfter(tilesRs, /fn remember_geometry\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't47：移动不得改变组号（否则"拖一下就散伙"）',
    // ⚠️ 必须锚在"从已存值读 group"这个动作上：只查 `group` 字样的话，
    //    `let group = 0;`（变异：每次移动都清空组号）也会通过 —— 变异测试证明过。
    Boolean(rememberBodyT47) && /\.get\(note_id\)[\s\S]{0,80}?\.group/.test(rememberBodyT47 ?? ''),
    'remember_geometry 必须像保留 pinned 一样地"读出已存的 group 再写回"',
  )

  const propagateBody = bodyAfter(tilesRs, /fn propagate_group_move\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  const rememberIndex = propagateBody ? propagateBody.indexOf('remember_geometry(') : -1
  // t49：设位置那一步搬到了 `flush_pending_forward`（固定周期补发），
  // 因此这里的语义变成"**必须先推进记录、再挂待发布位置**" —— 记录不推进的话，
  // 连续登记算出的目标位置会少算（每次都从旧记录起算），跟随就会越拖越落后。
  const pendingIndex = propagateBody ? propagateBody.indexOf('pending.insert(') : -1
  check(
    't47/t49：整组跟随必须先推进记录、再挂待补发位置（否则位移会少算）',
    rememberIndex >= 0 && pendingIndex > rememberIndex,
    '顺序反了会让连续登记的位置累加不出来（跟随者越拖越落后），正是"慢几拍"的另一种成因',
  )

  // t49：真正的吸附逻辑在 `_inner` 里（外层只负责投递到主线程）
  const snapBody =
    bodyAfter(tilesRs, /fn apply_snap_after_move_inner\s*<[^>]*>\s*\([^)]*\)[^{]*\{/) ??
    bodyAfter(tilesRs, /fn apply_snap_after_move\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't47：松手后才吸附（在去抖线程里、且**不在**拖动路径上）',
    /apply_snap_after_move\(&worker_app\)/.test(tilesRs) &&
      !/apply_snap_after_move\(/.test(propagateBody ?? ''),
    '拖动中吸附会"粘住"（想再挪开却被吸回）；它必须由尾沿去抖（= 松手）触发',
  )
  check(
    't47：组关系必须按**吸附后**的位置重算',
    Boolean(snapBody) && /let moving_now = geometry_for\(/.test(snapBody ?? ''),
    '用吸附前的缝隙判组会出现"明明贴上了却没成组"',
  )
  check(
    't47：必须清理"只剩一个成员"的孤儿组',
    /fn prune_singleton_groups/.test(tilesRs) && /prune_singleton_groups\(app\)/.test(snapBody ?? ''),
    '不清的话被拖走那枚的同伴会一直显示「取消吸附」，却没有可吸附的对象（假状态）',
  )
  check(
    't47：成组/解组后必须广播状态变化（磁贴据此刷新按钮）',
    Boolean(snapBody) && /emit\(events::TILES_CHANGED/.test(snapBody ?? ''),
    '不广播的话磁贴不知道自己刚被吸住，永远不显示「取消吸附」',
  )

  check(
    't47：磁贴的「取消吸附」按钮只在**真的在组里**时出现',
    /group !== null && group > 0 \?/.test(tileAppTsx) && /data-zj-tile-ungroup=/.test(tileAppTsx),
    '无条件下渲染会出现"点了没反应的假入口"（读不到状态时也不该显示）',
  )
  check(
    't47：磁贴订阅 tiles-changed 以刷新吸附状态（吸附发生在 Rust 侧）',
    /onTilesChanged\(refresh\)/.test(tileAppTsx),
    '不订阅的话"刚被吸住"这件事磁贴收不到（吸附/成组全在 Rust 里发生）',
  )
  const tileInfoBody = bodyAfter(tilesRs, /pub struct TileInfo\s*\{/)
  check(
    't47：TileInfo 必须把组号暴露给前端（按钮显示与否的依据）',
    // ⚠️ 必须锚在 **TileInfo 结构体内**：`TileGeometry` 里也有 `pub group: u32`，
    //    只对全文匹配的话"把 TileInfo 的字段删掉"照样通过（变异测试证明过）。
    Boolean(tileInfoBody) && /pub group:\s*u32,/.test(tileInfoBody ?? '') && /group: saved\.group/.test(tilesRs),
    'list_tiles_impl 不填 group 的话前端永远拿不到组状态',
  )

  /* ---------------- t48：防反馈循环（堆损坏崩溃的修复） + 长去抖 ---------------- */

  const markBody = bodyAfter(tilesRs, /fn move_window_programmatically\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't48：所有程序性移动必须**先登记期望落点**再设位置',
    Boolean(markBody) && /mark_programmatic\(/.test(markBody ?? '') && /set_position\(/.test(markBody ?? ''),
    '少登记一步，随之而来的 Moved 会被当成"用户拖动"再传播一次 —— 这正是无限反馈（堆损坏崩溃）的入口',
  )
  check(
    't48：Moved 里必须先识别程序性移动并return（不能只靠"记录已更新"隐式抑制）',
    /if consume_programmatic\(app, &note_id, clean\.x, clean\.y\)\s*\{\s*return;/.test(tilesRs),
    '缺这一步时，只要实际落点与请求值差 1px（DPI 取整），delta 就永远不为 0 ⇒ 消息无限增殖',
  )
  /**
   * t49：把"节流兜底"升级成三条**更强的不变量** —— 用户实测「大幅度快速拖动就崩溃」
   * 与「跟随慢几拍」都指向同一件事：拖动期间不该往窗口层投递成比例增长的消息。
   */
  const propagateBodyT49 = bodyAfter(tilesRs, /fn propagate_group_move\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't49：整组跟随的登记路径里**不得**直接操作窗口（拖动期间零窗口消息）',
    Boolean(propagateBodyT49) &&
      !/set_position\(/.test(propagateBodyT49 ?? '') &&
      !/move_window_programmatically\(/.test(propagateBodyT49 ?? '') &&
      /pending_forward/.test(propagateBodyT49 ?? ''),
    '拖动期间逐帧 set_position 会让消息量与拖动速度成正比：既导致"跟随慢几拍"（排队），又导致堆积崩溃',
  )
  const flushBody = bodyAfter(tilesRs, /fn flush_pending_forward\s*<[^>]*>\s*\([^)]*\)[^{]*\{/)
  check(
    't49：跟随位置必须由固定周期统一补发（消息量恒定）',
    Boolean(flushBody) && /run_on_main_thread/.test(flushBody ?? '') && /move_window_programmatically\(/.test(flushBody ?? '') &&
      /FOLLOW_CHASE_PERIOD/.test(tilesRs),
    '没有"登记 + 周期补发"这一层，消息量就随拖动速度增长',
  )
  check(
    't49：去抖必须是**真正的尾沿去抖**（收到信号不能立刻落盘）',
    // 线程体里必须出现"记录信号时刻 + 两个时间窗 + 新信号时重置"的形态
    /let mut last_signal = Instant::now\(\)/.test(tilesRs) &&
      /last_signal = Instant::now\(\)/.test(tilesRs) &&
      /quiet >= PERSIST_QUIET_PERIOD/.test(tilesRs) &&
      !/Ok\(\(\)\)\s*=>\s*\{\s*\/\/[^\n]*\n\s*while rx\.try_recv\(\)\.is_ok\(\) \{\}/.test(tilesRs),
    '原实现是假去抖：recv_timeout 收到第一个信号立刻返回就写盘 ⇒ 快速拖动时每次移动都写文件（每秒上百次 IO）',
  )
  check(
    't49：窗口层操作一律投递到主线程（后台线程只做内存登记）',
    /fn apply_snap_after_move[\s\S]{0,400}?run_on_main_thread/.test(tilesRs) && /fn flush_pending_forward[\s\S]{0,600}?run_on_main_thread/.test(tilesRs),
    '后台线程直接读窗口属性/设位置是崩溃的又一条路径；统一投递后线程边界清晰',
  )
  check(
    't48：位移死区覆盖 DPI 取整（1.5px）',
    /const MOVE_DEAD_ZONE:\s*f64\s*=\s*1\.5;/.test(tilesRs),
    '死区小于取整误差时，1px 的抖动会带着整组持续抖动',
  )
  check(
    't48：去抖静默期必须是 3 秒（用户要求：留足拖动决策时间）',
    /const PERSIST_QUIET_PERIOD:\s*Duration\s*=\s*Duration::from_millis\(3000\);/.test(tilesRs),
    '它同时决定"何时吸附"与"何时落盘"，改成别的值等于改掉用户要的手感',
  )
  check(
    't48：让磁贴退场必须用"确保关闭"，不得再用 toggle（关了又开）',
    // retireTiles 在 App.tsx 里；用一个独立窗口读取，避免与上面 App 文本的假设耦合
    (() => {
      const appSrcT48 = strip(read('src/App.tsx'))
      const body = bodyAfter(appSrcT48, /const retireTiles\s*=\s*useCallback\(\s*async\s*\([^)]*\)\s*=>\s*\{/)
      return Boolean(body) && /closeTileForNote\(/.test(body ?? '') && !/toggleTileForNote\(/.test(body ?? '')
    })(),
    'toggle 的语义是"没开就打开"：略有竞态时会把刚关掉的磁贴重新打开（关了又开、无限增殖）',
  )
  check(
    't50：几何尺寸必须用 **inner 语义**（与 create_tile 的 inner_size 一致）',
    // 正向：记录尺寸时用 inner_size；反向：全局不得再用 outer_size 记尺寸
    /window\.inner_size\(\)/.test(tilesRs) && !/window\.outer_size\(\)/.test(tilesRs),
    '用 outer_size 会有 16px 系统偏差（Windows 无边框窗口的不可见边框）：吸附判定整体偏移、\n' +
      '     阈值 2px 下永不命中（用户实测「为什么不吸附了」），且尺寸每次重启累积 +16px',
  )
  check(
    't50：吸附判定窗口必须与落盘去抖**分开**（不能都用 3 秒）',
    /const SNAP_QUIET_PERIOD:\s*Duration\s*=\s*Duration::from_millis\(400\);/.test(tilesRs) &&
      /quiet >= SNAP_QUIET_PERIOD/.test(tilesRs),
    '合成一个 3 秒窗口时，用户必须完全静默 3 秒才会吸附（期间窗口一动就重置）⇒ 体感上"不吸附了"',
  )
}

/* ------------------------------ 汇总 ------------------------------ */

const failed = results.filter((result) => !result.ok)
const passCount = results.length - failed.length
console.log('\n纸笺磁贴自检（URL 协议 / 标签 / 导出面）')
console.log(`共 ${results.length} 项 · 通过 ${passCount} · 失败 ${failed.length}\n`)
for (const result of results) {
  console.log(`${result.ok ? '  ✓' : '  ✗'} ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`)
}
if (externalNotes.length > 0) {
  console.log('\n外部依赖体检（别人文件里的缺口，不计入失败；补齐后本段自动消失）')
  for (const note of externalNotes) console.log(`  ⚠️ ${note}`)
}
if (failed.length > 0) {
  console.log(`\n❌ 有 ${failed.length} 项未通过\n`)
  process.exit(1)
}
console.log('\n✅ 全部通过\n')
