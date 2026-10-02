/**
 * 编辑器命令与 Live Preview 的纯函数级自检（任务 t16 要求 ≥15 项）。
 * 归属：编辑器成员。
 *
 * 特点：**不需要浏览器**。命令是纯函数（EditorState → TransactionSpec），
 * Live Preview 的装饰构建也是纯函数（state + 区间 → DecorationSet），
 * 因此可以直接在 Node 里断言「命令 → 文档变化」与「装饰不变式」。
 * Node 24 自带 TypeScript 类型擦除，所以这里可以直接 import ../xxx.ts。
 *
 * 运行：node src/features/editor/__checks__/run-checks.mjs
 */

import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  CODE_BLOCK_PLACEHOLDER,
  TABLE_PLACEHOLDER,
  TABLE_SKELETON,
  applyMarkdownCommand,
} from '../markdownCommands.ts'
import {
  buildLivePreviewDecorations,
  countDecorationsIn,
  describeDecorations,
  listDecorations,
  parseLineRender,
} from '../livePreview.ts'
// t55 的选区断言需要在顶层读源码（文件里别处是块内动态导入，名字带 2 后缀）
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

/* ------------------------------ 断言框架 ------------------------------ */

const results = []

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
}

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/**
 * 用 Vite 的 SSR 管线载入 .tsx 模块（Node 原生无法 import .tsx）。
 * 好处：断言的是组件真正使用的那份源码与别名解析，而不是复刻一份实现。
 */
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

/** 造一个带 markdown 语言的状态（与编辑器同配置：GFM base） */
function makeState(doc, selection) {
  const state = EditorState.create({
    doc,
    selection: selection ?? { anchor: 0 },
    extensions: [markdown({ base: markdownLanguage })],
  })
  // 让语法树立即可用（无 view 时需要显式驱动一次解析）
  ensureSyntaxTree(state, state.doc.length, 2000)
  return state
}

/** 跑一次命令，返回 { doc, state, selectionText } */
function run(doc, selection, id) {
  const state = makeState(doc, selection)
  const next = applyMarkdownCommand(state, id)
  const main = next.selection.main
  return {
    doc: next.doc.toString(),
    selectionText: next.sliceDoc(main.from, main.to),
    selection: [main.from, main.to],
    state: next,
  }
}

/* ============================ 1. 行内包裹 ============================ */

{
  // 有选区 → 包裹
  const r = run('hello world', { anchor: 0, head: 5 }, 'bold')
  eq('bold：选区包裹', r.doc, '**hello** world')
  eq('bold：包裹后选中原文本', r.selectionText, 'hello')

  // 再次执行 → 取消包裹
  const back = run(r.doc, { anchor: 2, head: 7 }, 'bold')
  eq('bold：再次执行取消包裹', back.doc, 'hello world')

  // 无选区且光标在词内 → 包裹整词
  eq('italic：光标在词内包整词', run('hello', { anchor: 2 }, 'italic').doc, '*hello*')

  // 无选区且不在词内 → 插入占位并选中占位
  const placeholder = run('', { anchor: 0 }, 'inlineCode')
  eq('inlineCode：插入占位', placeholder.doc, '`代码`')
  eq('inlineCode：选中占位文本', placeholder.selectionText, '代码')

  eq('strikethrough：选区包裹', run('x', { anchor: 0, head: 1 }, 'strikethrough').doc, '~~x~~')

  // 光标紧贴已包裹的词 → 取消包裹（用户最常遇到的场景）
  eq('bold：光标贴住已包裹词再按 = 取消', run('**粗**', { anchor: 3 }, 'bold').doc, '粗')

  // 多处选区各自包裹
  const multi = makeState('ab cd', { anchor: 0, head: 2, extend: false })
  check(
    '内联命令不改动未选中的部分（第 1 项前置检查）',
    multi.doc.toString() === 'ab cd',
    multi.doc.toString(),
  )
}

/* ============================ 2. 行级前缀切换 ============================ */

eq('h1：普通行加前缀', run('标题', { anchor: 0 }, 'h1').doc, '# 标题')
eq('h1：再次执行取消前缀', run('# 标题', { anchor: 0 }, 'h1').doc, '标题')
eq('h2：替换已有的 h1 前缀', run('# 标题', { anchor: 0 }, 'h2').doc, '## 标题')
eq(
  'orderedList：多行自动编号',
  run('a\nb\nc', { anchor: 0, head: 5 }, 'orderedList').doc,
  '1. a\n2. b\n3. c',
)
eq(
  'taskList：无序列表整段转为任务列表',
  run('- a\n- b', { anchor: 0, head: 7 }, 'taskList').doc,
  '- [ ] a\n- [ ] b',
)
eq('taskList：再次执行取消任务标记', run('- [ ] a', { anchor: 3 }, 'taskList').doc, 'a')
eq('quote：加引用前缀', run('引用', { anchor: 0 }, 'quote').doc, '> 引用')
eq('quote：再次执行取消引用前缀', run('> 引用', { anchor: 2 }, 'quote').doc, '引用')
eq(
  'bulletList：已有 h2 前缀时会被列表前缀替换',
  run('## 标题', { anchor: 0 }, 'bulletList').doc,
  '- 标题',
)

/* ============================ 3. 块级插入 ============================ */

{
  const table = run('', { anchor: 0 }, 'table')
  eq('table：空行插入骨架', table.doc, TABLE_SKELETON)
  eq('table：选中第一个表头占位', table.selectionText, TABLE_PLACEHOLDER)

  const tableAfter = run('前文', { anchor: 2 }, 'table')
  check(
    'table：非空行后空一行插入',
    tableAfter.doc.startsWith('前文\n\n| 列 1 |') && tableAfter.doc.includes('| --- |'),
    JSON.stringify(tableAfter.doc),
  )

  const fenced = run('const a = 1', { anchor: 0, head: 11 }, 'codeBlock')
  eq('codeBlock：选区包进围栏', fenced.doc, '```\nconst a = 1\n```')

  const skeleton = run('', { anchor: 0 }, 'codeBlock')
  check(
    'codeBlock：空行插入骨架并选中占位',
    skeleton.doc === `\`\`\`\n${CODE_BLOCK_PLACEHOLDER}\n\`\`\`` &&
      skeleton.selectionText === CODE_BLOCK_PLACEHOLDER,
    `doc=${JSON.stringify(skeleton.doc)} selection=${JSON.stringify(skeleton.selectionText)}`,
  )

  eq('horizontalRule：空行直接写 ---', run('', { anchor: 0 }, 'horizontalRule').doc, '---')
  eq('horizontalRule：非空行前空一行', run('前文', { anchor: 2 }, 'horizontalRule').doc, '前文\n\n---')
}

/* ============================ 4. 链接 ============================ */

{
  const withText = run('纸笺', { anchor: 0, head: 2 }, 'link')
  eq('link：选区变成链接文字', withText.doc, '[纸笺](url)')
  eq('link：插入后选中 url', withText.selectionText, 'url')

  const empty = run('', { anchor: 0 }, 'link')
  eq('link：无选区用占位文字', empty.doc, '[链接文字](url)')
  eq('link：无选区也选中 url', empty.selectionText, 'url')
}

/* ======================= 5. 列表续行（Enter 行为） ======================= */

function continueList(doc, cursor) {
  const state = makeState(doc, { anchor: cursor })
  let next = null
  insertNewlineContinueMarkup({ state, dispatch: (tr) => (next = tr.state) })
  return next ? next.doc.toString() : null
}

eq('- 无序列表续行', continueList('- a\n', 3), '- a\n- \n')
eq('1. 有序列表续行并自增序号', continueList('1. a\n', 4), '1. a\n2. \n')
eq('> 引用续行', continueList('> a\n', 3), '> a\n> \n')
eq('- [ ] 任务续行', continueList('- [ ] a\n', 7), '- [ ] a\n- [ ] \n')

/* ========================= 6. Live Preview 不变式 ========================= */

{
  const doc = ['# 标题', '', '正文里有**加粗**与`代码`。', '', '```ts', 'const a = 1', '```'].join(
    '\n',
  )
  const state = makeState(doc, { anchor: 0 }) // 光标在第 1 行
  const set = buildLivePreviewDecorations(state, [{ from: 0, to: state.doc.length }])
  const entries = listDecorations(set, state.doc.length)
  const line1 = state.doc.line(1)
  const line3 = state.doc.line(3)
  const block = state.doc.line(5)

  eq('livePreview：光标行不产生任何装饰', countDecorationsIn(set, line1.from, line1.to), 0)
  check(
    'livePreview：非光标行隐藏标记（有 replace 装饰）',
    entries.some((entry) => entry.replaceLike && entry.from >= line3.from && entry.to <= line3.to),
    JSON.stringify(entries),
  )
  eq(
    'livePreview：代码块整段跳过',
    countDecorationsIn(set, block.from, state.doc.length),
    0,
  )
  eq(
    'livePreview：装饰不改变文档内容',
    state.doc.toString(),
    doc,
  )

  // IME 安全路径：只要 hideMarkers=false，就一条隐藏类装饰都不产生
  const soft = buildLivePreviewDecorations(state, [{ from: 0, to: state.doc.length }], {
    hideMarkers: false,
  })
  const softStats = describeDecorations(soft, state.doc.length)
  eq('livePreview：hideMarkers=false 时 0 条隐藏装饰（IME 组合期路径）', softStats.replaces, 0)
  check(
    'livePreview：hideMarkers=false 仍然应用样式（marks > 0）',
    softStats.marks > 0,
    JSON.stringify(softStats),
  )

  // GFM 表格整段跳过（对照组：表格上方那行加粗必须照常渲染）
  const tableDoc = ['intro', '**加粗**', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
  const tableState = makeState(tableDoc, { anchor: 0 })
  const tableRangeStart = tableState.doc.line(3).from
  const tableSet = buildLivePreviewDecorations(tableState, [
    { from: 0, to: tableState.doc.length },
  ])
  eq(
    'livePreview：GFM 表格整段跳过',
    countDecorationsIn(tableSet, tableRangeStart, tableState.doc.length),
    0,
  )
  const control = tableState.doc.line(2)
  check(
    'livePreview：表格以外的行照常渲染（对照组）',
    countDecorationsIn(tableSet, control.from, control.to) > 0,
    JSON.stringify(listDecorations(tableSet, tableState.doc.length)),
  )
}

/* ======================= 7. 行渲染解析（单元级） ======================= */

{
  const task = parseLineRender('- [x] 完成')
  eq('parseLineRender：任务行 lineClass', task.lineClass, 'zj-lp-task')
  eq('parseLineRender：任务行用 widget 替换标记', task.widgets.length, 1)
  eq('parseLineRender：任务行不残留可见标记', task.hide.length, 0)

  const rule = parseLineRender('---')
  eq('parseLineRender：水平线 lineClass', rule.lineClass, 'zj-lp-hr-line')
  eq('parseLineRender：水平线整行替换', rule.widgets[0].to, 3)

  const heading = parseLineRender('### 三级标题')
  eq('parseLineRender：标题 lineClass', heading.lineClass, 'zj-lp-h3')
  eq('parseLineRender：标题隐藏 # 标记', heading.hide[0].to, 4)

  const ordered = parseLineRender('12. 第十二项')
  eq('parseLineRender：有序列表 lineClass', ordered.lineClass, 'zj-lp-list')
  eq('parseLineRender：有序列表 widget 保留序号', ordered.widgets.length, 1)

  const link = parseLineRender('见 [纸笺](https://a.b) 说明')
  check(
    'parseLineRender：链接只留下文字 + 弱化 url',
    link.hide.length === 3 &&
      link.marks.some((mark) => mark.className === 'zj-lp-link') &&
      link.marks.some((mark) => mark.className === 'zj-lp-url'),
    JSON.stringify(link),
  )

  const snake = parseLineRender('snake_case 不是斜体')
  eq('parseLineRender：snake_case 不当作斜体', snake.marks.length, 0)

  const bold = parseLineRender('**加粗**')
  eq('parseLineRender：加粗隐藏两侧 **', bold.hide.length, 2)
  eq('parseLineRender：加粗套 zj-lp-strong', bold.marks[0].className, 'zj-lp-strong')

  const quote = parseLineRender('> 引用')
  eq('parseLineRender：引用 lineClass', quote.lineClass, 'zj-lp-quote')
  eq('parseLineRender：引用隐藏 > 标记', quote.hide[0].to, 2)
}

/* ==================== 8. TagPicker 纯逻辑（t23，≥6 项） ====================
   TagPicker 住在 components/ui/tag-picker.tsx（.tsx 无法被 Node 直接 import：
   报 ERR_UNKNOWN_FILE_EXTENSION）。这里用 **Vite SSR** 载入真实模块 ——
   与生产同一份源码、同一套别名解析，因此断言的是组件真正使用的那份逻辑。 */

{
  const tagPicker = await loadTsxModule('/src/components/ui/tag-picker.tsx')
  if (!tagPicker) {
    check('TagPicker：模块可加载（Vite SSR）', false, 'ssrLoadModule 失败，见上方异常')
  } else {
    const {
      normalizeTagInput,
      tagColorOf,
      mergeTagCatalog,
      filterTagOptions,
      toggleTagName,
      removeTagName,
      addTagName,
    } = tagPicker

    check('TagPicker：模块可加载（Vite SSR）', typeof addTagName === 'function')

    /* ---- 过滤 ---- */
    const catalog = mergeTagCatalog(
      [
        { name: '写作', color: '#C9A227' },
        { name: '灵感', color: null },
        { name: '工作', color: '#336699' },
      ],
      ['灵感'],
    )
    eq('TagPicker：标签库与已选合并后共 3 项', catalog.length, 3)
    eq('TagPicker：已选项排在前面', catalog[0].name, '灵感')
    eq('TagPicker：已选项 selected=true', catalog[0].selected, true)
    eq('TagPicker：未选项 selected=false', catalog[1].selected, false)
    eq('TagPicker：颜色来自数据', catalog[2].color, '#336699')
    eq('TagPicker：无颜色时为 null（组件用 bg-accent 兜底）', tagColorOf({ name: '灵感', color: null }), null)
    eq('TagPicker：非法颜色拒绝（不是 # 开头）', tagColorOf({ name: 'x', color: 'red' }), null)
    eq('TagPicker：脏值 #zz 拒绝（否则色点会变空心）', tagColorOf({ name: 'x', color: '#zz' }), null)
    eq('TagPicker：位数不合法 #33669 拒绝', tagColorOf({ name: 'x', color: '#33669' }), null)
    eq('TagPicker：3 位短写接受', tagColorOf({ name: 'x', color: '#abc' }), '#abc')
    eq('TagPicker：8 位带 alpha 接受', tagColorOf({ name: 'x', color: '#AABBCCDD' }), '#AABBCCDD')
    eq('TagPicker：首尾空白被裁剪', tagColorOf({ name: 'x', color: '  #336699  ' }), '#336699')

    eq('TagPicker：空查询不过滤', filterTagOptions(catalog, '').length, 3)
    eq('TagPicker：按名称过滤', filterTagOptions(catalog, '写').map((item) => item.name).join(','), '写作')
    eq(
      'TagPicker：子串命中多个标签',
      filterTagOptions(catalog, '作').map((item) => item.name).join(','),
      '写作,工作',
    )
    eq('TagPicker：过滤大小写不敏感', filterTagOptions(catalog, '工作').length, 1)
    eq('TagPicker：过滤无命中返回空', filterTagOptions(catalog, 'zzz').length, 0)
    eq('TagPicker：查询首尾空白被忽略', filterTagOptions(catalog, '  灵感  ').length, 1)

    /* ---- 勾选 / 取消 / 移除 ---- */
    eq('TagPicker：勾选追加到末尾', toggleTagName(['a'], 'b').join(','), 'a,b')
    eq('TagPicker：再次勾选 = 取消', toggleTagName(['a', 'b'], 'b').join(','), 'a')
    eq('TagPicker：大小写不同视为同一个标签（取消）', toggleTagName(['写作'], '写作').join(','), '')
    eq('TagPicker：显式移除', removeTagName(['a', 'b', 'c'], 'b').join(','), 'a,c')
    eq('TagPicker：移除不存在的项保持原样', removeTagName(['a'], 'zz').join(','), 'a')

    /* ---- 新建：去重 / 空输入 ---- */
    const created = addTagName(['a'], '新标签', [{ name: '旧标签' }])
    eq('TagPicker：新建追加并返回 created', created.created, '新标签')
    eq('TagPicker：新建结果数组', created.next.join(','), 'a,新标签')
    eq('TagPicker：名字不在标签库 → isNew=true', created.isNew, true)
    const existing = addTagName(['a'], '旧标签', [{ name: '旧标签' }])
    eq('TagPicker：已存在的标签不算 isNew', existing.isNew, false)
    eq('TagPicker：重复新建被拒绝', addTagName(['a', 'a2'], 'a2').error, 'duplicate')
    eq('TagPicker：重复新建不改动数组', addTagName(['a'], 'A').next.join(','), 'a')
    eq('TagPicker：空输入被拒绝', addTagName(['a'], '   ').error, 'empty')
    eq('TagPicker：空输入不改动数组', addTagName(['a'], '\n\t').next.join(','), 'a')
    eq('TagPicker：新建名折叠内部空白', addTagName([], '  读书   笔记 ').created, '读书 笔记')
    eq('TagPicker：normalizeTagInput 归一化', normalizeTagInput('  a   b  '), 'a b')

    /* ---- 合并：不在库里的历史标签也不能消失 ---- */
    const withUnlisted = mergeTagCatalog([{ name: '写作' }], ['写作', '旧标签'])
    eq('TagPicker：未收录的历史标签也会渲染', withUnlisted.length, 2)
    eq(
      'TagPicker：未收录项标记 unlisted',
      withUnlisted.find((item) => item.name === '旧标签')?.unlisted,
      true,
    )
    eq(
      'TagPicker：库内标签不标 unlisted',
      withUnlisted.find((item) => item.name === '写作')?.unlisted,
      false,
    )
    eq('TagPicker：大小写重复只出现一次', mergeTagCatalog([{ name: '写作' }], ['写作']).length, 1)
  }
}

/* ==================== 9. 静默失败审计（跨我交付的三个目录） ====================
   captain 复核建议：「让失败有声音、有指向」。本轮至少三处缺陷源于 catch 吞掉错误
   （命令名漂移 / 磁贴权限 / 双订阅降级），因此把这条做成断言：
   交付代码里不允许出现「catch 之后什么都不做」的分支，除非列入白名单（且注释写明理由）。
   白名单之外新增静默 catch → 这里立刻变红。 */

{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '../../../..')
  const targets = [
    'src/features/editor/EditorPane.tsx',
    'src/features/editor/CodeMirrorEditor.tsx',
    'src/features/editor/CodeBlock.tsx',
    'src/features/editor/MarkdownPreview.tsx',
    'src/features/editor/useAutoSave.ts',
    'src/features/editor/shikiHighlighter.ts',
    'src/features/editor/livePreview.ts',
    'src/features/tiles/TileApp.tsx',
    'src/features/tiles/tileWindows.ts',
    'src/features/tiles/tileUrl.ts',
    'src/components/ui/tag-picker.tsx',
  ]
  /** 允许保持静默的文件 → 理由必须写在代码注释里 */
  const allowlist = new Map([
    [
      'src/features/editor/EditorPane.tsx',
      'setPointerCapture/hasPointerCapture 在合成指针事件下会抛；拖拽状态机自己兜底',
    ],
    [
      'src/features/tiles/tileUrl.ts',
      'URLSearchParams 解析守卫：纯函数返回 null 即「不是磁贴 URL」',
    ],
  ])
  // 两类「静默」写法：空 catch 块；`.catch(() => undefined)` / `.catch(() => {})`
  const silentPatterns = [
    /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
    /\.catch\(\s*\(\s*\)\s*=>\s*(?:undefined|\{\s*\})\s*\)/g,
  ]

  let silentTotal = 0
  const offenders = []
  for (const relative of targets) {
    let source = null
    try {
      source = fs.readFileSync(path.join(repoRoot, relative), 'utf8')
    } catch {
      continue
    }
    // 先去掉注释再匹配，避免文档里提到的示例误报
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    let hits = 0
    for (const pattern of silentPatterns) hits += (code.match(pattern) ?? []).length
    if (hits === 0) continue
    silentTotal += hits
    if (!allowlist.has(relative)) offenders.push(`${relative}（${hits} 处）`)
  }

  check(
    '静默失败审计：无白名单之外的 catch-吞错分支',
    offenders.length === 0,
    `静默吞错但未获白名单：${offenders.join('、')}`,
  )
  check(
    '静默失败审计：白名单文件都在注释里写明理由',
    [...allowlist.keys()].every((relative) => {
      try {
        const text = fs.readFileSync(path.join(repoRoot, relative), 'utf8')
        return text.includes('合成事件') || text.includes('纯函数')
      } catch {
        return false
      }
    }),
  )
  if (silentTotal > 0) {
    console.log(
      `\n静默 catch 审计：白名单内 ${silentTotal} 处（均有注释说明），白名单外 ${offenders.length} 处`,
    )
  }
}

/* ==================== 10. t32：保存链路不得回写编辑器 / 不得重置选区 ====================
   用户实测「拼音+汉字同入、光标跳回首行，有概率」的残留竞态。三层可执行检查：
     A. 纯函数真值表：同一条乱序回包时序，**旧判据会误判（会回写）**、新判据不会；
     B. 静态守卫：关键条件必须**在源码里存在**（compositionStarted / hasFocus /
        shouldAdoptExternalDraft / locallyEdited / 串行化 inFlight+queue）；
     C. 时序表本身是文档：STALE_ECHO_RACE 必须覆盖「旧回包最后到达」那一步。 */

{
  const { shouldAdoptExternalDraft, legacyExternalRewriteDetected, STALE_ECHO_RACE } = await import(
    '../draftSync.ts'
  )

  /* ---- A. 乱序回包：旧判据误判 vs 新判据不误判 ---- */
  const last = STALE_ECHO_RACE[STALE_ECHO_RACE.length - 1]
  check(
    't32：时序表最后一步是「旧回包最后到达」（note 值比 lastSent 旧）',
    last.noteContent === '基线\nAAA' &&
      last.draft === '基线\nAAABBBCCC' &&
      last.lastSent === '基线\nAAABBB',
    JSON.stringify(last),
  )
  eq(
    't32：旧判据在该时序下误判为外部改写（= t16 残留缺陷，修复前行为）',
    legacyExternalRewriteDetected({
      incoming: last.noteContent,
      draft: last.draft,
      lastSent: last.lastSent,
    }),
    true,
  )
  eq(
    't32：新判据在同一条时序下不采纳（本地编辑过 → 绝不回写）',
    shouldAdoptExternalDraft({
      incoming: last.noteContent,
      draft: last.draft,
      locallyEdited: true,
      busy: true,
    }),
    false,
  )

  /* ---- A2. 新判据真值表 ---- */
  const adopt = (incoming, draft, locallyEdited, busy) =>
    shouldAdoptExternalDraft({ incoming, draft, locallyEdited, busy })
  eq(
    't32：从未本地编辑 + 空闲 → 采纳外部值（保留"没动过的笔记能看到外部改动"）',
    adopt('外', '原', false, false),
    true,
  )
  eq('t32：本地编辑过 → 一律不采纳（输入优先）', adopt('外', '原', true, false), false)
  eq('t32：有在飞保存 → 不采纳（与到达顺序无关）', adopt('外', '原', false, true), false)
  eq('t32：本地编辑过且在飞 → 不采纳', adopt('外', '原', true, true), false)
  eq('t32：值相同 → 不采纳（省掉无意义 setState）', adopt('同', '同', false, false), false)
  eq(
    't32：乱序回包在"本地编辑过"下不可能触发回写（单调事实，与时间无关）',
    adopt('基线\nAAA', '基线\nAAABBBCCC', true, true),
    false,
  )

  /* ---- B. 静态守卫：关键条件必须存在于源码 ---- */
  const fs2 = await import('node:fs')
  const path2 = await import('node:path')
  const url2 = await import('node:url')
  const here2 = path2.dirname(url2.fileURLToPath(import.meta.url))
  const root2 = path2.resolve(here2, '../../../..')
  const read = (relative) => fs2.readFileSync(path2.join(root2, relative), 'utf8')

  const cmSource = read('src/features/editor/CodeMirrorEditor.tsx')
  check(
    't32：CodeMirrorEditor 用 compositionStarted（而非只看 composing）挡组合期回写',
    cmSource.includes('if (view.compositionStarted) return'),
  )
  check(
    't32：CodeMirrorEditor 在「有焦点」时不整篇替换（输入优先）',
    cmSource.includes('if (view.hasFocus)'),
  )

  const paneSource = read('src/features/editor/EditorPane.tsx')
  check(
    't32：EditorPane 改用 shouldAdoptExternalDraft（不再是 note!==draft && note!==lastSent 启发式）',
    paneSource.includes('shouldAdoptExternalDraft(') &&
      !paneSource.includes('note.content !== lastSentRef.current.content'),
  )
  check(
    't32：EditorPane 记录本地编辑（locallyEditedRef）并在换笔记时重置',
    paneSource.includes('locallyEditedRef.current = true') &&
      paneSource.includes('locallyEditedRef.current = false'),
  )

  const autoSaveSource = read('src/features/editor/useAutoSave.ts')
  check(
    't32：useAutoSave 落库串行化（在飞计数 + 只保留最新负载的队列）',
    autoSaveSource.includes('inFlightRef') && autoSaveSource.includes('queueRef'),
  )
  check(
    't32：串行化在 commit 入口生效（在飞时只排队、不并发发起）',
    autoSaveSource.includes('if (inFlightRef.current > 0)'),
  )
}

/* ------------------------------ 汇总 ------------------------------ */

/* ---------------- t55：编辑器文字选区的对比度 ---------------- */

/** 自包含读源码（不依赖文件里别处块的 helper 作用域） */
const hereSel = path.dirname(url.fileURLToPath(import.meta.url))
const rootSel = path.resolve(hereSel, '..', '..', '..', '..')
const readSel = (relative) => fs.readFileSync(path.join(rootSel, relative), 'utf8')

check(
  't55：编辑器文字选区必须用专用的高对比色（不得退回对比度过低的 --zj-selection）',
  (() => {
    const theme = readSel('src/features/editor/editorTheme.ts')
    if (theme.length === 0) return false // 防空跑：读不到就是失败
    const important = theme.split("backgroundColor: 'var(--zj-editor-selection) !important'").length - 1
    return (
      /--zj-editor-selection/.test(theme) &&
      /color-mix\(in srgb, var\(--zj-accent\)/.test(theme) &&
      /**
       * ⚠️ 必须带 !important，且**聚焦与失焦两条都要**（各一处）。
       * CodeMirror 的 baseTheme 自带两条选区色，特异性远高于我们的简写选择器：
       *   · `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground` → #d7d4f0（(0,6,0)）
       *   · `&light .cm-selectionBackground` → #d9d9d9（(0,4,0)）
       * 实测：不带 !important 时选区计算值是 rgb(215,212,240)（即那条 #d7d4f0），
       * 于是"选中了却只是一层几乎看不出"的淡蓝 —— 用户两次反馈的正是这个。
       */
      important === 2 &&
      !/backgroundColor: 'var\(--zj-selection\)'/.test(theme)
    )
  })(),
  '两个原因叠加：① 全局 --zj-selection 在默认主题下是 #f0e3bc、底色 #fdf8ec，对比度仅 1.21（那个 token 还要给' +
    '侧栏选中项、标题栏 hover 用，必须保持淡雅）；② 就算换成专用色，CodeMirror baseTheme 自带的两条选区色' +
    '（#d7d4f0 / #d9d9d9）特异性高达 (0,6,0)/(0,4,0)，不加 !important 会被它们盖掉。' +
    '所以编辑器选区 = --zj-editor-selection（强调色 70% 混合 → #d9bc62）+ !important。' +
    '实测：修复前量到 rgb(215,212,240)（淡蓝，几乎看不出），修复后量到 rgb(217,188,98)（金黄，清晰可辨）。',
)

const failed = results.filter((result) => !result.ok)
const passCount = results.length - failed.length
console.log(`\n纸笺编辑器自检（命令 / Live Preview 纯函数断言）`)
console.log(`共 ${results.length} 项 · 通过 ${passCount} · 失败 ${failed.length}\n`)
for (const result of results) {
  console.log(`${result.ok ? '  ✓' : '  ✗'} ${result.name}${result.ok ? '' : `\n      ${result.detail}`}`)
}
if (failed.length > 0) {
  console.log(`\n❌ 有 ${failed.length} 项未通过\n`)
  process.exit(1)
}
console.log('\n✅ 全部通过\n')
