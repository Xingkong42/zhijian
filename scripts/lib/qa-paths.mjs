/**
 * QA 脚本共享的「路径与真实数据库」安全工具（**只依赖 Node 内置模块**）。
 *
 * ## 为什么必须断言绝对路径（t28/t30 加固，含 data 的实证，勿改回去）
 *
 * 现象：仓库根目录偶发多出一个 **恰好 0 字节**的垃圾文件（本次是 `x`），且没有报错。
 *
 * 机制（已由我复现，见下方实验）：
 *   ```js
 *   const db = new DatabaseSync('x')      // 相对路径
 *   db.prepare('select 1').get()          // ✅ 不报错，连接正常
 *   ```
 *   SQLite 会把相对路径解析到**进程工作目录**并创建文件；新库在第一次写入前
 *   就是 **0 字节**，所以"静默产垃圾文件"与"一切正常"同时成立。
 *   实验结果（临时目录内，CWD = 该临时目录）：
 *   ```
 *   opened relative path OK, select -> 1
 *   Name  Length
 *   x     0
 *   ```
 *
 * 典型成因：`path.join(process.env.SOME_DIR ?? '', 'a', 'b')` —— 环境变量缺失/为空时
 * 首段退化成空串，`path.join` 于是返回**相对路径**，且 SQLite / fs 都不会报错。
 * 开发态 CWD 是仓库根 → 垃圾文件出现在仓库里；打包后 CWD 是安装目录 → 症状更隐蔽。
 *
 * 因此本模块的铁律：
 *   1. **凡要落到磁盘的路径，先过 `assertAbsolutePath`**（宁可抛可读错误，也不在 CWD 里读写）；
 *   2. **环境变量读取必须显式判空并抛可读错误**（`requireEnvDir`），绝不回落相对路径；
 *   3. **真实开发库一律只读打开**（`openRealDatabaseReadOnly`）；WAL 让只读打开受限时，
 *      退化为「复制含 `-wal`/`-shm` 的副本到临时目录后再读」——**副本可写、真实库永不可写**。
 *      已知细节：WAL 下即便是只读连接也要把 `-shm` 以读写方式打开做读者登记，实测
 *      `-shm` 的 mtime 会前进（内容 SHA-256 不变、主库与 `-wal` 完全不变）。
 *      若要求连时间戳都不动，设 `ZHIJIAN_QA_DB_MODE=replica` 走纯副本。
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 是否绝对路径（用 Node 的平台实现，避免手写正则的边界遗漏） */
export function isAbsolutePath(candidate) {
  return typeof candidate === 'string' && candidate.length > 0 && path.isAbsolute(candidate)
}

/**
 * 断言必须使用绝对路径。不满足即抛**可读中文错误**（含收到的原值）。
 * 返回原值，便于链式使用：`const p = assertAbsolutePath(joined, '真实开发库')`。
 */
export function assertAbsolutePath(candidate, context) {
  if (!isAbsolutePath(candidate)) {
    throw new Error(
      `${context}：必须使用绝对路径（收到 ${JSON.stringify(candidate)}）——` +
        '拒绝在进程工作目录下读写文件（相对路径会被 SQLite/fs 静默落到 CWD，产生 0 字节垃圾文件）',
    )
  }
  return candidate
}

/**
 * 读取一个**目录类环境变量**并拼出绝对路径；环境变量缺失/空白时**抛可读错误**（不回落到相对路径）。
 *
 * @param {string} envName  环境变量名（如 `APPDATA`）
 * @param {string} context  人类可读的用途说明（进错误信息）
 * @param {...string} segments 追加的路径片段
 */
export function requireEnvDir(envName, context, ...segments) {
  const raw = process.env[envName]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      `${context}：环境变量 ${envName} 未设置或为空 —— ` +
        '拒绝回落到相对路径（相对路径会被 SQLite/fs 静默写进进程工作目录）。' +
        `请在环境里显式设置 ${envName}（例如 Windows 的 %APPDATA%），或改用不依赖真实数据目录的检查方式。`,
    )
  }
  const base = assertAbsolutePath(raw.trim(), `${context}：环境变量 ${envName}`)
  if (segments.length === 0) return base
  // 拼接后再断言一次（防御性：即使 base 被改成相对路径也会在此失败）
  return assertAbsolutePath(path.join(base, ...segments), `${context}：拼接后的路径`)
}

/**
 * 复制真实库的**一致副本**（含侧车 `-wal` / `-shm`）到独立临时目录。
 * 返回 `{ dir, path, files }`；调用方负责 `removeReplica(dir)`。
 */
export function copySqliteReplica(dbPath) {
  const source = assertAbsolutePath(dbPath, '真实数据库（副本源）')
  if (!existsSync(source)) {
    throw new Error(`真实数据库不存在：${source}（不做推断，请先确认应用是否已启动过一次）`)
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'zhijian-qa-db-'))
  const files = []
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`
    if (!existsSync(from)) continue
    const to = assertAbsolutePath(path.join(dir, path.basename(source) + suffix), '副本目标路径')
    copyFileSync(from, to)
    files.push({ suffix: suffix || '(main)', bytes: statSync(to).size })
  }
  return { dir, path: path.join(dir, path.basename(source)), files }
}

/** 递归删除副本目录（失败只告警，不影响结论） */
export function removeReplica(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn(`[qa] 清理临时副本失败（不影响结论）：${dir} —— ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * **只读**打开真实开发库；WAL 导致只读打开受限时退化为「副本可写」。
 *
 * 依次尝试（每一档都必须能真正读到数据才算成功）：
 *   1. 真实库 + `readOnly: true`   ← 默认首选，绝不可能写入真实库的数据文件
 *   2. 副本   + `readOnly: true`   ← WAL 只读受限时
 *   3. 副本   + 读写               ← 副本是一次性临时文件，可写无风险
 *
 * **零副作用模式**：设 `ZHIJIAN_QA_DB_MODE=replica` 可跳过第 1 档、直接走副本。
 * 为什么需要它：WAL 模式下**任何**读连接（哪怕是 `readOnly: true`）都必须把
 * `-shm` 锁索引文件以读写方式打开并在其中做读者登记，实测表现为
 * `-shm` 的 **mtime 会前进**（实测内容 SHA-256 不变、`-wal`/主库完全不变）。
 * 若某次取证要求「真实库三件套连时间戳都不许动」，就用这个模式。
 *
 * 返回 `{ db, mode, replica, attempts }`；`mode` 会打印出来作为证据。
 */
export function openRealDatabaseReadOnly(dbPath) {
  const source = assertAbsolutePath(dbPath, '真实开发库')
  if (!existsSync(source)) {
    throw new Error(`真实开发库不存在：${source}`)
  }

  const attempts = []
  const forceReplica = String(process.env.ZHIJIAN_QA_DB_MODE ?? '').trim().toLowerCase() === 'replica'
  if (forceReplica) {
    attempts.push('ZHIJIAN_QA_DB_MODE=replica → 刻意跳过直接打开真实库（追求零文件系统副作用）')
  }

  // 1) 真实库只读
  if (!forceReplica) {
    try {
      const db = new DatabaseSync(source, { readOnly: true })
      db.prepare('SELECT 1 AS probe').get() // 真触达磁盘才算成功
      attempts.push('真实库 readOnly ✅')
      return { db, mode: '真实库·只读', replica: null, attempts }
    } catch (error) {
      attempts.push(`真实库 readOnly ❌ ${error instanceof Error ? error.message : error}`)
    }
  }

  // 2/3) 副本（先尝试只读，再退化为副本可写 —— 副本在临时目录，写它无风险）
  const replica = copySqliteReplica(source)
  try {
    const db = new DatabaseSync(replica.path, { readOnly: true })
    db.prepare('SELECT 1 AS probe').get()
    attempts.push('副本 readOnly ✅')
    return { db, mode: '副本·只读', replica, attempts }
  } catch (error) {
    attempts.push(`副本 readOnly ❌ ${error instanceof Error ? error.message : error}`)
    const db = new DatabaseSync(replica.path)
    db.prepare('SELECT 1 AS probe').get()
    attempts.push('副本 读写 ✅（副本为一次性临时文件，真实库未被触碰）')
    return { db, mode: '副本·读写', replica, attempts }
  }
}

/** 关闭只读连接并清理副本 */
export function closeRealDatabase(handle) {
  if (!handle) return
  try {
    handle.db.close()
  } catch (error) {
    console.warn(`[qa] 关闭数据库连接失败（不影响结论）：${error instanceof Error ? error.message : error}`)
  }
  removeReplica(handle.replica?.dir)
}
