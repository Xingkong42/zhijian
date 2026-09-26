/**
 * Shiki 高亮器（细粒度加载，避免全量打包）。
 * 归属：编辑器成员（任务 t4）。
 *
 * 打包策略（验收要求「避免 shiki 全量打包导致 bundle 爆炸」）：
 *  - **连 shiki 运行时本身也是动态 import**：`shiki/core`（不含任何内置主题/语法，
 *    也不含 WASM）与 `shiki/engine/javascript`（纯 JS 正则引擎，无需 onig.wasm，
 *    桌面端可离线）都在首次用到代码块时才加载，成为独立 chunk，绝不进主 chunk；
 *  - 2 套主题 + 18 种语法同样各自动态 import，只有被用到的才加载；
 *  - `getLoadedLanguages()` + 已加载集合做语言缓存，另有 240 条 HTML LRU 缓存。
 *
 * 主题策略：一次 `codeToHtml` 同时产出 light/dark 两套颜色，输出为
 * `--shiki-light` / `--shiki-dark` CSS 变量（`defaultColor: false`），
 * 因此切换明暗**不需要重新高亮**，纯 CSS 生效（与 t2 的「主题 = CSS 变量」一致）。
 */

/** shiki 运行时的类型（动态 import，用 typeof import 取类型避免额外静态依赖） */
type ShikiCoreModule = typeof import('shiki/core')
type ShikiEngineModule = typeof import('shiki/engine/javascript')

/** 双主题名（与 theme.css 的浅深语义对齐：浅色纸感 / 深色墨夜） */
export const SHIKI_LIGHT_THEME = 'vitesse-light'
export const SHIKI_DARK_THEME = 'vitesse-dark'

/** 无法识别语言时的兜底（shiki 内置的纯文本语言，无需加载语法） */
export const SHIKI_FALLBACK_LANG = 'text'

type HighlighterOptions = Parameters<ShikiCoreModule['createHighlighterCore']>[0]
type ThemeInput = NonNullable<HighlighterOptions['themes']>[number]
type LangInput = NonNullable<HighlighterOptions['langs']>[number]
type Highlighter = Awaited<ReturnType<ShikiCoreModule['createHighlighterCore']>>

/** 按需加载的语法清单（key 即 shiki 语言名；每一项对应一个独立 chunk） */
export const LANG_FILES = {
  markdown: () => import('shiki/langs/markdown.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
} as const

export type SupportedLang = keyof typeof LANG_FILES

/** ```lang 里常见的别名 → 本项目支持的语法 */
const LANG_ALIASES: Record<string, SupportedLang> = {
  md: 'markdown',
  markdown: 'markdown',
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  console: 'shellscript',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  golang: 'go',
  java: 'java',
}

/** 人类可读的语言标签（代码块角标） */
export const LANG_LABELS: Record<string, string> = {
  markdown: 'Markdown',
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  xml: 'XML',
  shellscript: 'Shell',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  yaml: 'YAML',
  toml: 'TOML',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
}

/**
 * 规范化 fence 语言标记：支持 ```ts、```{.ts}、```ts title="a.ts"、```TS 等写法。
 * 无法识别时返回 null（调用方回退到纯文本）。
 */
export function normalizeLang(lang?: string | null): SupportedLang | null {
  if (!lang) return null
  let token = lang.trim().toLowerCase()
  if (token.startsWith('{')) {
    token = token.replace(/^\{\.?/, '').replace(/\}.*$/, '')
  }
  token = token.split(/[\s:,]+/)[0] ?? ''
  return LANG_ALIASES[token] ?? null
}

/** 语言角标文案（未识别时返回原文，供「未知语言」展示） */
export function langLabel(lang?: string | null): string {
  const normalized = normalizeLang(lang)
  if (normalized) return LANG_LABELS[normalized] ?? normalized
  const raw = lang?.trim()
  return raw && raw.length > 0 ? raw : '纯文本'
}

/* ------------------------------ 单例与缓存 ------------------------------ */

let highlighterPromise: Promise<Highlighter> | null = null
const registeredLangs = new Set<string>()

const HTML_CACHE_LIMIT = 240
const htmlCache = new Map<string, string>()

function cacheKey(lang: string | null, code: string): string {
  return `${lang ?? ''}\u0000${code}`
}

function rememberHtml(key: string, html: string): void {
  if (htmlCache.size >= HTML_CACHE_LIMIT) {
    const oldest = htmlCache.keys().next()
    if (!oldest.done) htmlCache.delete(oldest.value)
  }
  htmlCache.set(key, html)
}

/** 取得（并缓存）高亮器；失败时清空 promise 以便下次重试 */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      // 动态 import：shiki 运行时（core + JS 引擎 + oniguruma-to-es）整体成为独立 chunk
      const [core, engine, light, dark]: [
        ShikiCoreModule,
        ShikiEngineModule,
        { default: unknown },
        { default: unknown },
      ] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/vitesse-light.mjs'),
        import('shiki/themes/vitesse-dark.mjs'),
      ])
      return core.createHighlighterCore({
        themes: [light.default as ThemeInput, dark.default as ThemeInput],
        langs: [],
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
      })
    })()
    highlighterPromise.catch((error: unknown) => {
      // 不静默：高亮器起不来时预览会退化成纯文本，必须让人知道原因（chunk 拉取失败？构建产物缺失？）
      console.warn('[纸笺] Shiki 高亮器初始化失败，代码块将退化为纯文本：', error)
      highlighterPromise = null
    })
  }
  return highlighterPromise
}

/** 预热：把高亮器与两套主题的 chunk 提前拉起来（预览面板挂载时调用） */
export function preloadHighlighter(): Promise<void> {
  return getHighlighter().then(() => undefined)
}

async function ensureLang(highlighter: Highlighter, lang?: string | null): Promise<string> {
  const key = normalizeLang(lang)
  if (!key) return SHIKI_FALLBACK_LANG
  if (registeredLangs.has(key)) return key
  if (highlighter.getLoadedLanguages().includes(key)) {
    registeredLangs.add(key)
    return key
  }
  try {
    const mod = await LANG_FILES[key]()
    await highlighter.loadLanguage(mod.default as LangInput)
    registeredLangs.add(key)
    return key
  } catch (error) {
    // 语法加载失败（chunk 缺失 / 语法本身有问题）：退化为纯文本，绝不让预览白屏。
    // ⚠️ 但不静默 —— 否则「某个语言的 chunk 没打进产物」这种缺陷会一直不可见。
    console.warn(`[纸笺] 语言 "${key}" 高亮语法加载失败，该代码块退化为纯文本：`, error)
    return SHIKI_FALLBACK_LANG
  }
}

export interface HighlightResult {
  /** shiki 生成的 HTML（双主题 CSS 变量形式，可直接 dangerouslySetInnerHTML） */
  html: string
  /** 实际使用的语言名（未识别时为 'text'） */
  lang: string
}

/**
 * 高亮一段代码。任何失败都回退为纯文本高亮（不抛错）。
 */
export async function highlightCode(
  code: string,
  lang?: string | null,
): Promise<HighlightResult> {
  const key = cacheKey(lang ?? null, code)
  const cached = htmlCache.get(key)
  if (cached !== undefined) {
    return { html: cached, lang: normalizeLang(lang) ?? SHIKI_FALLBACK_LANG }
  }

  const highlighter = await getHighlighter()
  const resolved = await ensureLang(highlighter, lang)
  const html = highlighter.codeToHtml(code, {
    lang: resolved,
    themes: { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME },
    // 不写死第一种主题的颜色，改为输出 --shiki-light/--shiki-dark 变量
    defaultColor: false,
  })
  rememberHtml(key, html)
  return { html, lang: resolved }
}

/** 供自检/调试：当前已注册语言与缓存条数 */
export function highlighterStats(): { loaded: string[]; cached: number } {
  return { loaded: [...registeredLangs], cached: htmlCache.size }
}
