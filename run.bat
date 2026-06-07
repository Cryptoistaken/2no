@echo off
if not exist "logs" mkdir "logs"
powershell -Command "$ts = Get-Date -Format 'yyyyMMdd-HHmmss'; $logfile = 'logs\' + $ts + '.log'; Write-Host 'Logging to' $logfile; node index.js *>&1 | ForEach-Object { $_ -replace '\[\d{2}/\d{2}/\d{4},\s(\d{2}:\d{2}:\d{2})\]', '$1' } | Tee-Object -FilePath $logfile"
pause
