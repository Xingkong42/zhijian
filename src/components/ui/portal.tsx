/**
 * Portal —— 浮层统一出口。
 * 归属：设计系统（任务 t2）。
 * 所有覆盖层（菜单 / 提示 / 对话框 / Toast）都挂到 document.body，
 * 避免被父级 overflow / transform 裁剪；非浏览器环境（无 document）安全返回 null。
 */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
