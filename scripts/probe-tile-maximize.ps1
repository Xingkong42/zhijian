<#
纸笺 · 磁贴「双击不应最大化」运行时探针（t22 修复 F1 的闭环证据）
================================================================================
运行：pwsh -NoProfile -File scripts/probe-tile-maximize.ps1           （或 pnpm probe:tile-maximize）
      退出码 0 = 全部断言通过；1 = 有断言失败；2 = 环境不满足（未开始）

## 为什么必须有这个探针（而不是靠 capability 声明）
t21 的 F1 实证过：`capabilities/tiles.json` 里明明有 `deny-internal-toggle-maximize`、
**静态自检也通过**，但**运行时**双击磁贴头仍然铺满屏，还把最大化矩形
（`-8/-8/1936/1048`）写进了 `tiles.json`，导致该笔记以后每次钉住都以全屏打开。
⇒ 结论：**这条注入脚本调用路径不受 capability deny 约束**，护栏必须落在
   「窗口能力 `maximizable(false)`」+「几何合理性闸门」上，而这两者**只能用运行时证据证明**。

## 它怎么做到"确定性复现"（不需要人工点击工具条）
Rust 侧 `tiles::init()` 启动时按 `tiles.json` **恢复**磁贴，所以：
 1. 探针直接写入一份**被污染的** `tiles.json`（最大化矩形）—— 顺带验证「脏几何不得被照搬」；
 2. 启动 `pnpm tauri:dev` ⇒ 磁贴窗口自动出现（无需点击钉住按钮）；
 3. 断言 A / A2 / B / B2 / C / C2 / D（A、B 是确定性断言；C 是端到端双击尝试）。

## 两个"踩过才知道"的实现细节（都与中文/编码有关）
- **窗口标题不能精确匹配中文**：webview 里的 HTML `<title>纸笺</title>` 会覆盖窗口标题；
  且经管道读日志时中文可能因代码页变成乱码。⇒ 用 `EnumWindows` 按 **noteId（ASCII）子串** + 窗口类名匹配。
- **日志匹配只用 ASCII 锚点**：Rust 侧那两行日志刻意带 `tile-geometry-untrusted` / `tile-attrs`
  锚点，就是为了让探针在乱码管道里也能可靠 grep。

## 数据安全
- 全程**只读** vault（只解析第一个 md 的 front-matter 取一个 noteId），**不写任何 md**；
- 唯一被改动的应用文件是 `%APPDATA%\com.zhijian.app\tiles.json`：运行前备份、结束时**原样还原/删除**；
- 若已有 `zhijian` 进程在跑 ⇒ 直接退出（不杀别人的会话）；端口 1420 被占用也直接退出。
#>

[CmdletBinding()]
param(
  [int]$StartupTimeoutSec = 240,
  [switch]$SkipClick
)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()

function Say-OK([string]$m) { Write-Host "  ✅ $m"; $script:notes.Add("OK   $m") }
function Say-Fail([string]$m) { Write-Host "  ❌ $m"; $script:failures.Add($m); $script:notes.Add("FAIL $m") }
function Say-Info([string]$m) { Write-Host "  ℹ️  $m" }
function Assert([bool]$cond, [string]$okM, [string]$failM) {
  if ($cond) { Say-OK $okM } else { Say-Fail $failM }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ZJProbeWin {
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder buffer, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$script:foundHandle = [IntPtr]::Zero

function Get-Rect([IntPtr]$hWnd) {
  $rect = New-Object ZJProbeWin+RECT
  [void][ZJProbeWin]::GetWindowRect($hWnd, [ref]$rect)
  return $rect
}

function Find-TileWindow([string]$needle) {
  $script:foundHandle = [IntPtr]::Zero
  $callback = [ZJProbeWin+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$extra)
    if ([ZJProbeWin]::IsWindowVisible($hWnd)) {
      $tb = New-Object System.Text.StringBuilder 512
      [void][ZJProbeWin]::GetWindowText($hWnd, $tb, 512)
      $cb = New-Object System.Text.StringBuilder 512
      [void][ZJProbeWin]::GetClassName($hWnd, $cb, 512)
      if ($tb.ToString().Contains($needle) -and $cb.ToString().StartsWith('Tauri')) {
        $script:foundHandle = $hWnd
        return $false
      }
    }
    return $true
  }
  [void][ZJProbeWin]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:foundHandle
}

# --------------------------------------------------------------- 环境与路径
$repoRoot = Split-Path -Parent $PSScriptRoot
$documents = [Environment]::GetFolderPath('MyDocuments')
$vaultRoot = Join-Path $documents '纸笺'
$appDataDir = Join-Path $env:APPDATA 'com.zhijian.app'
$tilesJson = Join-Path $appDataDir 'tiles.json'
$backupJson = "$tilesJson.probe-backup"

Write-Host '纸笺 · 磁贴双击最大化探针（运行时闭环）'
Write-Host "  仓库      : $repoRoot"
Write-Host "  vault     : $vaultRoot"
Write-Host "  tiles.json: $tilesJson"
Write-Host ''

if (Get-Process -Name zhijian -ErrorAction SilentlyContinue) {
  Write-Host '  ⚠️ 已有 zhijian 进程在运行 —— 探针不做任何操作（避免干扰正在进行的会话）。'
  exit 2
}
if (-not (Test-Path $vaultRoot)) { Write-Host "  ⚠️ 找不到 vault：$vaultRoot"; exit 2 }
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host '  ⚠️ 端口 1420 被占用（tauri:dev 需要它起 vite）—— 请先停掉 dev server。'
  exit 2
}

$md = Get-ChildItem $vaultRoot -Recurse -File -Filter *.md |
  Where-Object { $_.FullName -notmatch '\\\.paper\\' } | Select-Object -First 1
if (-not $md) { Write-Host '  ⚠️ vault 里没有 md，无法取 noteId'; exit 2 }
$noteId = (Select-String -Path $md.FullName -Pattern '^id:\s*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value.Trim()
if (-not $noteId) { Write-Host "  ⚠️ $($md.Name) 里没有 front-matter id"; exit 2 }
Write-Host "  样本笔记  : $($md.Name) → noteId=$noteId"
Write-Host ''

$hadTilesJson = Test-Path $tilesJson
if ($hadTilesJson) { Copy-Item $tilesJson $backupJson -Force }

$logPath = Join-Path $env:TEMP 'zj-probe-tile-maximize.log'
if (Test-Path $logPath) { Remove-Item $logPath -Force }
$proc = $null

try {
  # ---- 1) 故意写入"被污染"的几何（Windows 最大化矩形）：验证启动时会自愈
  New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
  $polluted = @{ version = 1; tiles = @{ $noteId = @{ x = -8.0; y = -8.0; width = 1936.0; height = 1048.0 } } } |
    ConvertTo-Json -Depth 6
  Set-Content -Path $tilesJson -Value $polluted -Encoding UTF8 -NoNewline
  Say-Info '已写入污染的 tiles.json（最大化矩形 -8/-8/1936/1048）'

  # ---- 2) 启动应用
  Write-Host '  ⏳ 启动 pnpm tauri:dev（首次编译可能 20–60 秒）…'
  $inner = "cd '$repoRoot'; `$env:TAURI_CLI_NO_UPDATE_CHECK='1'; pnpm tauri:dev *>&1 | Tee-Object -FilePath '$logPath'"
  $proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', $inner) -PassThru

  # ---- 3) 等磁贴窗口出现（按 noteId 子串匹配，编码无关）
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $hWnd = [IntPtr]::Zero
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    $hWnd = Find-TileWindow $noteId
    if ($hWnd -ne [IntPtr]::Zero) { break }
    if ($proc.HasExited) { break }
  }
  if ($hWnd -eq [IntPtr]::Zero) {
    Say-Fail "在 $StartupTimeoutSec 秒内没等到磁贴窗口（标题含 noteId 的 Tauri 窗口）。日志：$logPath"
    throw 'tile window not found'
  }
  Start-Sleep -Seconds 2   # 等前端渲染 + 几何落盘去抖（400ms）

  $log = if (Test-Path $logPath) { Get-Content $logPath -Raw -Encoding UTF8 } else { '' }
  $rect = Get-Rect $hWnd
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $screenW = $screen.Width; $screenH = $screen.Height
  $winW = $rect.Right - $rect.Left; $winH = $rect.Bottom - $rect.Top
  Say-Info "磁贴窗口 rect = L$($rect.Left) T$($rect.Top) ${winW}x${winH}（屏幕 ${screenW}x${screenH}）"

  # ---- A：污染的几何没有被照搬
  $looksFullscreen = ($winW -ge $screenW * 0.9) -and ($winH -ge $screenH * 0.9)
  Assert (-not $looksFullscreen) `
    'A. 污染的（最大化）几何**没有**被照搬：磁贴以正常小窗打开' `
    "A. 磁贴被照搬成全屏（${winW}x${winH}）—— 几何闸门失效"
  Assert ($log -match 'tile-geometry-untrusted') `
    'A2. 日志出现 ASCII 锚点 tile-geometry-untrusted（确认走了「脏几何 → 默认位置 + 回写」）' `
    'A2. 日志里没有 tile-geometry-untrusted，说明脏值没被识别（仍在照搬）'

  # ---- B（核心、确定性）：框架自己的最大化闸门
  $attrLine = ($log -split "`r?`n" | Where-Object { $_ -match 'tile-attrs' } | Select-Object -First 1)
  if (-not $attrLine) {
    Say-Fail 'B. 日志里没有 tile-attrs 自证行（无法判定 maximizable）'
  } else {
    Say-Info $attrLine.Trim()
    Assert ($attrLine -match 'maximizable=Ok\(false\)') `
      'B. maximizable=false ⇒ internal_toggle_maximize 的逻辑（plugin.rs:228 只在 is_maximizable() 为真时最大化）结构上不成立' `
      'B. maximizable 不是 false —— 双击最大化的通路仍然开着'
    Assert ($attrLine -match 'maximized=Ok\(false\)') 'B2. 窗口创建后未被最大化' 'B2. 窗口创建后即处于最大化状态'
  }

  # ---- C（端到端尝试）：真实双击磁贴头部
  if ($SkipClick) {
    Say-Info 'C. 已按 -SkipClick 跳过真实双击'
  } else {
    $headerY = $rect.Top + 14
    $centerX = [int](($rect.Left + $rect.Right) / 2)
    [void][ZJProbeWin]::SetForegroundWindow($hWnd)
    Start-Sleep -Milliseconds 500
    $isForeground = ([ZJProbeWin]::GetForegroundWindow() -eq $hWnd)
    [void][ZJProbeWin]::SetCursorPos($centerX, $headerY)
    Start-Sleep -Milliseconds 200
    for ($i = 0; $i -lt 2; $i++) {
      [ZJProbeWin]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [ZJProbeWin]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    Start-Sleep -Seconds 2
    $zoomed = [ZJProbeWin]::IsZoomed($hWnd)
    $rect2 = Get-Rect $hWnd
    $winW2 = $rect2.Right - $rect2.Left; $winH2 = $rect2.Bottom - $rect2.Top
    Say-Info "双击后：IsZoomed=$zoomed，rect ${winW2}x${winH2}，双击前窗口是否已前台=$isForeground"
    if (-not $isForeground) {
      Say-Info 'C. ⚠️ 无法把磁贴置到前台 ⇒ 双击可能未送达：本次**端到端结论不可判定**（不记通过、也不记失败）'
    } else {
      Assert (-not $zoomed) 'C. 真实双击磁贴头后 IsZoomed=False（没有最大化）' 'C. 双击后 IsZoomed=True —— 仍会最大化（回归！）'
      Assert (-not (($winW2 -ge $screenW * 0.9) -and ($winH2 -ge $screenH * 0.9))) `
        "C2. 双击后仍是小窗（${winW2}x${winH2}）" "C2. 双击后变成全屏（${winW2}x${winH2}）"
    }
  }

  # ---- D：tiles.json 里没有被写成最大化矩形
  Start-Sleep -Seconds 1
  if (Test-Path $tilesJson) {
    $stored = Get-Content $tilesJson -Raw | ConvertFrom-Json
    $entry = $stored.tiles.$noteId
    if ($null -eq $entry) {
      Say-Info 'D. tiles.json 里没有该 noteId（磁贴尚未移动过，属正常）'
    } else {
      $sw = [double]$entry.width; $sh = [double]$entry.height
      Say-Info "D. tiles.json 记录：x=$($entry.x) y=$($entry.y) w=$sw h=$sh"
      Assert (-not (($sw -ge $screenW * 0.9) -and ($sh -ge $screenH * 0.9))) `
        'D. tiles.json 中的几何**不是**最大化矩形' "D. tiles.json 被写入最大化矩形（w=$sw h=$sh）"
    }
  } else {
    Say-Info 'D. tiles.json 不存在（本次运行未落盘）'
  }
}
catch {
  Say-Fail "探针执行中断：$($_.Exception.Message)"
}
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
  Write-Host '──────── 清理 ────────'
  Say-Info "tiles.json 已还原为探针运行前的状态（原本存在=$hadTilesJson）"
  Say-Info '应用进程已停止；未触碰 vault 内任何 md 文件'
}

Write-Host ''
Write-Host '════════════════ 汇总 ════════════════'
foreach ($line in $notes) { Write-Host "  $line" }
if ($failures.Count -eq 0) {
  Write-Host "`n✅ 磁贴双击最大化探针：全部断言通过"
  exit 0
}
Write-Host "`n❌ 磁贴双击最大化探针失败 $($failures.Count) 项："
foreach ($f in $failures) { Write-Host "   - $f" }
exit 1
