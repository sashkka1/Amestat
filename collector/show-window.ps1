# Вернуть окно сборщика на экран.
#
# Зачем: обход водит Opera в окне, уведённом за край экрана (left=-2400, top=-2400), чтобы оно
# не раскрывалось поверх работы владельца. Обратная сторона: окно висит в панели задач, но клик
# по значку его не показывает — оно активируется там же, за краем. Этот скрипт возвращает такое
# окно на экран.
#
# Два режима:
#   .\show-window.ps1 -Show          — сразу вернуть все уведённые окна и выйти.
#   .\show-window.ps1 [-Parent pid]  — сторож: ждёт, пока владелец сам кликнет по значку в панели
#                                       задач, и только тогда возвращает окно. Живёт, пока жив
#                                       процесс -Parent (сборщик), в одном экземпляре на систему.
#
# Как сторож отличает клик владельца от самого запуска Opera: свежее окно (моложе 5 с) не трогает —
# при запуске Windows иногда сама делает его активным; старое окно, ставшее активным при курсоре
# над панелью задач, — это клик по значку. Alt+Tab сторож не ловит: для него есть -Show.
param(
  [switch]$Show,
  [int]$Parent = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AmestatWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# Всё, что левее и выше этой границы, — наше уведённое окно: обычные окна там не живут.
$OFF = -2000
# Куда возвращать: с отступом от угла, размер окна не трогаем.
$SHOW_X = 120
$SHOW_Y = 80
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_SHOWWINDOW = 0x0040
$YOUNG_MS = 5000

function Get-Offscreen {
  $found = New-Object System.Collections.Generic.List[IntPtr]
  $cb = [AmestatWin+EnumProc]{
    param($h, $l)
    if ([AmestatWin]::IsWindowVisible($h)) {
      $r = New-Object AmestatWin+RECT
      if ([AmestatWin]::GetWindowRect($h, [ref]$r) -and $r.Left -le $OFF -and $r.Top -le $OFF) { $found.Add($h) }
    }
    return $true
  }
  [void][AmestatWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

function Show-One([IntPtr]$h) {
  [void][AmestatWin]::SetWindowPos($h, [IntPtr]::Zero, $SHOW_X, $SHOW_Y, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
  [void][AmestatWin]::SetForegroundWindow($h)
}

# Курсор у панели задач: вне рабочей области экрана либо в нижних 240 px над ней — когда окон
# Opera два, клик по значку сначала показывает миниатюры над панелью, и выбор идёт там.
function Test-CursorOnTaskbar {
  $s = [System.Windows.Forms.Screen]::PrimaryScreen
  $p = [System.Windows.Forms.Cursor]::Position
  if (-not $s.WorkingArea.Contains($p)) { return $true }
  return $p.Y -ge ($s.WorkingArea.Bottom - 240)
}

if ($Show) {
  $list = Get-Offscreen
  foreach ($h in $list) { Show-One $h }
  Write-Output ("возвращено окон: " + $list.Count)
  exit 0
}

$mutex = New-Object System.Threading.Mutex($false, "Global\AmestatShowWindow")
if (-not $mutex.WaitOne(0)) { exit 0 }

$firstSeen = @{}
try {
  while ($true) {
    if ($Parent -gt 0) {
      try { [void][System.Diagnostics.Process]::GetProcessById($Parent) } catch { break }
    }
    $now = [Environment]::TickCount64
    $list = Get-Offscreen
    $alive = @{}
    foreach ($h in $list) {
      $k = $h.ToInt64()
      $alive[$k] = $true
      if (-not $firstSeen.ContainsKey($k)) { $firstSeen[$k] = $now }
    }
    foreach ($k in @($firstSeen.Keys)) { if (-not $alive.ContainsKey($k)) { $firstSeen.Remove($k) } }
    $fg = [AmestatWin]::GetForegroundWindow().ToInt64()
    if ($firstSeen.ContainsKey($fg) -and ($now - $firstSeen[$fg]) -ge $YOUNG_MS -and (Test-CursorOnTaskbar)) {
      Show-One ([IntPtr]$fg)
      $firstSeen.Remove($fg)
    }
    Start-Sleep -Milliseconds 250
  }
} finally {
  $mutex.ReleaseMutex()
}
