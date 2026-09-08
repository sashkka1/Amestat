# Снимает задачу планировщика «Amestat collector». Уже запущенный node не трогает —
# его завершает обычное закрытие процесса (или перезагрузка).
#
# Запускать: powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'Amestat collector'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "задача «$taskName» снята"
} else {
  Write-Host "задачи «$taskName» и не было"
}
