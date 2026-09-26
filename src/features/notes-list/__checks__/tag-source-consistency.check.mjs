#!/usr/bin/env node
/**
 * 纸笺 · 标签入口「数据源一致性」检查（t34）
 * ============================================================================
 * 运行：node src/features/notes-list/__checks__/tag-source-consistency.check.mjs
 *      退出码 0 = 两个入口的标签库来源一致；非 0 = 有一侧漂移（打印全部差异）
 *
 * ## 为什么需要这条断言
 * 用户第二轮实测：点**卡片**的「标签…」显示「还没有任何标签」，而点**编辑器工具条**的标签按钮
 * 能列出 996/888。根因不是组件 bug，而是**两个入口各接了一套数据**：
 *   - 编辑器入口：`props.allTags` 优先 → 缺省懒加载 `tagsRepo.list()`；
 *   - 列表入口：只吃 `NoteList.tags` prop，而 App 当时没传 ⇒ 面板只剩「本笔记已有标签」。
 * 两个入口由不同成员分别在 t18 / t23 接线，于是出现了「同一个 TagPicker、两种数据来源」。
 *
 * 这条检查把该契约**机器化**：两边必须
 *   ① 从同一个模块取标签库（`@/db/tags` 的 `tagsRepo`）；
 *   ② 优先级一致（props 优先，缺省才懒加载）；
 *   ③ 在**打开面板时**触发懒加载（而不是挂载即查库）；
 *   ④ 把**解析后的**集合传给 `TagPickerDialog`；
 *   ⑤ 新建标签名后立刻并入本地库（新建后马上能再次勾选）。
 * 任一条不满足即退非零 —— 这正是「同一组件在不同入口收到一致 tags」的防回归点。
 *
 * 只读源文件，不执行任何业务代码、不写盘。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..', '..')

const EDITOR_ENTRY = 'src/features/editor/EditorPane.tsx'
const LIST_ENTRY = 'src/features/notes-list/NoteCard.tsx'
const LIST_CATALOG = 'src/features/notes-list/tag-catalog.ts'

/** 两个入口都必须从这里取标签库（唯一来源） */
const CATALOG_SOURCE = '@/db/tags'

const failures = []
const notes = []

function read(rel) {
  try {
    return readFileSync(path.join(projectRoot, rel), 'utf8')
  } catch (error) {
    failures.push(`读不到 ${rel}：${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

/**
 * 去注释后再匹配 —— 否则「注释里提到了 tagsRepo.list()」会让检查假绿
 * （本条检查本身的第一版就踩过：报出的行号落在模块注释里）。
 * 用等长空白替换，保证行号不变。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length))
}

/** 断言某段文本里有某个正则；返回匹配到的行号（1-based） */
function expectMatch(label, text, pattern, rel) {
  const match = pattern.exec(text)
  if (!match) {
    failures.push(`${label}：在 ${rel} 里找不到 ${pattern}`)
    return null
  }
  const line = text.slice(0, match.index).split('\n').length
  notes.push(`  ✅ ${label} —— ${rel}:${line}`)
  return line
}

const editor = stripComments(read(EDITOR_ENTRY))
const card = stripComments(read(LIST_ENTRY))
const catalog = stripComments(read(LIST_CATALOG))

console.log('纸笺 · 标签入口数据源一致性检查（t34）')
console.log(`仓库根：${projectRoot}\n`)

/* ① 同一个来源模块 */
expectMatch('编辑器入口从唯一来源取标签库', editor, new RegExp(`from '${CATALOG_SOURCE}'`), EDITOR_ENTRY)
expectMatch('列表入口从唯一来源取标签库', catalog, new RegExp(`from '${CATALOG_SOURCE}'`), LIST_CATALOG)
// 列表入口只允许经 tag-catalog.ts 间接依赖（NoteCard 不应直接 import db）
if (/from '@\/db\//.test(card)) {
  failures.push(`${LIST_ENTRY} 直接 import 了 @/db/** ；应统一经 ./tag-catalog.ts（唯一出口）`)
}

/* ② props 优先 + 缺省懒加载 */
expectMatch('编辑器：props 优先分支', editor, /if \(allTags\)\s*\{/, EDITOR_ENTRY)
expectMatch('编辑器：缺省懒加载 tagsRepo.list()', editor, /tagsRepo\s*\n?\s*\.list\(\)/, EDITOR_ENTRY)
expectMatch(
  '列表：props 优先（有 props 就不查库）',
  catalog,
  /if \(hasProps \|\| loadedRef\.current\) return/,
  LIST_CATALOG,
)
expectMatch('列表：缺省懒加载 tagsRepo.list()', catalog, /tagsRepo\s*\n?\s*\.list\(\)/, LIST_CATALOG)

/* ③ 打开面板时才懒加载（不在挂载时或无脑每次查） */
expectMatch('编辑器：懒加载由「打开面板」触发', editor, /if \(!tagPickerOpen\) return/, EDITOR_ENTRY)
expectMatch('列表：打开面板时 ensureLoaded()', card, /ensureLoaded\(\)/, LIST_ENTRY)
expectMatch('列表：ensureLoaded 只跑一次', catalog, /loadedRef\.current = true/, LIST_CATALOG)

/* ④ 把解析后的集合传给 TagPickerDialog */
expectMatch('编辑器：TagPickerDialog 收到解析后的标签库', editor, /<TagPickerDialog[\s\S]{0,600}?tags=\{/, EDITOR_ENTRY)
expectMatch('列表：TagPickerDialog 收到解析后的标签库', card, /<TagPickerDialog[\s\S]{0,600}?tags=\{/, LIST_ENTRY)
expectMatch('列表：传入的是解析结果而非原始 prop', card, /tags=\{tagCatalog(\.tags)?\}/, LIST_ENTRY)

/* ⑤ 新建标签名立刻并入本地库 */
expectMatch(
  '编辑器：新建名字并入本地库',
  editor,
  /setTagCatalog\(\(previous\)\s*=>/,
  EDITOR_ENTRY,
)
expectMatch('列表：新建名字并入本地库', card, /rememberNewTag\(/, LIST_ENTRY)
expectMatch(
  '列表：并入逻辑按名称忽略大小写去重',
  catalog,
  /prev\.some\(\(item\) => item\.toLowerCase\(\) === trimmed\.toLowerCase\(\)\)/,
  LIST_CATALOG,
)

console.log(notes.join('\n'))
console.log()
if (failures.length > 0) {
  console.error(`❌ 标签入口数据源一致性检查失败（${failures.length} 项）：`)
  for (const item of failures) console.error(`  - ${item}`)
  console.error('\n两个入口必须「同一来源 + 同一优先级 + 同一触发时机」，否则又会出现')
  console.error('「编辑器看得到标签、列表看不到」这类只在运行时才暴露的缺陷。')
  process.exit(1)
}
console.log('✅ 两个入口的标签库来源、优先级、触发时机、传参、新建回填全部一致。')
process.exit(0)
