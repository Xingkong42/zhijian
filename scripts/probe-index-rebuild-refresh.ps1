<#
纸笺 · 「重建索引后侧栏徽标必须刷新」运行时探针（t22 修复 F2/F3 的闭环证据）
================================================================================
运行：pwsh -NoProfile -File scripts/probe-index-rebuild-refresh.ps1   （或 pnpm probe:index-refresh）
      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）

## 复现的是 t21 的 F2（medium）/ F3（low）
F2：外部删除 3 个 md 后 → 设置面板报「文件 7 · 笔记 10」→ 点「重建索引」→ 面板变「笔记 7」，
    但**侧栏徽标仍是 10**（切视图后列表自愈为 7 条、徽标仍 10）。
F3：Toast 文案「移除 0」与索引行数 10→7 对不上（口径是"相对空索引的文件级统计"）。

## 怎么在**不动用户 md** 的前提下造出同样的状态
第一版探针试过「直接往索引插 3 行假记录」，**失败了**（实测）：应用启动时的增量同步
会把「文件已不存在」的索引行**清掉** ⇒ 启动后徽标就已经是 7，重建无从体现。
⇒ 忠实复现必须让**计数真的因重建而变化**：
  1. 先创建 3 个**探针自己的** md（带合法 front-matter，名字带 `zj-probe-` 前缀）；
  2. 启动应用 ⇒ 启动同步把它们索引进去 ⇒ 侧栏徽标 **10**（这是真实状态，不是伪造的）；
  3. **在应用运行期间**从外部删掉这 3 个文件（只删探针自己建的）⇒ 索引仍有 10 行、磁盘只剩 7 个
     —— 这正是 QA 的 F2 起始状态；
  4. 点「重建索引」⇒ 断言：重建消息给出「索引笔记 10 → 7」，且**侧栏徽标刷新为 7**。
  收尾核对 7 个原始 md 的 sha256 全部未变（探针只碰自己创建的文件）。

## 怎么点击（无需人工）
WebView2 默认不给 UIA 暴露内容树，需带 `--force-renderer-accessibility` 启动；
带上之后 UIA 能按名字找到并 Invoke「设置」/「重建索引」按钮，也能读到侧栏徽标 `全部笔记 N`。

## 数据安全
- 探针只创建/删除**自己命名的** `zj-probe-*.md`；用户原有 md 全程只读，并做 sha256 前后核对；
- 唯一改动的应用文件是 SQLite 索引（重建索引本身就会重写它），开跑前仍会**备份** zhijian.db；
- 若已有 zhijian 进程 / 端口 1420 被占用 ⇒ 直接退出，不干扰正在进行的会话。
#>

[CmdletBinding()]
param(
  [int]$StartupTimeoutSec = 240,
  # 造几个"应用运行期间被外部删除"的文件（QA 的场景是 3）
  [int]$ExtraNotes = 3
)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
function Say-OK([string]$m) { Write-Host "  ✅ $m"; $script:notes.Add("OK   $m") }
function Say-Fail([string]$m) { Write-Host "  ❌ $m"; $script:failures.Add($m); $script:notes.Add("FAIL $m") }
function Say-Info([string]$m) { Write-Host "  ℹ️  $m" }
function Assert([bool]$c, [string]$okM, [string]$failM) { if ($c) { Say-OK $okM } else { Say-Fail $failM } }

$repoRoot = Split-Path -Parent $PSScriptRoot
$documents = [Environment]::GetFolderPath('MyDocuments')
$vaultRoot = Join-Path $documents '纸笺'
$appDataDir = Join-Path $env:APPDATA 'com.zhijian.app'
$dbPath = Join-Path $appDataDir 'zhijian.db'
$dbBackup = "$dbPath.probe-backup"
$logPath = Join-Path $env:TEMP 'zj-probe-index-refresh.log'

Write-Host '纸笺 · 重建索引刷新探针（F2/F3 运行时闭环）'
Write-Host "  vault: $vaultRoot"
Write-Host "  db   : $dbPath"
Write-Host ''

if (Get-Process -Name zhijian -ErrorAction SilentlyContinue) { Write-Host '  ⚠️ 已有 zhijian 在跑 —— 不做任何操作。'; exit 2 }
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  ⚠️ 端口 1420 被占用，请先停掉 dev server。'; exit 2 }
if (-not (Test-Path $dbPath)) { Write-Host "  ⚠️ 找不到索引库：$dbPath"; exit 2 }

function Get-VaultMd([string]$root) {
  Get-ChildItem $root -Recurse -File -Filter *.md | Where-Object { $_.FullName -notmatch '\\\.paper\\' }
}
function Get-VaultSnapshot([string]$root) {
  $map = @{}
  foreach ($f in Get-VaultMd $root) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\')
    $map[$rel] = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
  }
  return $map
}

$snapshotBefore = Get-VaultSnapshot $vaultRoot
$fileCount = $snapshotBefore.Count
Say-Info "用户 md 共 $fileCount 个（已记录 sha256，收尾会核对未变）"
$probeFiles = @()

# ---- 1) 先建 ExtraNotes 个探针 md（合法 front-matter），让应用启动时把它们索引进去
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
for ($i = 1; $i -le $ExtraNotes; $i++) {
  $id = [guid]::NewGuid().ToString()
  $path = Join-Path $vaultRoot "zj-probe-临时笔记-$i.md"
  $body = "---`nid: $id`ntitle: zj-probe-临时笔记-$i`ntags: []`npinned: false`ncreated: $now`nupdated: $now`norder: 0`n---`n`n（探针临时文件，运行期间会被外部删除）`n"
  Set-Content -Path $path -Value $body -Encoding UTF8 -NoNewline
  $probeFiles += $path
}
Say-Info "已创建 $ExtraNotes 个探针 md（zj-probe-临时笔记-*.md）"

# ---- 2) 备份索引库（重建会重写它，备份只为兜底）
Copy-Item $dbPath $dbBackup -Force
Say-Info "已备份索引库 → $dbBackup"

$proc = $null
try {
  Write-Host '  ⏳ 启动 pnpm tauri:dev（--force-renderer-accessibility）…'
  $inner = "cd '$repoRoot'; `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility'; pnpm tauri:dev *>&1 | Tee-Object -FilePath '$logPath'"
  $proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', $inner) -PassThru

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $appProc = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 900
    $appProc = Get-Process -Name zhijian -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($appProc) { break }
    if ($proc.HasExited) { break }
  }
  if (-not $appProc) { Say-Fail "应用未在 $StartupTimeoutSec 秒内启动（日志 $logPath）"; throw 'app not started' }
  Start-Sleep -Seconds 7   # 等前端渲染 + 首屏数据（启动同步把探针 md 索引进去了）

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $appProc.Id)
  # ⚠️ 不能"取第一个 Tauri 窗口"：桌面上可能同时存在
  #   · 磁贴窗口（`纸笺磁贴 · <noteId>`）；
  #   · 隐藏的零散窗口（实测见过 `花笺` / `花笺便签` 这类 **0 个 UIA 元素**的隐藏窗）。
  #   取错了就得到空树 ⇒ 「徽标 = ''」「找不到设置按钮」（本探针实测踩到过）。
  # 判据：类名 Tauri + 名字不是磁贴 + **UIA 子树元素数 > 20**（真正渲染出来的主窗口）。
  $win = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond) |
    Where-Object {
      $_.Current.ClassName -eq 'Tauri Window' -and
      $_.Current.Name -notlike '*磁贴*' -and
      ($_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)).Count -gt 20
    } | Select-Object -First 1
  if (-not $win) { Say-Fail ' 找不到已渲染的主窗口（所有 Tauri 窗口的 UIA 子树都为空）'; throw 'no tauri main window' }
  Say-Info "主窗口：name='$($win.Current.Name)'"

  function Get-Elements($rootEl) { $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
  function Find-ByName($rootEl, $name) {
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $rootEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  }
  function Get-AllNotesBadge($rootEl) {
    $hit = Get-Elements $rootEl | Where-Object { $_.Current.Name -match '^全部笔记\s+(\d+)$' } | Select-Object -First 1
    if ($hit) { return $hit.Current.Name }
    return $null
  }
  function Invoke-ByName($rootEl, $name) {
    $el = Find-ByName $rootEl $name
    if (-not $el) { return $false }
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $true
  }

  # ---- 3) 断言 S1：应用启动时把探针 md 索引进去了 ⇒ 徽标 = 原有 + 探针
  # ⚠️ 必须**重试**：探针常与其它成员同时跑，而他们在改源码 ⇒ Vite HMR 会重载页面，
  #    UIA 子树在重载瞬间会变空（实测踩到：窗口在、元素数为 0、徽标为 ''）。
  #    这里每次重试都**重新解析窗口元素**，并要求「徽标」或「设置按钮」其一出现。
  $badgeBefore = $null
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    $win = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond) |
      Where-Object {
        $_.Current.ClassName -eq 'Tauri Window' -and
        $_.Current.Name -notlike '*磁贴*' -and
        ($_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)).Count -gt 20
      } | Select-Object -First 1
    if ($win) {
      $badgeBefore = Get-AllNotesBadge $win
      if ($badgeBefore) { break }
    }
    Start-Sleep -Milliseconds 1000
  }
  if (-not $win) { Say-Fail ' 找不到已渲染的主窗口（所有 Tauri 窗口的 UIA 子树都为空）'; throw 'no tauri main window' }
  Say-Info "主窗口：name='$($win.Current.Name)'（第 $attempt 次尝试拿到徽标）"
  $expectedBefore = $fileCount + $ExtraNotes
  Say-Info "重建前侧栏徽标：'$badgeBefore'（期望 '全部笔记 $expectedBefore'）"
  Assert ($badgeBefore -match "^全部笔记\s+$expectedBefore$") `
    "S1. 启动同步把 $ExtraNotes 个探针 md 索引进索引 ⇒ 徽标 = $badgeBefore（证明计数确实来自索引）" `
    "S1. 徽标 = '$badgeBefore'，期望 '全部笔记 $expectedBefore'（起始状态不符 ⇒ 后续 '计数变化' 的断言会失去意义）"

  # ---- 4) 应用运行期间从外部删掉探针文件（等价于 QA 的「外部删除 3 个 md」；索引仍有这些行）
  foreach ($f in $probeFiles) { if (Test-Path $f) { Remove-Item $f -Force } }
  Say-Info "已在应用运行期间删除 $ExtraNotes 个探针 md（索引仍留着这些行；用户文件未动）"

  # ---- 5) 点「设置」→（必要时滚动）→ 点「重建索引」
  if (-not (Invoke-ByName $win '设置')) { Say-Fail ' 找不到「设置」按钮'; throw 'no settings button' }
  Start-Sleep -Seconds 2

  # 「重建索引」按钮的查找要**重试**：设置面板内容较多且是异步渲染的，
  # 加上与其它成员并行时 Vite HMR 会重载页面 ⇒ 单次查找容易撞在"树正在重建"的瞬间
  # （实测踩到：诊断脚本能查到该按钮，而探针单次查不到）。
  function Wait-And-Invoke([string]$name, [int]$attempts, [int]$delayMs) {
    for ($i = 1; $i -le $attempts; $i++) {
      $w = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond) |
        Where-Object {
          $_.Current.ClassName -eq 'Tauri Window' -and $_.Current.Name -notlike '*磁贴*' -and
          ($_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)).Count -gt 20
        } | Select-Object -First 1
      if ($w -and (Invoke-ByName $w $name)) { $script:lastWin = $w; return $true }
      Start-Sleep -Milliseconds $delayMs
    }
    return $false
  }

  $invoked = Wait-And-Invoke '重建索引' 10 700
  if (-not $invoked) {
    # 退路：可能落在视口之外（WebView2 不为屏外元素建 a11y 节点）⇒ 滚动后重试
    Say-Info '首轮没找到「重建索引」，尝试滚动设置面板后再试…'
    $scrollers = Get-Elements $win | Where-Object {
      try { $_.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$null) } catch { $false }
    }
    foreach ($s in $scrollers) {
      try {
        $sp = $s.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        if ($sp.Current.VerticallyScrollable) { $sp.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, 100); Start-Sleep -Milliseconds 500 }
      } catch {}
    }
    $invoked = Wait-And-Invoke '重建索引' 10 700
  }
  if (-not $invoked) { Say-Fail ' 找不到「重建索引」按钮（已重试 + 滚动，仍不可见）'; throw 'no rebuild button' }
  if ($script:lastWin) { $win = $script:lastWin }

  # ---- 6) 等重建消息（按**新文案的 ASCII 无关特征**匹配：'索引笔记' 只出现在修复后的消息里）
  $rebuildMessage = $null
  $deadline2 = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline2) {
    Start-Sleep -Milliseconds 700
    $hit = Get-Elements $win | Where-Object { $_.Current.Name -match '索引笔记\s+\d+\s*→\s*\d+' } | Select-Object -First 1
    if ($hit) { $rebuildMessage = $hit.Current.Name; break }
  }
  if (-not $rebuildMessage) {
    $fallback = Get-Elements $win | Where-Object { $_.Current.Name -match '索引已重建' } | Select-Object -First 1
    Say-Fail "没等到带「索引笔记 前 → 后」的重建消息（只找到：$(if ($fallback) { $fallback.Current.Name } else { '（什么都没有）' })）"
  } else { Say-Info "重建消息：$rebuildMessage" }

  # ---- 7) 断言 F3：消息口径给出「前 → 后」
  if ($rebuildMessage) {
    Assert ($rebuildMessage -match '索引笔记\s+\d+\s*→\s*\d+') `
      'F3. 重建消息给出了「索引笔记 前 → 后」的口径（不再是会与行数矛盾的「移除 0」）' `
      'F3. 重建消息仍缺少「索引笔记 前 → 后」的口径'
    Assert ($rebuildMessage -match "索引笔记\s+$expectedBefore\s*→\s*$fileCount") `
      "F3b. 前后数字与实际一致（$expectedBefore → $fileCount）" `
      "F3b. 前后数字与预期不符（期望 $expectedBefore → $fileCount）"
  }

  # ---- 8) 断言 F2：侧栏徽标必须跟着刷新到 md 文件数
  Start-Sleep -Seconds 3
  $badgeAfter = Get-AllNotesBadge $win
  Say-Info "重建后侧栏徽标：'$badgeAfter'"
  Assert ($badgeAfter -match "^全部笔记\s+$fileCount$") `
    "F2. 重建后侧栏徽标刷新为 $fileCount（修好了：修复前会停在 $expectedBefore）" `
    "F2. 重建后侧栏徽标 = '$badgeAfter'，期望 '全部笔记 $fileCount'（徽标没刷新 ⇒ F2 未修好）"
}
catch { Say-Fail "探针执行中断：$($_.Exception.Message)" }
finally {
  try { Get-Process -Name zhijian -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
  if ($proc -and -not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Seconds 2
  try {
    $listener = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}

  # 探针 md 若还在（脚本中途失败）也清掉
  foreach ($f in $probeFiles) { if (Test-Path $f) { Remove-Item $f -Force } }

  Write-Host ''
  Write-Host '──────── 收尾核对（数据安全）────────'
  $snapshotAfter = Get-VaultSnapshot $vaultRoot
  $changed = @()
  foreach ($k in $snapshotBefore.Keys) {
    if (-not $snapshotAfter.ContainsKey($k) -or $snapshotAfter[$k] -ne $snapshotBefore[$k]) { $changed += $k }
  }
  $extra = @($snapshotAfter.Keys | Where-Object { -not $snapshotBefore.ContainsKey($_) })
  if ($changed.Count -eq 0 -and $extra.Count -eq 0) {
    Say-OK "用户 md：$($snapshotBefore.Count) 个 sha256 全部未变、无残留文件（探针只动了自己创建的文件）"
  } else {
    Say-Fail "用户 md 发生变化：修改=$($changed -join ',')；新增=$($extra -join ',')"
  }

  # 收尾自证：重建后「索引笔记数 == 磁盘 md 数」（探针自己算，不依赖外部脚本的状态）。
  # 为什么不再调 `verify:md-truth`：那是另一轮（t21）留下的**更宽的**校验套件，
  # 一旦它自己因为别处的改动而过期（例如它按 `view.composing` 定位编辑器 effect，
  # 而 t32 把该 API 换成了 `compositionStarted`），本探针就会被**无关原因**拖红 ——
  # 实测踩到过。探针应当**自包含**：它只断言自己场景内的事实，其余交给各自的门。
  $mdNow = (Get-ChildItem $vaultRoot -Recurse -File -Filter *.md |
    Where-Object { $_.FullName -notmatch '\\\.paper\\' -and $_.Name -notlike 'zj-probe-*' }).Count
  $badgeFinal = Get-AllNotesBadge $win
  if ($badgeFinal -match '^全部笔记\s+(\d+)$' -and [int]$Matches[1] -eq $mdNow) {
    Say-OK "收尾自证：索引笔记数 == 磁盘 md 数（$mdNow）—— 探针造的多余索引行已被重建清掉"
  } elseif ($badgeFinal) {
    Say-Fail "收尾自证失败：索引笔记 $badgeFinal vs 磁盘 md $mdNow（索引未回到 md 真相）"
  } else {
    Say-Info '收尾自证：应用已停止，未取到最终徽标（F2 的断言已在停应用前完成）'
  }
  Write-Host '  ℹ️  更宽的 md 真相校验（front-matter 字段级、迁移无损）请单独跑：pnpm verify:md-truth / verify:data'
  if (Test-Path $dbBackup) { Remove-Item $dbBackup -Force }
}


Write-Host ''
Write-Host '════════════════ 汇总 ════════════════'
foreach ($line in $notes) { Write-Host "  $line" }
if ($failures.Count -eq 0) { Write-Host "`n✅ 重建索引刷新探针：全部断言通过"; exit 0 }
Write-Host "`n❌ 重建索引刷新探针失败 $($failures.Count) 项："
foreach ($f in $failures) { Write-Host "   - $f" }
exit 1
