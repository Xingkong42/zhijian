/**
 * 快速笔记按键判定（**纯函数**，无 React / 无 DOM）。
 * 归属：编辑器成员（t44）。
 *
 * ## 为什么单独抽出来
 * 这段判定里藏着本项目**已经栽过两次**的那类缺陷：中文输入法组合期按 Enter
 * 是在「确认候选词」，不是「提交」。如果把它写在组件的 `onKeyDown` 里，
 * 就只能靠人工点一遍才能验证 —— 而这正是它会在回归时被悄悄改坏的地方。
 * 抽成纯函数后，`__checks__/run-checks.mjs` 可以拿一张真值表逐条钉死
 * （与 `features/editor/draftSync.ts` 同一手法）。
 *
 * ## 真值表（自检逐条断言）
 * | key        | shift | composing | 结果    | 理由 |
 * |------------|-------|-----------|---------|------|
 * | Enter      | false | false     | `save`  | 主路径：敲完一句就存 |
 * | Enter      | false | **true**  | `none`  | **IME 确认候选词**，绝不能当成保存 |
 * | Enter      | **true** | 任意   | `none`  | Shift+Enter = 换行（交给浏览器默认行为） |
 * | Escape     | 任意  | 任意      | `close` | 放弃这次捕捉 |
 * | 其它       | 任意  | 任意      | `none`  | 不拦 |
 */

export type QuickNoteKeyAction = 'save' | 'close' | 'none'

export interface QuickNoteKeyInput {
  /** `KeyboardEvent.key` */
  key: string
  shiftKey: boolean
  /**
   * 是否处于输入法组合期。**两个来源取或**：
   *  - `KeyboardEvent.isComposing`（原生标记，部分输入法/浏览器下不可靠）
   *  - 组件自己的 `compositionstart` / `compositionend` 标志（更稳）
   * 任一为真即视为组合中 —— 宁可"这次 Enter 没保存"，也不要"选词把笔记存了并关窗"。
   */
  composing: boolean
}

export function quickNoteKeyAction(input: QuickNoteKeyInput): QuickNoteKeyAction {
  if (input.key === 'Escape') return 'close'
  if (input.key !== 'Enter') return 'none'
  // 组合期优先于一切：Enter 此刻属于输入法
  if (input.composing) return 'none'
  // Shift+Enter 是换行（不 preventDefault，交给 textarea 默认行为）
  if (input.shiftKey) return 'none'
  return 'save'
}
