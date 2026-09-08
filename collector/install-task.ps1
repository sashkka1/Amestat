# Регистрирует задачу планировщика «Amestat collector»: резидент поднимается при входе
# владельца в Windows и висит без окна (wscript.exe → run-hidden.vbs → node watch.mjs).
#
# Запускать из этой папки: powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Повторный запуск безопасен — задача пересоздаётся.
# Снять: .\uninstall-task.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'Amestat collector'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $dir 'run-hidden.vbs'

if (-not (Test-Path $vbs)) { throw "не найден $vbs" }
if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
  Write-Warning "в $dir нет node_modules — сначала: cd `"$dir`"; npm install"
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Резидент живёт бессрочно, работает и на батарее, поднимается заново, если упал.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Старую версию задачи убираем: Register-ScheduledTask с тем же именем иначе ругается.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "прежняя задача снята"
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Amestat: локальный сборщик статистики (node watch.mjs) — расписание 10:00/13:00/17:00 и кнопка «Обновить» на сайте.' | Out-Null

Write-Host "задача «$taskName» зарегистрирована: вход в Windows → $vbs"
Write-Host "проверить сейчас:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "логи:              $(Join-Path $dir 'logs')"
