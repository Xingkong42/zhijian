#!/usr/bin/env node
/**
 * 纸笺 · 设置与系统集成——全套自检入口（单条命令跑完，便于纳入 `pnpm check:*`）
 * ============================================================================
 * 运行：node src/features/settings/__checks__/run-all.mjs     （退出码 0 = 全绿）
 *
 * ## 为什么需要它
 * 本目录有两套检查（设置/偏好/快捷键/数据 与 磁贴静默失效探针）。
 * 分散成两条手敲命令的检查**最终会被跳过**，而"被跳过的检查"与"没有检查"等价 ——
 * 这正是它们要防的那类问题（见下）。因此这里提供**唯一入口**，
 * 供 `package.json` 加一行 `check:settings` 即可纳入常规门禁。
 *
 * ## 这个目录存在的理由（写在入口处，避免被当成"可选脚本"）
 * 本轮抓到的缺陷有一共同特征：**界面完全正常、不报错、不白屏，但底层根本没走到**。
 * 其中最难的是——
 *
 * > **危险的不是"没有权限"，而是"权限齐全但通道走错"**：
 * > 那时降级路径会**成功**，失败被优雅掩盖（`ok:true` 却 `via !== 'rust'`），
 * > 界面看不出任何区别，只有盯住"底层到底走没走到"才能发现。
 *
 * 所以这些检查一律做成**无需 Tauri、静态可复现**（需要启动桌面应用才能跑的检查会被跳过）。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SUITES = [
  {
    name: '设置 / 偏好 / 快捷键 / 数据位置与索引',
    file: 'run-checks.mjs',
    why: '设置面板每项偏好「改了真的生效」+ 契约断言（§4.13 / §4.8.1）',
  },
  {
    name: '磁贴静默失效探针',
    file: 'tile-integration-probe.mjs',
    why: '命令名一致性（前端常量 ↔ generate_handler!）与 tiles.json 权限充分性',
  },
  {
    name: 'D1 单一订阅（防「一次 Alt+N 建两条笔记」复发）',
    file: 'd1-single-subscription.mjs',
    why: '静态：同一事件全仓只允许 1 处 listen；运行时：派发一次事件 → 动作恰好执行 1 次',
  },
  {
    name: 't41 导入笔记 / 更换数据目录接线',
    file: 't41-import-relocate-ui.mjs',
    why: '目录对话框必须 recursive:true（否则子目录静默读不到）+ 二次确认 + 进行中状态 + Toast 文案',
  },
]

const failures = []

for (const suite of SUITES) {
  console.log(`\n======== ${suite.name}（${suite.file}） ========`)
  console.log(`目的：${suite.why}`)
  const result = spawnSync(process.execPath, [path.join(here, suite.file)], {
    stdio: 'inherit',
    cwd: path.resolve(here, '..', '..', '..', '..'),
  })
  if (result.status !== 0) failures.push(suite.name)
}

console.log('\n======== 汇总 ========')
if (failures.length === 0) {
  console.log(`✅ 全部 ${SUITES.length} 套自检通过`)
  process.exit(0)
}
console.log(`❌ 失败 ${failures.length}/${SUITES.length} 套：`)
for (const name of failures) console.log(`   - ${name}`)
process.exit(1)
