# Останавливает резидент сборщика до следующего входа в Windows (или до Start-ScheduledTask).
# Stop-ScheduledTask гасит только wscript, а node watch.mjs остаётся жить — поэтому его
# завершаем отдельно. Задача в планировщике при этом остаётся, на следующий вход поднимется.
#
# Запускать: powershell -ExecutionPolicy Bypass -File .\stop-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'Amestat collector'

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$residents = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watch.mjs*' }
foreach ($p in $residents) {
  Stop-Process -Id $p.ProcessId -Force -Confirm:$false
  Write-Host "резидент остановлен (pid $($p.ProcessId))"
}
if (-not $residents) { Write-Host "резидент и так не работал" }
Write-Host "поднять снова: Start-ScheduledTask -TaskName '$taskName'"
