import { createServer } from "vite"
import path from "node:path"
import { fileURLToPath } from "node:url"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../../../..")
const t0 = Date.now()
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
})
try {
  const mod = await server.ssrLoadModule("/src/features/editor/__checks__/probe-jsx.tsx")
  console.log("SSR-OK", mod.pureAdd(1, 2), typeof mod.Tiny, "耗时", Date.now() - t0, "ms")
} catch (error) {
  console.log("SSR-FAIL", error.message)
} finally {
  await server.close()
}
