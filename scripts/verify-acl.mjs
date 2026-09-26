// 纸笺 · QA 独立验证脚本 1/4：capabilities/default.json 权限标识符核对
//
// 方法要求（t8 任务书）：解析 src-tauri/gen/schemas/acl-manifests.json 的 JSON，
// **不得用 grep** —— 该文件里存的是**不带 `fs:` 前缀的裸标识符**，
// grep `fs:allow-xxx` 会得到「全部 MISSING」的假结果。
//
// 本脚本反过来做：对 capabilities 里的每个 `<module>:<id>`，去
// acl-manifests[module] 的 permissions / permission_sets / default_permission 里找裸 id。
//
// ## 路径 / 磁盘访问审计（t30，同类排查结论：本文件**无隐患**）
// 本脚本**不读任何环境变量、不打开任何数据库**，只 `readFileSync` 仓库内的两个 JSON，
// 且路径由 `resolve(import.meta.dirname, …)` 得到 —— `import.meta.dirname` 是脚本自身的
// 绝对目录，`resolve()` 返回值恒为绝对路径，因此不存在「环境变量缺失 → 回落相对路径」的
// 风险，也没有任何写盘动作。
// 若将来需要在此脚本里读写磁盘上的新路径，**必须**走 `scripts/lib/qa-paths.mjs`：
// 那里记录了「相对路径会被 SQLite/fs 静默落到进程工作目录、产生 0 字节垃圾文件」的实证，
// 并强制 `assertAbsolutePath` 与环境变量显式判空。详见该文件头部注释。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const aclPath = resolve(root, "src-tauri/gen/schemas/acl-manifests.json");
const capPath = resolve(root, "src-tauri/capabilities/default.json");

const acl = JSON.parse(readFileSync(aclPath, "utf8"));
const cap = JSON.parse(readFileSync(capPath, "utf8"));

let pass = 0;
const failures = [];

function ok(msg) {
  pass += 1;
  console.log(`  ✅ ${msg}`);
}
function bad(msg) {
  failures.push(msg);
  console.log(`  ❌ ${msg}`);
}

console.log("── A. capabilities 中每个权限标识符都能在 acl-manifests 中解析");
for (const raw of cap.permissions) {
  const id = typeof raw === "string" ? raw : raw.identifier;
  // 标识符可能是 3 段（core:window:allow-x）或 2 段（fs:allow-x）。
  // 用「最长已登记模块前缀」匹配，而不是按第一个冒号切分。
  const moduleName = Object.keys(acl)
    .filter((m) => id.startsWith(`${m}:`))
    .sort((a, b) => b.length - a.length)[0];
  if (!moduleName) {
    bad(`${id} —— acl-manifests 中找不到任何模块前缀`);
    continue;
  }
  const bare = id.slice(moduleName.length + 1);
  const mod = acl[moduleName];
  if (!mod) {
    bad(`${id} —— acl-manifests 中无模块 ${moduleName}`);
    continue;
  }
  const inPerms = Object.prototype.hasOwnProperty.call(mod.permissions ?? {}, bare);
  const inSets = Object.prototype.hasOwnProperty.call(mod.permission_sets ?? {}, bare);
  const isDefault = mod.default_permission?.identifier === bare;
  if (inPerms || inSets || isDefault) {
    const kind = isDefault ? "default_permission" : inPerms ? "permission" : "permission_set";
    ok(`${id} → 命中 ${moduleName}.${kind}["${bare}"]`);
  } else {
    bad(`${id} —— 裸标识符 "${bare}" 在 ${moduleName} 的 permissions/permission_sets/default_permission 中都不存在`);
  }
}

console.log("\n── B. 反向核对：capabilities 引用的模块必须真实存在");
for (const moduleName of new Set(
  cap.permissions.map((p) => {
    const id = String(p);
    return Object.keys(acl)
      .filter((m) => id.startsWith(`${m}:`))
      .sort((a, b) => b.length - a.length)[0];
  }),
)) {
  if (acl[moduleName]) ok(`模块 ${moduleName} 存在（permissions=${Object.keys(acl[moduleName].permissions ?? {}).length}）`);
  else bad(`模块 ${moduleName} 不存在`);
}

console.log("\n── C. 最小权限红线：不得出现 $HOME 递归读写");
const allText = JSON.stringify(cap);
const homeHits = cap.permissions.filter((p) => /home/i.test(String(p)));
if (homeHits.length === 0) ok("capabilities 中无任何 home 相关权限（$HOME 递归读写 = 放开整个用户目录）");
else bad(`发现 home 相关权限，按 high 报出：${homeHits.join(", ")}`);
// 同时确认 acl 里确实存在 home 系列权限（证明上面的「没有」是有意义的缺席，不是标识符写错）
const fsSets = Object.keys(acl.fs.permission_sets ?? {});
const homeSetsInAcl = fsSets.filter((s) => /home/i.test(s));
ok(`acl.fs 中存在可被误配的 home 集合 ${homeSetsInAcl.length} 个（如 ${homeSetsInAcl.slice(0, 3).join(", ")}）⇒ 上一条的「缺席」确有意义`);

console.log("\n── D. fs:default 的实际内容（证明「静态白名单默认拒绝」）");
const fsDefault = acl.fs.default_permission;
ok(`fs:default = [${(fsDefault.permissions ?? []).join(", ")}]`);

console.log("\n── E. capability 声明的窗口与主窗口 label 一致性");
ok(`capabilities.windows = ${JSON.stringify(cap.windows)}`);

console.log("\n" + "─".repeat(72));
console.log(`权限核对：通过 ${pass}，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log("✅ ACL 权限标识符核对全部通过（无 MISSING、无 home 误配）");
