# Выключить Radmin VPN перед обходом Amestat (владелец, 2026-09-14).
#
# Зачем: копия Opera сборщика ходит мимо VPN через Bypasser Surfshark, а тот выпускает такой
# трафик через адаптер с наименьшей метрикой. У Radmin VPN метрика 1 и нет интернета — пока он
# включён, копия Opera остаётся без сети и TikTok не собирается вовсе (14.09, обход #125).
# Правило владельца: «в любой момент, когда идёт сборка и включён Radmin, — Radmin выключить».
#
# Запускается НЕ напрямую, а задачей планировщика «Amestat radmin off» (с наивысшими правами):
# резидент без прав администратора, а службу и адаптер останавливает только администратор.
# Резидент зовёт задачу (`radmin.mjs`) и сам ждёт, пока Radmin погаснет.
#
# ⚠️ Окно Radmin закрывается первым: живое окно включает службу и адаптер обратно.
# ⚠️ Адаптер выключается по имени, а не конвейером: конвейерный вариант 13.09 молча не сработал.

$log = Join-Path $PSScriptRoot 'logs\radmin-off.log'
function Say($text) { Add-Content -Path $log -Value ("{0:dd.MM HH:mm:ss} {1}" -f (Get-Date), $text) -Encoding UTF8 }

try {
  $gui = Get-Process -Name RvRvpnGui -ErrorAction SilentlyContinue
  if ($gui) { $gui | Stop-Process -Force -ErrorAction Stop; Say 'окно Radmin закрыто' }
} catch { Say ('окно Radmin не закрылось: ' + $_.Exception.Message) }

try {
  $svc = Get-Service -Name RvControlSvc -ErrorAction Stop
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name RvControlSvc -Force -ErrorAction Stop; Say 'служба Radmin остановлена' }
  if ($svc.StartType -ne 'Manual') { Set-Service -Name RvControlSvc -StartupType Manual -ErrorAction Stop; Say 'служба Radmin: ручной запуск' }
} catch { Say ('служба Radmin не остановилась: ' + $_.Exception.Message) }

try {
  $a = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceAlias -eq 'Radmin VPN' }
  if ($a -and $a.Status -ne 'Disabled') { Disable-NetAdapter -Name $a.Name -IncludeHidden -Confirm:$false -ErrorAction Stop; Say 'адаптер Radmin выключен' }
} catch { Say ('адаптер Radmin не выключился: ' + $_.Exception.Message) }
