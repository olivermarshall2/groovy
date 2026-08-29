@echo off
setlocal
cd /d "%~dp0"
call "%~dp0stop-server.cmd"
timeout /t 1 /nobreak >nul
call "%~dp0start-server.cmd"
