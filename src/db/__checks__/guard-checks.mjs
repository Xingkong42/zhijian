#!/usr/bin/env node
/**
 * 护栏自检（t28）—— 证明"防污染护栏"本身有效，而不是装饰品。
 * 运行：node src/db/__checks__/guard-checks.mjs
 *
 * 断言（6 项）：
 *  1. 相对路径写入被 guardFsPort 拦下，且**CWD 里不会产生该文件**（这就是 `x` 事故的机制）
 *  2. 临时根之外的绝对路径同样被拦下
 *  3. 临时根内的正常写入放行（护栏不能误伤正常路径）
 *  4. assertInsideRoot 拦下"绕过 FsPort 的直接 fs 越界调用"
 *  5. configureStorage 注入相对 vaultRoot → 注入点即抛可读错误
 *  6. configureStorage 注入相对 legacyDbPath → 同样拒绝
 *
 * 自清理：第 1/5 项会检查 CWD 里是否出现探针文件；若护栏失效（不该发生）则删除探针并失败。
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

register(new URL('./loader.mjs', import.meta.url).href)

const { nodeFsPort } = await import('./node-fs-port.mjs')
const { makeRunRoot, cleanupRunRoot, guardFsPort, assertInsideRoot } = await import('./harness.mjs')
const db = await import('../index.ts')

const PROBE = 'zj-guard-probe-should-never-appear'
const probeInCwd = path.join(process.cwd(), PROBE)
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    console.log(`  ❌ ${name}\n     ↳ ${error instanceof Error ? error.message : error}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function cleanupProbe() {
  try {
    if (existsSync(probeInCwd)) unlinkSync(probeInCwd)
  } catch {
    /* ignore */
  }
}

console.log('t28 护栏自检（工作目录：' + process.cwd() + '）')
console.log(`仓库根：${repoRoot}`)

const root = await makeRunRoot('guard')
const guarded = guardFsPort(nodeFsPort, { root, label: 'guard-checks' })

try {
  await check('相对路径写入被拦截（CWD 未产生文件）', async () => {
    let message = ''
    try {
      await guarded.port.writeTextFile(PROBE, '')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const created = existsSync(probeInCwd)
    cleanupProbe()
    assert(/自检护栏/.test(message), `应抛护栏错误，实际：${message || '(未抛错)'}`)
    assert(!created, `CWD 里不应出现 ${PROBE}（护栏未生效）`)
    assert(guarded.violations.length === 1, `应记录 1 条违规，实际 ${guarded.violations.length}`)
  })

  await check('临时根之外的绝对路径同样被拦截', async () => {
    const outside = path.join(os.tmpdir(), PROBE)
    let message = ''
    try {
      await guarded.port.writeTextFile(outside, '')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(/自检护栏/.test(message), `应抛护栏错误，实际：${message || '(未抛错)'}`)
    assert(!existsSync(outside), '临时根外的文件不得被创建')
  })

  await check('临时根内的正常写入放行（不误伤）', async () => {
    const inside = path.join(root, 'ok.txt')
    await guarded.port.writeTextFile(inside, 'hello')
    assert(readFileSync(inside, 'utf8') === 'hello', '临时根内写入应成功')
  })

  await check('assertInsideRoot 拦下绕过 FsPort 的越界调用', () => {
    let message = ''
    try {
      assertInsideRoot(root, path.join(os.tmpdir(), 'nope.txt'), 'guard-checks')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(/自检护栏/.test(message), '应抛护栏错误')
    assertInsideRoot(root, path.join(root, 'ok.txt'), 'guard-checks') // 合法路径不抛
  })

  await check('configureStorage 注入相对 vaultRoot → 注入点即抛可读错误', () => {
    let message = ''
    try {
      db.configureStorage({ fs: nodeFsPort, vaultRoot: PROBE, appDataDir: root, legacyDbPath: path.join(root, 'a.db') })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const created = existsSync(probeInCwd)
    cleanupProbe()
    assert(/绝对路径/.test(message), `应抛"必须使用绝对路径"，实际：${message || '(未抛错)'}`)
    assert(!created, '注入失败不应产生任何文件')
  })

  await check('configureStorage 注入相对 legacyDbPath → 同样拒绝', () => {
    let message = ''
    try {
      db.configureStorage({ fs: nodeFsPort, vaultRoot: root, appDataDir: root, legacyDbPath: 'zhijian.db' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(/绝对路径/.test(message), `应抛"必须使用绝对路径"，实际：${message || '(未抛错)'}`)
  })

  await check('陈旧临时根会被自动清理（陈旧的删掉、正在用的保留）', async () => {
    const { pruneStaleRunRoots, makeRunRoot: makeRunRootForJanitor } = await import('./harness.mjs')
    const { mkdir, utimes, stat, rm } = await import('node:fs/promises')
    const staleName = 'zhijian-janitor-stale-probe'
    const stale = path.join(os.tmpdir(), staleName)
    const fresh = await makeRunRootForJanitor('janitor')
    try {
      // 1) 伪造一个"两小时前"的陈旧根 → 必须被扫掉并报告（先单独验 janitor，避免被 makeRunRoot 抢先）
      await mkdir(stale, { recursive: true })
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(stale, old, old)
      const pruned = await pruneStaleRunRoots({ maxAgeMs: 60 * 60 * 1000 })
      assert(pruned.includes(staleName), `应报告被清理的目录：${JSON.stringify(pruned)}`)
      let gone = false
      try {
        await stat(stale)
      } catch {
        gone = true
      }
      assert(gone, '陈旧临时根应已被删除')

      // 2) 刚建的根（正在使用）绝不能被误删
      const prunedAgain = await pruneStaleRunRoots({ maxAgeMs: 60 * 60 * 1000 })
      assert(
        !prunedAgain.includes(path.basename(fresh)),
        `正在使用的临时根被误删：${path.basename(fresh)}`,
      )
      await stat(fresh)
    } finally {
      await rm(stale, { recursive: true, force: true }).catch(() => undefined)
      await rm(fresh, { recursive: true, force: true }).catch(() => undefined)
    }
  })
} finally {
  await cleanupRunRoot(root)
  cleanupProbe()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n护栏自检：总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
console.log(failed.length === 0 ? '✅ 防污染护栏有效' : '❌ 护栏存在问题')
process.exitCode = failed.length === 0 ? 0 : 1
