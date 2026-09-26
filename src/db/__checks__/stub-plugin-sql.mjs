/**
 * 自检替身：用 Node 内置 `node:sqlite`（SQLite 3.53.x，FTS5 + trigram）顶替
 * `@tauri-apps/plugin-sql`，让 src/db/** 的仓储代码能在**没有 Tauri / Rust** 的
 * 环境下跑真实 SQL。
 *
 * 由 src/db/__checks__/loader.mjs 把 `@tauri-apps/plugin-sql` 解析到本文件。
 * 绑定语义与插件一致：`values` 数组**按下标**绑定到 `$1..$n`
 * （tauri-plugin-sql 的 Rust 侧就是 for value in values { query.bind(value) }）。
 */

import { DatabaseSync } from 'node:sqlite'

/** 所有已被 load() 打开的连接（自检需要拿原始句柄做底层断言） */
const opened = []

function toBindings(values) {
  if (!values || values.length === 0) return undefined
  const bindings = {}
  values.forEach((value, index) => {
    // node:sqlite 不接受 boolean，按插件/sqlx 的落库语义折成 0/1
    bindings[`$${index + 1}`] = value === true ? 1 : value === false ? 0 : value
    return undefined
  })
  return bindings
}

export default class Database {
  #handle

  constructor(handle) {
    this.#handle = handle
  }

  static async load() {
    const handle = new DatabaseSync(':memory:')
    // 与 sqlx 的 SqliteConnectOptions 默认值对齐（外键默认打开）
    handle.exec('PRAGMA foreign_keys = ON')
    opened.push(handle)
    return new Database(handle)
  }

  async execute(query, values = []) {
    const statement = this.#handle.prepare(query)
    const bindings = toBindings(values)
    const info = bindings ? statement.run(bindings) : statement.run()
    return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
  }

  async select(query, values = []) {
    const statement = this.#handle.prepare(query)
    const bindings = toBindings(values)
    return bindings ? statement.all(bindings) : statement.all()
  }

  async close() {
    this.#handle.close()
    return true
  }
}

/** 自检用：最近一次 load() 的原始 sqlite 句柄 */
export function __handle() {
  return opened[opened.length - 1]
}
