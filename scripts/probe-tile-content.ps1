<#
纸笺 · 磁贴「内容正确」运行时探针（t33：用户实测「磁贴打开就显示乱码」的闭环证据）
================================================================================
运行：pwsh -NoProfile -File scripts/probe-tile-content.ps1      （或 pnpm probe:tile-content）
      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）

## 为什么必须有（这是 t20 漏掉的那一类）
t19/t20 的运行时验证只证明了「磁贴窗口**能创建/拖动/关闭**」，**没有读窗口里渲染了什么**。
于是「磁贴缺 fs 权限 ⇒ `initDb()` 抛 ACL 错误 ⇒ 磁贴上显示一整屏英文报错」这个缺陷
一路漏到了用户手里（用户原话：「磁贴完全不能用，打开磁贴，磁贴上会显示乱码」）。
⇒ 本探针只做一件事：**读出磁贴窗口内实际渲染的文本，与 md 真相逐字比对**。

## 它怎么做到"确定性复现"
Rust 的 `tiles::init()` 会在启动时按 `tiles.json` 恢复磁贴，所以探针只需：
 1. 选一条**真实笔记**（读它的 md：front-matter 取 id/title，正文取 front-matter 之后的内容）；
 2. 写入 `tiles.json`（备份原有的），启动应用 ⇒ 磁贴窗口自动出现（无需点击）；
 3. 用 UIA（需 `--force-renderer-accessibility`）把磁贴窗口内的 Text 元素全读出来；
 4. 断言：① **不出现**已知错误文案（`读不到这条笔记` / `数据库初始化失败` / `not allowed on window`）；
         ② 渲染文本**包含该笔记的标题**；③ 渲染文本**包含正文的实义片段**（取正文中最长的一段汉字，避开标记符）。

## 数据安全
- vault **只读**（只解析 md；不写不删）；唯一改动的应用文件是 `%APPDATA%\com.zhijian.app\tiles.json`（运行前备份、结束还原）；
- 若已有 zhijian 进程 / 端口 1420 被占用 ⇒ 直接退出，不干扰正在进行的会话。
#>

[CmdletBinding()]
param([int]$StartupTimeoutSec = 240, [int]$WaitAfterWindowSec = 8)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
function Say-OK([string]$m) { Write-Host "  ✅ $m"; $script:notes.Add("OK   $m") }
function Say-Fail([string]$m) { Write-Host "  ❌ $m"; $script:failures.Add($m); $script:notes.Add("FAIL $m") }
function Say-Info([string]$m) { Write-Host "  ℹ️  $m" }
function Assert([bool]$c, [string]$okM, [string]$failM) { if ($c) { Say-OK $okM } else { Say-Fail $failM } }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ZJContentWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr extra);
}
'@
$script:found = [IntPtr]::Zero
function Find-Win([string]$needle) {
  $script:found = [IntPtr]::Zero
  $cb = [ZJContentWin+EnumProc]{
    param([IntPtr]$h, [IntPtr]$e)
    if ([ZJContentWin]::IsWindowVisible($h)) {
      $tb = New-Object System.Text.StringBuilder 512
      [void][ZJContentWin]::GetWindowText($h, $tb, 512)
      $cb2 = New-Object System.Text.StringBuilder 256
      [void][ZJContentWin]::GetClassName($h, $cb2, 256)
      if ($tb.ToString().Contains($needle) -and $cb2.ToString().StartsWith('Tauri')) { $script:found = $h; return $false }
    }
    return $true
  }
  [void][ZJContentWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$vaultRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) '纸笺'
$appDataDir = Join-Path $env:APPDATA 'com.zhijian.app'
$tilesJson = Join-Path $appDataDir 'tiles.json'
$backupJson = "$tilesJson.probe-backup"
$logPath = Join-Path $env:TEMP 'zj-probe-tile-content.log'

Write-Host '纸笺 · 磁贴内容探针（t33 运行时闭环）'
Write-Host "  vault: $vaultRoot"
Write-Host ''

if (Get-Process -Name zhijian -ErrorAction SilentlyContinue) { Write-Host '  ⚠️ 已有 zhijian 在跑 —— 不做任何操作。'; exit 2 }
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  ⚠️ 端口 1420 被占用，请先停掉 dev server。'; exit 2 }
if (-not (Test-Path $vaultRoot)) { Write-Host "  ⚠️ 找不到 vault：$vaultRoot"; exit 2 }

# ---- 1) 选一条真实笔记，读出「md 真相」（标题 + 正文实义片段）
#       选**正文里汉字最多**的那条：标题与正文都可能落在 <input>/contenteditable 里，
#       样本太短（例如空正文）会让断言失去意义。
$vaultNotes = foreach ($f in (Get-ChildItem $vaultRoot -Recurse -File -Filter *.md |
    Where-Object { $_.FullName -notmatch '\\\.paper\\' -and $_.Length -gt 60 })) {
  $raw = Get-Content $f.FullName -Raw
  $fm = [regex]::Match($raw, '(?s)^---\r?\n(.*?)\r?\n---\r?\n\r?\n?')
  if (-not $fm.Success) { continue }
  $bodyText = $raw.Substring($fm.Length)
  $hanRuns = [regex]::Matches($bodyText, '[\u4e00-\u9fff]{2,}') | ForEach-Object { $_.Value }
  $best = $hanRuns | Sort-Object Length -Descending | Select-Object -First 1
  [pscustomobject]@{
    File  = $f
    Id    = ([regex]::Match($fm.Groups[1].Value, '(?m)^id:\s*(.+)$')).Groups[1].Value.Trim()
    Title = ([regex]::Match($fm.Groups[1].Value, '(?m)^title:\s*(.+)$')).Groups[1].Value.Trim().Trim('"').Trim("'").Trim()
    Han   = $best
    HanLen = if ($best) { $best.Length } else { 0 }
  }
}
# 采样优先级：① 标题非空 且 正文汉字 ≥ 4（能同时断言标题 + 正文）→ ② 只要正文汉字 ≥ 4
$sample = $vaultNotes | Where-Object { $_.Id -and $_.Title -and $_.HanLen -ge 4 } |
  Sort-Object HanLen -Descending | Select-Object -First 1
$titleAssertable = [bool]$sample
if (-not $sample) {
  # 退路：本 vault 多数笔记是「未命名」（front-matter `title: ""`）⇒ 标题断言会被跳过，
  #       但正文断言仍能证明"内容读出来了"。这里明确打印这一事实，不假装通过。
  $sample = $vaultNotes | Where-Object { $_.Id -and $_.HanLen -ge 4 } | Sort-Object HanLen -Descending | Select-Object -First 1
}
if (-not $sample) { Write-Host '  ⚠️ 没有可用的 md 采样（需 title + 正文汉字 ≥ 4）'; exit 2 }
$noteId = $sample.Id
# front-matter 里的空标题写作 `title: ""`（带引号）⇒ 必须剥引号后再判空，
# 否则会把字面量 `""`（两个引号字符）当成"非空标题"去断言，必然失败。
$title = ($sample.Title ?? '').Trim().Trim('"').Trim("'").Trim()
$han = $sample.Han
Say-Info "采样：$($sample.File.Name)  noteId=$noteId（候选 $($vaultNotes.Count) 条；标题可断言=$titleAssertable）"
Say-Info "期望标题：$title$(if (-not $title) { ' ←⚠️ 该笔记 front-matter 标题为空，标题断言无意义' })"
Say-Info "期望正文片段（最长汉字串，$($sample.HanLen) 字）：$han"
if (-not $han -or $han.Length -lt 4) { Write-Host '  ⚠️ 采样正文汉字不足 4 字，断言会失去意义'; exit 2 }

# ---- 2) 写入 tiles.json（备份原有的），启动应用
$hadTilesJson = Test-Path $tilesJson
if ($hadTilesJson) { Copy-Item $tilesJson $backupJson -Force }
New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
@{ version = 1; tiles = @{ $noteId = @{ x = 160.0; y = 160.0; width = 340.0; height = 280.0 } } } |
  ConvertTo-Json -Depth 6 | Set-Content $tilesJson -Encoding UTF8 -NoNewline

$proc = $null
try {
  Write-Host '  ⏳ 启动 pnpm tauri:dev（--force-renderer-accessibility，让 UIA 能读 web 内容）…'
  $inner = "cd '$repoRoot'; `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility'; pnpm tauri:dev *>&1 | Tee-Object -FilePath '$logPath'"
  $proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', $inner) -PassThru

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $h = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 900
    $h = Find-Win $noteId
    if ($h -ne [IntPtr]::Zero) { break }
    if ($proc.HasExited) { break }
  }
  if ($h -eq [IntPtr]::Zero) { Say-Fail "没等到磁贴窗口（$StartupTimeoutSec 秒）"; throw 'no tile window' }
  Start-Sleep -Seconds $WaitAfterWindowSec   # 等它把笔记读出来并渲染

  # ---- 3) 读出磁贴窗口内实际渲染的文本
  #   ⚠️ 两个坑（第一版就踩了）：
  #   ① 标题与正文分别落在 <input> 与 contenteditable 里 —— **内容在 Value 里，不在 Name 里**，
  #      只读 `Current.Name` 会只看到「磁贴标题」「笔记正文」这类 label（会误判成"内容没渲染"）；
  #   ② ContentEditable/Document 的正文可能整体挂在 Name 上（因实现而异）⇒ 两边都收。
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $texts = @()
  foreach ($e in $all) {
    $n = $e.Current.Name
    if ($n -and $n.Trim() -ne '') { $texts += $n }
    try {
      if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$null)) {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $v = $vp.Current.Value
        if ($v -and $v.Trim() -ne '') { $texts += "[value] $v" }
      }
    } catch {}
  }
  $joined = ($texts -join "`n")
  Write-Host '  ── 磁贴窗口实际渲染的文本 ──────────────────'
  foreach ($t in $texts) {
    $line = $t -replace "`r?`n", '\n'
    if ($line.Length -gt 160) { $line = $line.Substring(0, 160) + '…' }
    Write-Host "    | $line"
  }
  Write-Host '  ─────────────────────────────────────────'

  # ---- 4) 断言
  $errorMarkers = @('读不到这条笔记', '数据库初始化失败', 'not allowed on window', '这条笔记不在了')
  $hitMarkers = @($errorMarkers | Where-Object { $joined.Contains($_) })
  Assert ($hitMarkers.Count -eq 0) `
    'A. 磁贴里**没有**任何错误文案（无 ACL 报错、无「读不到这条笔记」）' `
    "A. 磁贴里出现错误文案：$($hitMarkers -join '、')（用户看到的「乱码」就是这类文本）"

  # 标题断言：本 vault 里多数笔记的 front-matter `title:` 是空串（Alt+N 新建的未命名笔记），
  # 那种情况下"包含空串"恒真、断言没有意义 ⇒ 明确跳过并说明，而不是假装通过。
  if ($title) {
    Assert ($joined.Contains($title)) `
      "B. 磁贴渲染出了**正确的标题**「$title」" `
      "B. 磁贴渲染文本里找不到标题「$title」（内容不对）"
  } else {
    Say-Info 'B. 采样笔记的 front-matter 标题为空 ⇒ **跳过标题断言**（正文断言 C 已足以证明内容正确）'
  }

  Assert ($han -and $joined.Contains($han)) `
    "C. 磁贴渲染出了**正文**（含片段「$han」）" `
    "C. 磁贴渲染文本里找不到正文片段「$han」（正文没渲染出来）"
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
  if ($hadTilesJson) { Move-Item $backupJson $tilesJson -Force }
  elseif (Test-Path $tilesJson) { Remove-Item $tilesJson -Force }
  if (Test-Path $backupJson) { Remove-Item $backupJson -Force }
  Write-Host ''
  Say-Info "tiles.json 已还原为运行前状态（原本存在=$hadTilesJson）；未触碰 vault 内任何 md"
}

Write-Host ''
Write-Host '════════════════ 汇总 ════════════════'
foreach ($line in $notes) { Write-Host "  $line" }
if ($failures.Count -eq 0) { Write-Host "`n✅ 磁贴内容探针：全部断言通过"; exit 0 }
Write-Host "`n❌ 磁贴内容探针失败 $($failures.Count) 项："
foreach ($f in $failures) { Write-Host "   - $f" }
exit 1
