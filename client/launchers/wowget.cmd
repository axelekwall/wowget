@echo off
setlocal
for /f "usebackq tokens=1,2" %%a in ("%~dp0..\current") do (set "APP=%%a" & set "RT=%%b")
"%~dp0..\runtime\%RT%\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0..\app\%APP%\wowget.ps1" %*
