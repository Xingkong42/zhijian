/**
 * 验证脚本：Shiki 细粒度（core + JS 引擎 + 按需 langs）产出
 * 双主题（light/dark）CSS 变量形式的 HTML —— 供 CodeBlock.tsx 的样式与
 * shikiHighlighter.ts 的语言清单做依据。
 *
 * 同时逐个验证「JS 正则引擎 + 按需语法」的可用性（Oniguruma 特有语法在 JS 里
 * 可能不支持，必须 forgiving:true 才不会抛错）。
 *
 * 运行：node src/features/editor/__checks__/probe-shiki.mjs
 */

import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/** 与 src/features/editor/shikiHighlighter.ts 的 LANG_FILES 保持一致 */
const LANGS = {
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
}

const SAMPLE = {
  markdown: '# 标题\n\n**加粗** `code`',
  typescript: 'const x: number = 1 // 注释',
  tsx: 'export const A = () => <div className="a">hi</div>',
  javascript: 'function f(a) { return a + 1 }',
  jsx: 'const A = () => <span>{1}</span>',
  json: '{"a": 1, "b": [true, null]}',
  css: ':root { --x: #fff } .a { color: red }',
  html: '<!doctype html><p class="a">hi</p>',
  xml: '<note id="1"><to>a</to></note>',
  shellscript: 'pnpm install --frozen-lockfile # 中文',
  python: 'def f(x: int) -> str:\n    return str(x)',
  rust: 'fn main() { let a: i32 = 1; }',
  sql: "SELECT id, title FROM notes WHERE title LIKE '%a%';",
  yaml: 'a: 1\nb:\n  - x\n  - y',
  toml: '[pkg]\nname = "zhijian"',
  diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
  go: 'func main() { fmt.Println("hi") }',
  java: 'public class A { public static void main(String[] a) {} }',
}

const engine = createJavaScriptRegexEngine({ forgiving: true })
const t0 = Date.now()
const highlighter = await createHighlighterCore({
  themes: [
    (await import('shiki/themes/vitesse-light.mjs')).default,
    (await import('shiki/themes/vitesse-dark.mjs')).default,
  ],
  langs: [],
  engine,
})

let failed = 0
for (const [id, load] of Object.entries(LANGS)) {
  try {
    const mod = await load()
    await highlighter.loadLanguage(mod.default)
    const html = highlighter.codeToHtml(SAMPLE[id], {
      lang: id,
      themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
      defaultColor: false,
    })
    const colored = (html.match(/--shiki-light:/g) ?? []).length
    const inlineColor = /(^|\s)color:#/.test(html)
    console.log(
      `OK   ${id.padEnd(12)} html=${String(html.length).padStart(5)}B  token色=${
        String(colored).padStart(3)
      }  内联color=${inlineColor ? 'YES(不应出现)' : 'no'}`,
    )
  } catch (error) {
    failed++
    console.log(`FAIL ${id.padEnd(12)} ${error instanceof Error ? error.message : String(error)}`)
  }
}

// 未知语言 / 无语言 → 回退 text（无需加载语法）
const fallback = highlighter.codeToHtml('<tag> & "q"', {
  lang: 'text',
  themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
  defaultColor: false,
})
console.log(`OK   text(fallback) html=${fallback.length}B`)
console.log(`--- 加载语言数=${highlighter.getLoadedLanguages().length} 耗时=${Date.now() - t0}ms 失败=${failed}`)
console.log('--- 首个 span 片段 ---')
console.log(
  highlighter
    .codeToHtml('const a = 1', {
      lang: 'typescript',
      themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
      defaultColor: false,
    })
    .slice(0, 320),
)
