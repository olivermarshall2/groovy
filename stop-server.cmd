@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

curl.exe -s -X POST http://127.0.0.1:4318/admin/shutdown >nul 2>&1

set "WAITED=0"
:wait_loop
set "LISTENING=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4318" ^| findstr LISTENING') do (
  set "LISTENING=1"
)

if "!LISTENING!"=="0" (
  echo Stopped server on port 4318.
  exit /b 0
)

set /a WAITED+=1
if !WAITED! geq 10 (
  echo Server is still listening on port 4318.
  exit /b 1
)

timeout /t 1 /nobreak >nul
goto wait_loop
