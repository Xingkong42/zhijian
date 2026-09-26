#!/usr/bin/env node
/**
 * 纸笺 · 全部门一条命令跑完（`pnpm check:all`）
 * ============================================================================
 * 运行：node src/lib/__checks__/run-all-gates.mjs
 *      退出码 0 = 全部门通过；非 0 = 至少一门失败（失败门的**完整诊断原文**会被打印）
 *
 * ## 为什么需要它
 * 两道真实的教训：
 *  1. **分散成"手敲完整路径"的检查最终会被跳过，而被跳过的检查与没有检查等价。**
 *     ⇒ 每道门都必须有稳定的名字与单一入口。
 *  2. **失败时只打印输出的"最后一行"，等于亲手销毁证据。**
 *     本轮我这样做过一次：某道门报了非零退出码，而我打印的只有一行
 *     `[ELIFECYCLE] Command failed with exit code 2` —— 真正的诊断在我丢弃的输出里，
 *     导致这个一次性失败**至今无法定论**（重跑与干净重建都通过）。
 *     ⇒ 本脚本的规则：**失败时打印该门的完整 stdout+stderr，不做任何截断**。
 *
 * ## 纪律
 *  - 只做"顺序执行 + 如实转述"，**不解释、不重试、不把失败改写成警告**；
 *  - 每道门都同时报告 exit code 与耗时；
 *  - 汇总表刻意把**失败项放最后**，避免被滚屏冲掉。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..', '..')

/** 全部质量门（顺序执行：cargo 与 vite 互不干扰，但串行更容易读日志） */
const GATES = [
  // ⚠️ typecheck 必须带 `--force`：`tsc -b` 是**增量**的，buildinfo 说"已是最新"时会
  //    直接跳过重新检查 —— 于是**新加进来的坏文件可能被"绿"过去**，下一次干净构建才报错。
  //    本轮实测到过这个假绿/假红（同一份代码，一次 exit 2、一次 exit 0）。
  //    验收结论不能依赖缓存状态 ⇒ 统一强制全量重查。
  ['typecheck', ['pnpm', 'exec', 'tsc', '-b', '--force', 'tsconfig.app.json', 'tsconfig.node.json']],
  ['vite:build', ['pnpm', 'vite:build']],
  ['check:rust', ['pnpm', 'check:rust']],
  ['check:db', ['pnpm', 'check:db']],
  ['check:fs', ['pnpm', 'check:fs']],
  ['check:guards', ['pnpm', 'check:guards']],
  ['check:contract', ['pnpm', 'check:contract']],
  ['check:tile', ['pnpm', 'check:tile']],
  ['check:settings', ['pnpm', 'check:settings']],
  ['check:editor', ['pnpm', 'check:editor']],
  ['check:tiles', ['pnpm', 'check:tiles']],
  // t44 用户要的「快速笔记」是**新窗口 + 新动作 id + 新 capability**三件套，
  // 每一件都可能在"看起来能用"的情况下静默出错（窗口能开但整窗无权限、
  // 快捷键登记了但分发不到、输入法组合期 Enter 把笔记存了）⇒ 单独一门守住。
  ['check:quicknote', ['pnpm', 'check:quicknote']],
  // 本轮用户报的两个 bug 的**根因**守门（captain 要求接进来）：
  //  · check:reorder —— 拖拽排序的坐标系换算（概率性回归）
  //  · check:tags    —— 标签两个入口曾各用一套数据源（接线各自为政）
  // 不接进来 = 这两个 bug 只修了当下、没有设防；而"手敲路径的检查最终会被跳过"。
  ['check:reorder', ['pnpm', 'check:reorder']],
  ['check:tags', ['pnpm', 'check:tags']],
  ['cargo test --lib', ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']],
]

const only = process.argv.slice(2)
const gates = only.length > 0 ? GATES.filter(([name]) => only.includes(name)) : GATES
if (gates.length === 0) {
  console.error(`没有匹配的门。可用的门：${GATES.map(([n]) => n).join(' / ')}`)
  process.exit(1)
}

console.log(`纸笺 · 全部质量门（${gates.length} 道，顺序执行）`)
console.log(`仓库根：${projectRoot}\n`)

const summary = []
for (const [name, [cmd, ...args]] of gates) {
  console.log(`===== ${name} =====`)
  const started = Date.now()
  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32', // Windows 下 pnpm/cargo 是 .cmd/.exe shim
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = Date.now() - started
  const code = result.status === null ? -1 : result.status
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const output = (stdout + stderr).trimEnd()

  if (code === 0) {
    // 成功时只给最后一行，保持日志可读（失败时才需要全量原文）
    const tail = output.split('\n').filter((line) => line.trim() !== '').slice(-1)[0] ?? ''
    console.log(`  ✅ exit 0（${(ms / 1000).toFixed(1)}s）${tail ? ` · ${tail.trim()}` : ''}`)
  } else {
    console.log(`  ❌ exit ${code}（${(ms / 1000).toFixed(1)}s）—— 以下为该门**完整**输出，未截断：`)
    console.log('  ┌────────────────────────────────────────────────────────────')
    console.log(output.split('\n').map((line) => `  │ ${line}`).join('\n'))
    console.log('  └────────────────────────────────────────────────────────────')
    if (!output) {
      console.log('  │（该门没有任何输出就失败了 —— 这本身是重要信息，不要忽略）')
    }
  }
  summary.push({ name, code, ms })
  console.log('')
}

const failed = summary.filter((item) => item.code !== 0)

console.log('======================== 汇总 ========================')
for (const item of summary.filter((i) => i.code === 0)) {
  console.log(`  ✅ ${item.name.padEnd(20)} exit 0`)
}
for (const item of failed) {
  console.log(`  ❌ ${item.name.padEnd(20)} exit ${item.code}`)
}
console.log(
  `\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${failed.length} 道：${failed.map((f) => f.name).join('、')}`}` +
    `（共 ${summary.length} 道，总耗时 ${(summary.reduce((a, b) => a + b.ms, 0) / 1000).toFixed(1)}s）`,
)
process.exit(failed.length === 0 ? 0 : 1)
