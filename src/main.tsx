import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TileApp, readTileNoteId } from './features/tiles'
import { QuickNoteApp, readQuickNoteFlag } from './features/quick-note'
import './index.css'
// ⚠️ 必须在此处引入主题 store：模块加载即把 localStorage 中的用户偏好写进 <html>，
// 否则用户已保存的主题/明暗偏好不生效（index.html 只给了「淡黄 light」兜底）。
// 额外显式调用 initTheme()，避免依赖「导入副作用」这一隐式契约。
import { initTheme } from './store/theme'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到挂载节点 #root，index.html 可能被破坏')
}

initTheme()

/**
 * 窗口路由（t20 总装 / t44 增补快速笔记）：**三种窗口共用同一份前端**，靠 URL 参数区分。
 *
 * - `?tile=<noteId>` ⇒ 只渲染 `<TileApp noteId>`（一条笔记一个窗口，label `tile-<noteId>`）；
 * - `?quick=1`       ⇒ 只渲染 `<QuickNoteApp />`（快速笔记捕捉框，label `quick-note`）；
 * - 都没有           ⇒ 正常渲染 `<App />`（主窗口）。
 *
 * 判定顺序：**先磁贴后快速笔记**（磁贴参数带 noteId，是更具体的那种；两者理论上不会同时出现）。
 *
 * 为什么在这里而不是在 App 内部：磁贴窗口**不能**跑主窗口的启动序列
 * （`initDb` → 四个仓储 → `notesStore.init()` → 全局热键订阅）——那会：
 *   1. 让每个磁贴都挂一遍全局快捷键订阅（一次按键触发 N 次动作，正是 D1 的形态）；
 *   2. 在磁贴窗口里渲染出侧栏/笔记列表等主窗口 UI。
 * 快速笔记同理（而且它更严格：用户明确要"不要整个程序界面"）。
 * 因此路由必须发生在 `<App />` **之前**，这也是两个读取函数被做成纯函数的原因。
 * 解析规则见 `features/tiles/tileUrl.ts` 与 `features/quick-note/quickNoteUrl.ts`。
 */
const tileNoteId = readTileNoteId(location.search)
const quickNote = readQuickNoteFlag(location.search)

/**
 * 顶层错误边界。
 *
 * 为什么必须有：React 在渲染期抛错且上层没有错误边界时，会**卸载整棵组件树**，
 * 用户看到的就是「整个界面变空白、只能关闭重启」——既没有线索也不好排查。
 * 有了边界后能给出可读提示，且失败范围被限制在子树内。
 *
 * 真实案例（已修）：EditorPane 曾把一个 useEffect 放在 `if (!note) return` **之后**，
 * 于是「选中笔记 → 点空白文件夹 / 空标签 / 回收站」时 Hook 数量由多变少，
 * React 抛 "Rendered fewer hooks than expected" 并卸载整树，界面全白。
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 堆栈只进控制台，不给用户看（保持界面克制）
    console.error('[纸笺] 界面渲染出错：', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center text-text">
        <h1 className="text-lg font-medium">界面出了点问题</h1>
        <p className="max-w-md text-sm text-muted">
          某个组件渲染失败，你的笔记数据不受影响。重新加载即可继续使用。
        </p>
        <pre className="max-h-40 max-w-lg overflow-auto rounded-zj border border-border bg-surface p-2 text-left text-2xs text-muted">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          className="rounded-zj border border-border bg-surface px-3 py-2 text-sm text-text hover:bg-hover"
        >
          重新加载
        </button>
      </div>
    )
  }
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      {/* 窗口路由的结果（见上方说明）：
          `?tile=<noteId>` ⇒ 磁贴视图；`?quick=1` ⇒ 快速笔记捕捉框；否则主窗口 */}
      {tileNoteId ? <TileApp noteId={tileNoteId} /> : quickNote ? <QuickNoteApp /> : <App />}
    </AppErrorBoundary>
  </StrictMode>,
)
