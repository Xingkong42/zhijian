/**
 * db 层统一错误工具（FROZEN）。所有 repo 的失败路径都必须经过这里，
 * 保证抛出的 Error.message 是中文可读的、面向用户的。
 */

/**
 * 把底层异常包装成可读 Error 并抛出。
 * 原始异常以 `[cause] …` 形式附在 message 尾部 —— 不使用 ES2022 的 `Error.cause`，
 * 以便 tsconfig 的 lib 保持在 ES2021（WebView2/WKWebView 兼容面更大）。
 */
export function dbError(context: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${context}：${detail} [cause] ${detail}`)
}

/** db 层统一错误类型；`context` 描述操作，`detail` 为底层原因 */
export class DbError extends Error {
  readonly context: string
  readonly detail: string

  constructor(context: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`${context}：${detail}`)
    this.name = 'DbError'
    this.context = context
    this.detail = detail
  }
}

/**
 * 尚未实现占位（骨架期专用）。
 * 运行时显式失败，避免静默返回假数据；实现落地后必须删除对应调用。
 * 返回 `Promise<never>`，可直接作为任意 `Promise<T>` 的返回值使用。
 */
export function notImplemented(fn: string, todo: string): Promise<never> {
  return Promise.reject(new Error(`${fn} 尚未实现（${todo}）`))
}
