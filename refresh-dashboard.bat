@echo off
cd /d "%~dp0"
echo ---- %date% %time% ---- >> refresh-dashboard.log
"C:\Program Files\Git\mingw64\bin\git.exe" pull --no-rebase origin main >> refresh-dashboard.log 2>&1
"C:\Program Files\nodejs\node.exe" dashboard.js --no-open >> refresh-dashboard.log 2>&1
