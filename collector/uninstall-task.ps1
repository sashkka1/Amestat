# Снимает задачу планировщика «Amestat collector» и останавливает уже запущенный резидент:
# Stop-ScheduledTask гасит только wscript, node watch.mjs надо завершать отдельно.
#
# Запускать: powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'Amestat collector'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "задача «$taskName» снята"
} else {
  Write-Host "задачи «$taskName» и не было"
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watch.mjs*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -Confirm:$false
    Write-Host "резидент остановлен (pid $($_.ProcessId))"
  }
