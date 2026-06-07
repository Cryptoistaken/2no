@echo off
if not exist "logs" mkdir "logs"
for /f %%i in ('powershell -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"') do set ts=%%i
set logfile=logs\%ts%.log
echo Logging to %logfile%
node index.js 2>&1 | powershell -Command "& { $input | Tee-Object -FilePath '%logfile%' }"
pause
